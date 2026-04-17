// ============================================================================
// KB document previews — native-format rendering pipeline
//
// For each supported file type, produces either:
//   { kind: 'native',  signedUrl }   → iframe / img can render the binary directly
//   { kind: 'html',    html }        → inline HTML block, server-generated + sanitized
//   { kind: 'pdf',     signedUrl }   → storage-hosted PDF (for PPT/PPTX converted via LibreOffice)
//   { kind: 'text' }                 → fall back to the Text tab (caller handles)
//   { kind: 'error',   message }     → generation attempted and failed
//   { kind: 'missing' }              → no binary stored (legacy rows pre-storage)
//
// HTML results are cached in kb_documents.preview_html. PDF conversions
// are cached as a path in kb_documents.preview_pdf_path that points to a
// blob in the kb-documents storage bucket. Cache is invalidated by the
// PATCH route whenever content_text is re-embedded.
//
// Heavy deps (xlsx, libreoffice-convert, mammoth) are dynamically imported
// so the route bundles only pull them in when needed.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import sanitizeHtml from 'sanitize-html'
import { promisify } from 'node:util'

const BUCKET = 'kb-documents'
const SIGNED_URL_TTL_SECONDS = 15 * 60  // 15 min

/** Node-style callback signature of libreoffice-convert's `convert`. */
type ConvertCallback = (
  document: Buffer,
  format: string,
  filter: string | undefined,
  cb: (err: NodeJS.ErrnoException | null, data: Buffer) => void
) => void

export type PreviewKind =
  | 'native'       // Signed URL, browser handles (PDF iframe, img)
  | 'html'         // Generic server-rendered HTML block (deprecated; DOCX moved to 'pdf')
  | 'pdf'          // Signed URL to a server-converted PDF (DOCX / PPTX via LibreOffice)
  | 'spreadsheet'  // Structured sheets — XLSX / XLS rendered tab-switchable
  | 'text'         // Fall back to the Text tab (client handles)
  | 'error'        // Generation attempted and failed
  | 'missing'      // No binary stored (legacy rows pre-storage)

export interface SheetPreview {
  name: string
  html: string
}

export interface Preview {
  kind: PreviewKind
  /** For 'native' and 'pdf': a signed URL to the binary. */
  signedUrl?: string
  /** For 'html': sanitized HTML string. */
  html?: string
  /** For 'spreadsheet': structured per-sheet HTML so the client can
      render tabs at the bottom (Excel-style) and swap between sheets. */
  sheets?: SheetPreview[]
  /** For 'error': human-readable reason. */
  message?: string
  /** Fallback: show the Text tab instead. */
  reason?: string
}

type SupabaseAdmin = SupabaseClient

// ---------------------------------------------------------------------------
// Public: resolve a preview for a document row
// ---------------------------------------------------------------------------

export async function getDocumentPreview(
  admin: SupabaseAdmin,
  doc: {
    id: string
    org_id: string
    name: string
    file_type: string | null
    file_url: string | null
    content_text: string | null
    preview_html: string | null
    preview_pdf_path: string | null
    preview_error: string | null
  }
): Promise<Preview> {
  // If we never stashed the binary (uploads before this feature),
  // the viewer falls back to Text tab with a note.
  if (!doc.file_url) {
    return { kind: 'missing' }
  }

  const kind = classifyFileType(doc.file_type, doc.name)

  // Native-browser formats: PDF, images.
  if (kind === 'pdf' || kind === 'image') {
    const signedUrl = await signStoragePath(admin, doc.file_url)
    if (!signedUrl) return { kind: 'error', message: 'Could not sign file URL' }
    return { kind: 'native', signedUrl }
  }

  // CSV: render from content_text client-side — the extracted text is
  // already a verbatim copy of the file, and doing it client-side avoids
  // an HTML round-trip for something trivial to parse.
  if (kind === 'csv') {
    return { kind: 'text' }  // client detects CSV from filename and renders
  }

  // Plain text & Markdown: same as Text tab; Markdown gets rendered on
  // the client via the existing <Markdown> component.
  if (kind === 'text' || kind === 'markdown') {
    return { kind: 'text' }
  }

  // DOCX / PPT / PPTX: convert to PDF via LibreOffice, store in bucket,
  // cache the path, return a signed URL that flows to the PdfRenderer.
  // This is high-fidelity — fonts, alignment, colors, tables, images
  // all preserved — at the cost of a ~2-3s first-render as LibreOffice
  // spins up and converts. Subsequent opens hit the cache instantly.
  //
  // DOCX used to go through mammoth.convertToHtml, which was faster but
  // stripped visual formatting (no alignment, fonts, exact colors). The
  // LibreOffice path gives Word-faithful output that matches what users
  // see in Word, Pages, or Google Docs.
  if (kind === 'docx' || kind === 'pptx') {
    if (doc.preview_pdf_path) {
      const signedUrl = await signStoragePath(admin, doc.preview_pdf_path)
      if (signedUrl) return { kind: 'pdf', signedUrl }
    }
    const converted = await convertOfficeToPdf(admin, doc)
    if (!converted.ok) {
      await persistError(admin, doc.id, converted.error)
      return { kind: 'error', message: converted.error }
    }
    await persistPdfPath(admin, doc.id, converted.pdfPath)
    const signedUrl = await signStoragePath(admin, converted.pdfPath)
    if (!signedUrl) return { kind: 'error', message: 'Signing converted PDF failed' }
    return { kind: 'pdf', signedUrl }
  }

  // XLSX (and legacy XLS): structured per-sheet HTML via SheetJS.
  // Rendered client-side with sheet tabs at the bottom so users can
  // switch between sheets like real Excel. Kept on SheetJS instead of
  // LibreOffice → PDF because spreadsheets need to stay scrollable and
  // selectable — PDF pagination breaks wide tables across pages.
  //
  // Cache format: preview_html stores the JSON-serialized sheets array.
  // Old cache entries (single HTML blob from the pre-structured path)
  // are detected by the JSON.parse failing and regenerated on the fly.
  if (kind === 'xlsx') {
    if (doc.preview_html) {
      try {
        const cached = JSON.parse(doc.preview_html) as { sheets?: SheetPreview[] }
        if (Array.isArray(cached.sheets) && cached.sheets.length > 0) {
          return { kind: 'spreadsheet', sheets: cached.sheets }
        }
      } catch {
        // Fall through to regenerate when the cache is the old format.
      }
    }
    const result = await generateXlsxSheets(admin, doc.file_url)
    if (!result.ok) {
      await persistError(admin, doc.id, result.error)
      return { kind: 'error', message: result.error }
    }
    // Cache the full structure so repeat opens skip SheetJS + sanitize work.
    await persistHtml(admin, doc.id, JSON.stringify({ sheets: result.sheets }))
    return { kind: 'spreadsheet', sheets: result.sheets }
  }

  // Unknown type — fall through to text.
  return { kind: 'text', reason: `No native preview for .${fileExtension(doc.name)}` }
}

// ---------------------------------------------------------------------------
// File-type classifier — single source of truth for which branch to take
// ---------------------------------------------------------------------------

export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'markdown' | 'text' | 'image' | 'unknown'

export function classifyFileType(fileType: string | null, name: string): FileKind {
  const t = (fileType ?? '').toLowerCase()
  const n = name.toLowerCase()

  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  if (
    t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    t === 'application/msword' ||
    n.endsWith('.docx') || n.endsWith('.doc')
  ) return 'docx'
  if (
    t === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    t === 'application/vnd.ms-excel' ||
    n.endsWith('.xlsx') || n.endsWith('.xls')
  ) return 'xlsx'
  if (
    t === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    t === 'application/vnd.ms-powerpoint' ||
    n.endsWith('.pptx') || n.endsWith('.ppt')
  ) return 'pptx'
  if (t === 'text/csv' || n.endsWith('.csv')) return 'csv'
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'markdown'
  if (t.startsWith('text/')) return 'text'
  if (t.startsWith('image/')) return 'image'
  return 'unknown'
}

function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function signStoragePath(
  admin: SupabaseAdmin,
  path: string
): Promise<string | null> {
  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) {
    console.error('[kb/preview] signStoragePath failed:', error)
    return null
  }
  return data.signedUrl
}

async function downloadBinary(
  admin: SupabaseAdmin,
  path: string
): Promise<Buffer | null> {
  const { data, error } = await admin.storage.from(BUCKET).download(path)
  if (error || !data) {
    console.error('[kb/preview] downloadBinary failed:', error)
    return null
  }
  const arrayBuffer = await data.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

// ---------------------------------------------------------------------------
// Cache persistence
// ---------------------------------------------------------------------------

async function persistHtml(admin: SupabaseAdmin, docId: string, html: string) {
  await admin
    .from('kb_documents')
    .update({
      preview_html: html,
      preview_generated_at: new Date().toISOString(),
      preview_error: null,
    })
    .eq('id', docId)
}

async function persistPdfPath(admin: SupabaseAdmin, docId: string, pdfPath: string) {
  await admin
    .from('kb_documents')
    .update({
      preview_pdf_path: pdfPath,
      preview_generated_at: new Date().toISOString(),
      preview_error: null,
    })
    .eq('id', docId)
}

async function persistError(admin: SupabaseAdmin, docId: string, message: string) {
  await admin
    .from('kb_documents')
    .update({
      preview_error: message.slice(0, 500),
      preview_generated_at: new Date().toISOString(),
    })
    .eq('id', docId)
}

/**
 * Called by the PATCH document endpoint when content_text is re-embedded.
 * Nuking the cache forces the next GET to regenerate against the new binary
 * (though typically the binary is unchanged; we still clear so an explicit
 * save is always treated as "user expects fresh preview").
 */
export async function invalidatePreviewCache(admin: SupabaseAdmin, docId: string) {
  await admin
    .from('kb_documents')
    .update({
      preview_html: null,
      preview_pdf_path: null,
      preview_generated_at: null,
      preview_error: null,
    })
    .eq('id', docId)
}

// ---------------------------------------------------------------------------
// Generators: DOCX → HTML (mammoth)
// ---------------------------------------------------------------------------

type PdfResult =
  | { ok: true; pdfPath: string }
  | { ok: false; error: string }

// DOCX preview used to go through mammoth.convertToHtml. That path was
// retired in favour of LibreOffice → PDF (see convertOfficeToPdf below)
// because mammoth preserves structure but strips visual formatting
// (fonts, alignment, exact colors). Keeping mammoth imported here as a
// comment so the history is discoverable if we ever want a lightweight
// fallback for docs LibreOffice can't open.

// ---------------------------------------------------------------------------
// Generators: XLSX → HTML (SheetJS)
// ---------------------------------------------------------------------------

type SheetsResult =
  | { ok: true; sheets: SheetPreview[] }
  | { ok: false; error: string }

async function generateXlsxSheets(
  admin: SupabaseAdmin,
  path: string
): Promise<SheetsResult> {
  const buf = await downloadBinary(admin, path)
  if (!buf) return { ok: false, error: 'Original file not found in storage' }

  try {
    // exceljs reads XLSX including cell styles — fills (bg color), fonts
    // (color / bold / italic / underline / size), borders, alignment,
    // number formats. We render each sheet to our own HTML with inline
    // styles so the preview shows what the user sees in Excel.
    //
    // Dynamic import so exceljs (~700KB) only loads when an XLSX is
    // actually opened. `serverExternalPackages` in next.config.ts
    // already lists `xlsx` — we should add `exceljs` too, done in a
    // follow-up to this change.
    const exceljs = await import('exceljs')
    const Workbook = (exceljs as unknown as { default?: { Workbook: new () => ExcelWorkbook }; Workbook?: new () => ExcelWorkbook })
    const WorkbookCtor = Workbook.Workbook ?? Workbook.default?.Workbook
    if (!WorkbookCtor) return { ok: false, error: 'exceljs Workbook constructor not available' }

    const wb = new WorkbookCtor()
    await wb.xlsx.load(buf)

    const sheets: SheetPreview[] = []
    wb.eachSheet((ws) => {
      const html = renderSheet(ws)
      // Sanitize (no styles stripped — exceljs output we control, but
      // defensive against a malicious upload attempting tag injection).
      const clean = sanitizeHtml(html, {
        allowedTags: ['table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'br'],
        allowedAttributes: { '*': ['class', 'colspan', 'rowspan', 'style'] },
        allowedSchemesByTag: {},
        // Keep inline styles on cells — they carry the bg/font/border formatting.
        allowedStyles: {
          '*': {
            'background-color': [/^#(0x)?[0-9a-f]+$/i, /^rgb/, /^transparent$/i],
            'color': [/^#(0x)?[0-9a-f]+$/i, /^rgb/],
            'font-weight': [/^(bold|\d+)$/i],
            'font-style': [/^(italic|normal)$/i],
            'font-size': [/^\d+(px|pt)$/i],
            'text-align': [/^(left|right|center|justify|start|end)$/i],
            'vertical-align': [/^(top|middle|bottom|baseline)$/i],
            'text-decoration': [/^(underline|line-through|none)$/i],
            'border': [/./],
            'border-top': [/./],
            'border-right': [/./],
            'border-bottom': [/./],
            'border-left': [/./],
            'white-space': [/^(nowrap|normal|pre|pre-wrap)$/i],
          },
        },
      })
      sheets.push({ name: ws.name, html: clean })
    })

    return { ok: true, sheets }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'XLSX render failed' }
  }
}


// ---------------------------------------------------------------------------
// Generators: Office docs (DOCX / PPT / PPTX) → PDF via LibreOffice
//
// Works for any format LibreOffice can open — the filter is driven by
// the input's extension. We only route DOCX / PPT / PPTX through here
// today; XLSX stays on SheetJS because spreadsheets read better as
// interactive HTML than paginated PDFs.
// ---------------------------------------------------------------------------

async function convertOfficeToPdf(
  admin: SupabaseAdmin,
  doc: { id: string; org_id: string; file_url: string | null; name: string }
): Promise<PdfResult> {
  if (!doc.file_url) return { ok: false, error: 'No source file to convert' }

  const buf = await downloadBinary(admin, doc.file_url)
  if (!buf) return { ok: false, error: 'Original file not found in storage' }

  let pdfBuf: Buffer
  try {
    // libreoffice-convert shells out to the `soffice` binary. It MUST be
    // installed on the host — in production that means the Coolify image
    // needs:
    //   apt-get install -y libreoffice-core libreoffice-writer \
    //                      libreoffice-impress libreoffice-calc
    // On macOS dev: `brew install libreoffice`.
    //
    // API: the package (v1.8) only exports callback-style `convert` +
    // `convertWithOptions`. We wrap in util.promisify for async/await.
    const libreoffice = (await import('libreoffice-convert')) as unknown as {
      default?: { convert: ConvertCallback }
      convert?: ConvertCallback
    }
    const convertFn = libreoffice.convert ?? libreoffice.default?.convert
    if (typeof convertFn !== 'function') {
      return { ok: false, error: 'libreoffice-convert API not available' }
    }
    const convertAsync = promisify(convertFn) as (
      input: Buffer,
      format: string,
      filter: string | undefined
    ) => Promise<Buffer>
    pdfBuf = await convertAsync(buf, '.pdf', undefined)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'LibreOffice conversion failed'
    // Most common failure: binary not installed. Give a clear hint.
    const hint = /soffice|Could not find|ENOENT/i.test(msg)
      ? 'LibreOffice is not installed on the server. Install it (`brew install libreoffice` / `apt install libreoffice`) and retry.'
      : msg
    return { ok: false, error: hint }
  }

  const pdfPath = `${doc.org_id}/${doc.id}/preview.pdf`
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(pdfPath, pdfBuf, {
      contentType: 'application/pdf',
      upsert: true,
    })
  if (upErr) return { ok: false, error: `Upload converted PDF failed: ${upErr.message}` }

  return { ok: true, pdfPath }
}

// ---------------------------------------------------------------------------
// exceljs → HTML (with inline cell styles)
// ---------------------------------------------------------------------------

// Minimal structural types for the parts of exceljs we touch. Lets us
// stay typed without pulling @types that couple to exceljs internals.
interface ExcelColor { argb?: string; theme?: number; tint?: number }
interface ExcelFill {
  type?: string
  pattern?: string
  fgColor?: ExcelColor
  bgColor?: ExcelColor
}
interface ExcelFont {
  bold?: boolean
  italic?: boolean
  underline?: boolean | string
  size?: number
  color?: ExcelColor
  name?: string
}
interface ExcelBorder {
  style?: string
  color?: ExcelColor
}
interface ExcelBorders {
  top?: ExcelBorder
  right?: ExcelBorder
  bottom?: ExcelBorder
  left?: ExcelBorder
}
interface ExcelAlignment {
  horizontal?: 'left' | 'center' | 'right' | 'justify'
  vertical?: 'top' | 'middle' | 'bottom'
  wrapText?: boolean
}
interface ExcelCell {
  value: unknown
  text: string
  type: number
  style?: {
    font?: ExcelFont
    fill?: ExcelFill
    border?: ExcelBorders
    alignment?: ExcelAlignment
    numFmt?: string
  }
  isMerged?: boolean
  master?: ExcelCell
  address?: string
  numFmt?: string
}
interface ExcelRow {
  cellCount: number
  actualCellCount: number
  values: unknown[]
  eachCell(options: { includeEmpty: boolean }, iteratee: (cell: ExcelCell, colNumber: number) => void): void
  getCell(col: number): ExcelCell
  hidden?: boolean
  height?: number
}
interface ExcelWorksheet {
  name: string
  rowCount: number
  columnCount: number
  actualColumnCount: number
  actualRowCount: number
  columns?: Array<{ width?: number; hidden?: boolean }>
  eachRow(options: { includeEmpty: boolean }, iteratee: (row: ExcelRow, rowNumber: number) => void): void
  getRow(row: number): ExcelRow
}
interface ExcelWorkbook {
  xlsx: { load(buf: Buffer): Promise<ExcelWorkbook> }
  eachSheet(iteratee: (ws: ExcelWorksheet, id: number) => void): void
}

/** Convert an exceljs ARGB (e.g. "FF4A90E2") to a CSS hex color. */
function argbToCss(argb: string | undefined): string | null {
  if (!argb || argb.length < 6) return null
  // ARGB may be 8 chars (AARRGGBB) — skip the alpha.
  const hex = argb.length === 8 ? argb.slice(2) : argb
  return `#${hex.toLowerCase()}`
}

function colorToCss(c: ExcelColor | undefined): string | null {
  if (!c) return null
  return argbToCss(c.argb)
}

function borderStyle(b: ExcelBorder | undefined): string | null {
  if (!b || !b.style) return null
  // exceljs uses "thin" / "medium" / "thick" etc.
  const width =
    b.style === 'thick' ? '2px' :
    b.style === 'medium' ? '1.5px' :
    '1px'
  const color = colorToCss(b.color) ?? 'rgba(0,0,0,0.2)'
  return `${width} solid ${color}`
}

/**
 * Render a single worksheet to HTML with inline styles per cell.
 * Preserves background colors, font weight/color/size, borders, and
 * alignment. Skips columns/rows flagged hidden.
 */
function renderSheet(ws: ExcelWorksheet): string {
  const rows: string[] = []
  const maxCol = Math.max(ws.actualColumnCount ?? ws.columnCount ?? 1, 1)
  const colWidths: (string | null)[] = []
  for (let c = 1; c <= maxCol; c++) {
    const col = ws.columns?.[c - 1]
    // exceljs column.width is in "Excel character units"; ≈ 7-8px each.
    colWidths[c] = col?.width ? `${Math.round(col.width * 7.5)}px` : null
  }

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (row.hidden) return
    const cells: string[] = []
    for (let c = 1; c <= maxCol; c++) {
      const cell = row.getCell(c)
      if (cell.isMerged && cell.master && cell.address !== cell.master.address) {
        // Skip secondary cells of a merged range; the master emits the
        // colspan/rowspan. (We're not computing spans here for simplicity;
        // the cell just disappears which is acceptable v1 behavior.)
        continue
      }
      const raw = cell.text ?? (cell.value == null ? '' : String(cell.value))
      const text = escapeCell(raw)

      const styles: string[] = []
      const fill = cell.style?.fill
      if (fill?.type === 'pattern' && fill.pattern !== 'none') {
        const bg = colorToCss(fill.fgColor) ?? colorToCss(fill.bgColor)
        if (bg) styles.push(`background-color: ${bg}`)
      }

      const font = cell.style?.font
      if (font?.bold) styles.push('font-weight: 600')
      if (font?.italic) styles.push('font-style: italic')
      if (font?.underline) styles.push('text-decoration: underline')
      if (font?.size) styles.push(`font-size: ${font.size}px`)
      const fc = colorToCss(font?.color)
      if (fc) styles.push(`color: ${fc}`)

      const border = cell.style?.border
      const bt = borderStyle(border?.top)
      const br = borderStyle(border?.right)
      const bb = borderStyle(border?.bottom)
      const bl = borderStyle(border?.left)
      if (bt) styles.push(`border-top: ${bt}`)
      if (br) styles.push(`border-right: ${br}`)
      if (bb) styles.push(`border-bottom: ${bb}`)
      if (bl) styles.push(`border-left: ${bl}`)

      const align = cell.style?.alignment
      if (align?.horizontal) styles.push(`text-align: ${align.horizontal}`)
      if (align?.vertical === 'top' || align?.vertical === 'middle' || align?.vertical === 'bottom') {
        styles.push(`vertical-align: ${align.vertical}`)
      }
      if (align?.wrapText) styles.push('white-space: normal')

      // Column width — applied on every cell (HTML tables don't have
      // great column-level styling without colgroup, but per-cell
      // min/max keeps the column consistent).
      const width = colWidths[c]
      if (width) styles.push(`min-width: ${width}`)

      const styleAttr = styles.length > 0 ? ` style="${styles.join('; ')}"` : ''
      cells.push(`<td${styleAttr}>${text}</td>`)
    }
    // Unused but kept for future: row heights could become inline style.
    void rowNumber
    rows.push(`<tr>${cells.join('')}</tr>`)
  })

  return `<table><tbody>${rows.join('')}</tbody></table>`
}

function escapeCell(s: string): string {
  // exceljs returns plain strings; escape for HTML and turn newlines
  // into <br> so wrap-text cells render on multiple lines.
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>')
}
