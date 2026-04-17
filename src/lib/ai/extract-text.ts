// ============================================================================
// Extract plain text from an uploaded file.
//
// Two-tier extraction strategy:
//
//   1) Unstructured.io API (preferred, when UNSTRUCTURED_API_KEY is set) —
//      layout-aware extraction for every supported file type with a
//      single consistent pipeline. Produces structured elements (Title,
//      NarrativeText, Table, ListItem) that we flatten to retrieval-
//      friendly Markdown. Big upgrade for tables and scanned PDFs.
//
//   2) Local extractors (fallback, always available) — pdf-parse for
//      PDF, mammoth for DOCX, SheetJS for XLSX, officeparser for PPTX,
//      plus shallow parsers for CSV / HTML / RTF / JSON / EML that we
//      add below. Zero external dependencies, ~80% of Unstructured's
//      quality on simple docs.
//
// The file type dispatch here is the same either way — Unstructured
// just intercepts before the local extractor on the first branch.
//
// The returned string is sanitized to remove bytes Postgres can't store
// in a TEXT/JSONB column: specifically NUL bytes (\u0000) which surface
// as "unsupported Unicode escape sequence" when supabase-js serializes
// the row. Other non-printable control chars are stripped too — they
// never help retrieval and often trip up embedding models.
// ============================================================================

import mammoth from 'mammoth'
import { extractViaUnstructured, unstructuredEnabled } from './extract-unstructured'

export interface ExtractResult {
  text: string
  /** True when the extractor actually produced content (not just whitespace). */
  hasContent: boolean
  /** Which extractor ran — useful for debugging / analytics. */
  source?: 'unstructured' | 'pdf-parse' | 'mammoth' | 'sheetjs' | 'officeparser' | 'csv' | 'html' | 'rtf' | 'json' | 'plain'
}

export async function extractTextFromFile(file: File): Promise<ExtractResult> {
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()

  // Preferred path: Unstructured.io, when configured. Covers every file
  // type in one API and dramatically improves extraction quality on
  // complex PDFs, scanned docs, and anything with tables. Returns null
  // on soft-disable / error so we fall through cleanly to the local path.
  if (unstructuredEnabled() && shouldRouteToUnstructured(name, type)) {
    const viaUnstructured = await extractViaUnstructured(file)
    if (viaUnstructured && viaUnstructured.trim().length > 0) {
      const cleaned = sanitizeText(viaUnstructured)
      return { text: cleaned, hasContent: cleaned.trim().length > 0, source: 'unstructured' }
    }
    // fall through to local extractor on empty / failed response
  }

  let raw: string
  let source: ExtractResult['source'] = 'plain'
  if (type.includes('pdf') || name.endsWith('.pdf')) {
    raw = await extractPdf(file)
    source = 'pdf-parse'
  } else if (
    type.includes('wordprocessingml') ||
    type.includes('msword') ||
    name.endsWith('.docx') ||
    name.endsWith('.doc')
  ) {
    raw = await extractDocx(file)
    source = 'mammoth'
  } else if (
    type.includes('spreadsheetml') ||
    type.includes('ms-excel') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.xlsm')
  ) {
    raw = await extractXlsx(file)
    source = 'sheetjs'
  } else if (
    type.includes('presentationml') ||
    type.includes('ms-powerpoint') ||
    name.endsWith('.pptx') ||
    name.endsWith('.ppt')
  ) {
    raw = await extractPptx(file)
    source = 'officeparser'
  } else if (name.endsWith('.csv') || name.endsWith('.tsv') || type === 'text/csv') {
    raw = await extractCsv(file, name.endsWith('.tsv') ? '\t' : undefined)
    source = 'csv'
  } else if (name.endsWith('.html') || name.endsWith('.htm') || type.includes('html')) {
    raw = await extractHtml(file)
    source = 'html'
  } else if (name.endsWith('.rtf') || type.includes('rtf')) {
    raw = await extractRtf(file)
    source = 'rtf'
  } else if (name.endsWith('.json') || type === 'application/json') {
    raw = await extractJson(file)
    source = 'json'
  } else {
    // Plain-text formats: txt, md, markdown, log, etc.
    raw = await file.text()
    source = 'plain'
  }

  const cleaned = sanitizeText(raw)
  return {
    text: cleaned,
    hasContent: cleaned.trim().length > 0,
    source,
  }
}

/**
 * Decide whether a file should go to Unstructured.
 *
 * Plain text formats (txt, md, json, csv) are faster and more faithful
 * through our local parsers — Unstructured would treat them as prose
 * and strip structure we want to keep. Route only formats where
 * Unstructured's layout analysis actually earns its round-trip:
 * PDF / Office / HTML / images / email.
 */
function shouldRouteToUnstructured(name: string, type: string): boolean {
  if (type.includes('pdf') || name.endsWith('.pdf')) return true
  if (type.includes('wordprocessingml') || type.includes('msword')) return true
  if (name.endsWith('.docx') || name.endsWith('.doc') || name.endsWith('.odt')) return true
  if (type.includes('spreadsheetml') || type.includes('ms-excel')) return true
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm') || name.endsWith('.ods')) return true
  if (type.includes('presentationml') || type.includes('ms-powerpoint')) return true
  if (name.endsWith('.pptx') || name.endsWith('.ppt') || name.endsWith('.odp')) return true
  if (name.endsWith('.html') || name.endsWith('.htm') || type.includes('html')) return true
  if (name.endsWith('.rtf') || type.includes('rtf')) return true
  if (name.endsWith('.epub')) return true
  if (name.endsWith('.eml') || name.endsWith('.msg')) return true
  // Images → OCR via Unstructured (hi_res strategy runs Tesseract).
  if (type.startsWith('image/')) return true
  if (/\.(png|jpg|jpeg|tiff|tif|bmp)$/i.test(name)) return true
  return false
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
// CSV / TSV  — row-oriented, self-describing lines for RAG
//
// Same philosophy as XLSX extraction above: a chunk that says "Row |
// Name: Tharun | Role: Senior Product Designer | Joined: 2024" is
// retrieval-friendly for a query like "when did Tharun join", while
// the raw CSV line "Tharun,Senior Product Designer,2024" is not —
// embedding models can't associate the cell value with its column
// header unless they appear in the same chunk.
//
// Parser is deliberately simple: splits on the delimiter, handles
// quoted fields (including embedded delimiters and doubled quotes).
// Good enough for 95% of CSVs; malformed files fall back to literal
// content.
// ---------------------------------------------------------------------------

async function extractCsv(file: File, delimiter?: string): Promise<string> {
  const text = await file.text()
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return ''

  // Auto-detect delimiter on the header line if not supplied. Tab >
  // semicolon > comma (most common) — picks whichever produces the
  // most fields.
  const delim = delimiter ?? pickDelimiter(lines[0])

  const rows = lines.map((line) => parseCsvLine(line, delim))
  const headerRow = rows[0]
  const headers = headerRow.map((h, i) => h.trim() || columnLetter(i))

  const out: string[] = []
  out.push(`Columns: ${headers.join(' | ')}`)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (row.every((c) => !c.trim())) continue  // skip blank rows
    const cells = row
      .map((cell, idx) => {
        const val = cell.trim()
        if (!val) return null
        const h = headers[idx] ?? columnLetter(idx)
        return `${h}: ${val}`
      })
      .filter(Boolean)
    if (cells.length === 0) continue
    out.push(`Row | ${cells.join(' | ')}`)
  }
  return out.join('\n')
}

function pickDelimiter(headerLine: string): string {
  const candidates = ['\t', ';', ',', '|']
  let best = ','
  let bestCount = 0
  for (const d of candidates) {
    const count = headerLine.split(d).length - 1
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best
}

function parseCsvLine(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++  // skip the escaped quote
        } else {
          inQuotes = false
        }
      } else {
        cur += c
      }
    } else {
      if (c === '"') {
        inQuotes = true
      } else if (c === delim) {
        out.push(cur)
        cur = ''
      } else {
        cur += c
      }
    }
  }
  out.push(cur)
  return out
}

// ---------------------------------------------------------------------------
// HTML  — strip tags, keep headings and list structure as Markdown
//
// We're going for embedding-friendly text, not pretty rendering. The
// parser normalizes whitespace inside blocks and preserves heading
// depth (h1/h2/h3) + bullet markers so the RAG scorer can match
// document-structure keywords.
// ---------------------------------------------------------------------------

async function extractHtml(file: File): Promise<string> {
  const html = await file.text()
  // Strip scripts / styles entirely — their contents are never useful
  // for retrieval and often include noise like tracking beacons.
  let cleaned = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  cleaned = cleaned.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  // Convert headings to Markdown.
  cleaned = cleaned.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
  cleaned = cleaned.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
  cleaned = cleaned.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
  cleaned = cleaned.replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n\n#### $1\n\n')
  // List items → bullets.
  cleaned = cleaned.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
  // Paragraph / br / div break → line break.
  cleaned = cleaned.replace(/<\/(p|div|section|article)>/gi, '\n\n')
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n')
  // Strip all remaining tags.
  cleaned = cleaned.replace(/<[^>]+>/g, ' ')
  // HTML entity decode (common ones only — full decode would need a
  // dependency and these cover >99% of real pages).
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
  return cleaned
}

// ---------------------------------------------------------------------------
// RTF  — minimal plaintext extraction (strip control words + groups)
//
// No dependency on a full RTF parser. Good enough for text-heavy RTFs;
// complex formatted documents should go through Unstructured instead.
// ---------------------------------------------------------------------------

async function extractRtf(file: File): Promise<string> {
  let raw = await file.text()
  // Drop \{...\} font / color / info groups. We do a simplified scan:
  // remove {\fonttbl...}, {\colortbl...}, {\info...}, {\*\...}.
  raw = raw.replace(/\{\\\*\\[^}]*\}/g, '')
  raw = raw.replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict|header|footer)[^}]*\}/gi, '')
  // Convert \par (paragraph) and \line to newlines.
  raw = raw.replace(/\\par\b/gi, '\n')
  raw = raw.replace(/\\line\b/gi, '\n')
  raw = raw.replace(/\\tab\b/gi, '\t')
  // Drop remaining control words (e.g. \f0, \fs24, \ansi).
  raw = raw.replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
  // Drop surviving braces.
  raw = raw.replace(/[{}]/g, '')
  return raw
}

// ---------------------------------------------------------------------------
// JSON  — pretty-print so each key is on its own line
//
// Raw JSON serializes to a long single-line string which chunks badly
// and doesn't embed well. Pretty-printing with 2-space indent puts
// each key on its own line — semantic search picks up "what field is
// X in" queries naturally once the key name is a token on its own.
// Invalid JSON falls through as raw text.
// ---------------------------------------------------------------------------

async function extractJson(file: File): Promise<string> {
  const raw = await file.text()
  try {
    const parsed = JSON.parse(raw)
    return JSON.stringify(parsed, null, 2)
  } catch {
    // Not valid JSON — just return as-is for best-effort indexing.
    return raw
  }
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
