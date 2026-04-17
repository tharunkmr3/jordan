// ============================================================================
// Extract plain text from an uploaded file.
//
// Branches by MIME/extension:
//   - PDF  → pdf-parse
//   - DOCX → mammoth (raw text extraction, no formatting)
//   - anything else (txt, md, csv, json, logs, …) → file.text()
//
// The returned string is sanitized to remove bytes Postgres can't store in a
// TEXT/JSONB column: specifically NUL bytes (\u0000) which otherwise surface
// as "unsupported Unicode escape sequence" when supabase-js serializes the
// row over the wire. Other non-printable control chars are stripped too —
// they never help retrieval and often trip up embedding models.
// ============================================================================

import mammoth from 'mammoth'

export interface ExtractResult {
  text: string
  /** True when the extractor actually produced content (not just whitespace). */
  hasContent: boolean
}

export async function extractTextFromFile(file: File): Promise<ExtractResult> {
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()

  let raw: string
  if (type.includes('pdf') || name.endsWith('.pdf')) {
    raw = await extractPdf(file)
  } else if (
    type.includes('wordprocessingml') ||
    type.includes('msword') ||
    name.endsWith('.docx') ||
    name.endsWith('.doc')
  ) {
    raw = await extractDocx(file)
  } else if (
    type.includes('spreadsheetml') ||
    type.includes('ms-excel') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.xlsm')
  ) {
    raw = await extractXlsx(file)
  } else if (
    type.includes('presentationml') ||
    type.includes('ms-powerpoint') ||
    name.endsWith('.pptx') ||
    name.endsWith('.ppt')
  ) {
    raw = await extractPptx(file)
  } else {
    // Plain-text formats: txt, md, markdown, csv, json, log, etc.
    raw = await file.text()
  }

  const cleaned = sanitizeText(raw)
  return {
    text: cleaned,
    hasContent: cleaned.trim().length > 0,
  }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function extractPdf(file: File): Promise<string> {
  // pdf-parse v2 exposes a PDFParse class (not a default-export function
  // like v1). Usage: `new PDFParse({ data: Uint8Array }).getText()`.
  // Dynamic import keeps pdfjs-dist (its dependency) out of the route's
  // bundle until this code path actually runs. next.config.ts lists
  // both packages in `serverExternalPackages` so their lazy-loaded
  // worker file is resolvable at runtime.
  const { PDFParse } = await import('pdf-parse')

  const arrayBuf = await file.arrayBuffer()
  // PDFParse accepts a Uint8Array in `data`. Constructing from the
  // ArrayBuffer gives a zero-copy view (no extra allocation).
  const parser = new PDFParse({ data: new Uint8Array(arrayBuf) })
  try {
    const result = await parser.getText()
    return typeof result?.text === 'string' ? result.text : ''
  } finally {
    // Release the worker / document resources. Best-effort — don't let a
    // cleanup error mask the real parse result.
    parser.destroy?.().catch(() => { /* ignore */ })
  }
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

async function extractDocx(file: File): Promise<string> {
  const arrayBuf = await file.arrayBuffer()
  // mammoth.extractRawText gives plain text with no formatting — exactly
  // what we want for embedding. The viewer's Preview tab does high-
  // fidelity rendering via LibreOffice → PDF; here we only care about
  // the text for RAG indexing.
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(arrayBuf) })
  return value ?? ''
}

// ---------------------------------------------------------------------------
// XLSX / XLS  → SheetJS
// ---------------------------------------------------------------------------

async function extractXlsx(file: File): Promise<string> {
  const arrayBuf = await file.arrayBuffer()
  // SheetJS is loaded dynamically (it's ~300KB) so we only pay the cost
  // on an actual spreadsheet upload. `serverExternalPackages` in
  // next.config.ts keeps its runtime loader intact.
  const XLSX = await import('xlsx')
  const wb = XLSX.read(Buffer.from(arrayBuf), { type: 'buffer' })

  // Structured row extraction: each data row becomes a self-describing
  // line that pairs every cell with its column header and prefixes the
  // sheet name. This dramatically improves RAG retrieval quality on
  // tabular data — the column label ("Sq. Ft") and the value ("2,005")
  // now live in the SAME embedding chunk, so semantic search can match
  // "apartment square footage" against the row containing both.
  //
  // Format per row:
  //   Row | Sheet: "Tellapur Apartment" | Date: 31/3/2023 | Item: Sq. Ft | Cost: 2,005.00
  //
  // Header detection: the first non-empty row of each sheet is treated
  // as the column headers. If a header cell is blank, we fall back to
  // the column letter (A, B, C…) so every cell still gets a label.
  const lines: string[] = []
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
      raw: false,  // strings formatted as displayed (dates, numbers respect cell format)
    })
    if (rows.length === 0) continue

    // First non-empty row = headers. If the sheet has no discernible
    // header row (all data rows look identical), fall back to A/B/C.
    const headerRow = rows.find((r) => r.some((c) => String(c ?? '').trim())) ?? []
    const headers = headerRow.map((h, i) =>
      String(h ?? '').trim() || columnLetter(i)
    )

    const headerIdx = rows.indexOf(headerRow)
    const dataRows = rows.slice(headerIdx + 1)

    lines.push(`=== Sheet: "${sheetName}" ===`)
    // Emit a columns reference for the model to anchor on, then each row.
    lines.push(`Columns: ${headers.join(' | ')}`)

    for (const row of dataRows) {
      const cells = row
        .map((cell, i) => {
          const value = String(cell ?? '').trim()
          if (!value) return null
          const header = headers[i] ?? columnLetter(i)
          return `${header}: ${value}`
        })
        .filter(Boolean)
      if (cells.length === 0) continue
      lines.push(`Row | Sheet: "${sheetName}" | ${cells.join(' | ')}`)
    }
    lines.push('')  // blank line between sheets
  }
  return lines.join('\n')
}

/** 0 → "A", 1 → "B", …, 26 → "AA". Used for header fallbacks. */
function columnLetter(i: number): string {
  let n = i
  let s = ''
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  }
  return s
}

// ---------------------------------------------------------------------------
// PPTX / PPT  → officeparser (XML scan across slides)
// ---------------------------------------------------------------------------

async function extractPptx(file: File): Promise<string> {
  // We already install `officeparser` for its PPTX text extraction —
  // it's small (~15KB) and pure-JS (no native deps). For the Preview
  // tab we convert to PDF via LibreOffice for visual fidelity; here
  // we just need the text for embeddings.
  const arrayBuf = await file.arrayBuffer()
  const officeparser = await import('officeparser')
  const parse = (officeparser as unknown as {
    parseOfficeAsync?: (data: Buffer) => Promise<string>
    default?: { parseOfficeAsync?: (data: Buffer) => Promise<string> }
  }).parseOfficeAsync
    ?? (officeparser as unknown as { default?: { parseOfficeAsync?: (data: Buffer) => Promise<string> } }).default?.parseOfficeAsync

  if (typeof parse !== 'function') {
    throw new Error('officeparser.parseOfficeAsync not available')
  }
  return (await parse(Buffer.from(arrayBuf))) ?? ''
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

/**
 * Strip characters Postgres / supabase-js will choke on:
 *   - NUL bytes (\u0000) — Postgres TEXT columns reject these and JSON
 *     serialization surfaces them as "\u0000" which Postgres also rejects
 *     ("unsupported Unicode escape sequence").
 *   - Other C0 control characters except TAB, LF, CR — they're noise.
 *   - The DEL (0x7F) character — rare but shows up in some PDF extractions.
 *
 * Also collapses long runs of whitespace to keep char_count realistic for
 * downstream chunking / display.
 */
export function sanitizeText(input: string): string {
  if (!input) return ''
  // Remove NULs and C0 controls (except \t \n \r) + DEL.
  // eslint-disable-next-line no-control-regex
  const stripped = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  // Normalize Windows line endings so char_count doesn't inflate.
  const normalized = stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // Collapse runs of blank lines to at most two newlines — preserves
  // paragraph breaks without wasting tokens on PDFs that have 10+ blank
  // lines between sections.
  return normalized.replace(/\n{3,}/g, '\n\n').trim()
}
