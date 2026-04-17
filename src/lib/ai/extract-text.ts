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
    name.endsWith('.docx')
  ) {
    raw = await extractDocx(file)
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
  // what we want for embedding. convertToHtml exists if we later want to
  // render .docx in the viewer with styling.
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(arrayBuf) })
  return value ?? ''
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
