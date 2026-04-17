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

const BUCKET = 'kb-documents'
const SIGNED_URL_TTL_SECONDS = 15 * 60  // 15 min

export type PreviewKind = 'native' | 'html' | 'pdf' | 'text' | 'error' | 'missing'

export interface Preview {
  kind: PreviewKind
  /** For 'native' and 'pdf': a signed URL to the binary. */
  signedUrl?: string
  /** For 'html': sanitized HTML string. */
  html?: string
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

  // DOCX: generate HTML via mammoth. Cache hit returns immediately.
  if (kind === 'docx') {
    if (doc.preview_html) return { kind: 'html', html: doc.preview_html }
    const html = await generateDocxHtml(admin, doc.file_url)
    if (!html.ok) {
      await persistError(admin, doc.id, html.error)
      return { kind: 'error', message: html.error }
    }
    await persistHtml(admin, doc.id, html.html)
    return { kind: 'html', html: html.html }
  }

  // XLSX (and legacy XLS): generate HTML via SheetJS, cache.
  if (kind === 'xlsx') {
    if (doc.preview_html) return { kind: 'html', html: doc.preview_html }
    const html = await generateXlsxHtml(admin, doc.file_url)
    if (!html.ok) {
      await persistError(admin, doc.id, html.error)
      return { kind: 'error', message: html.error }
    }
    await persistHtml(admin, doc.id, html.html)
    return { kind: 'html', html: html.html }
  }

  // PPT / PPTX: convert to PDF via LibreOffice, upload to storage, cache path.
  if (kind === 'pptx') {
    if (doc.preview_pdf_path) {
      const signedUrl = await signStoragePath(admin, doc.preview_pdf_path)
      if (signedUrl) return { kind: 'pdf', signedUrl }
    }
    const converted = await convertPptxToPdf(admin, doc)
    if (!converted.ok) {
      await persistError(admin, doc.id, converted.error)
      return { kind: 'error', message: converted.error }
    }
    await persistPdfPath(admin, doc.id, converted.pdfPath)
    const signedUrl = await signStoragePath(admin, converted.pdfPath)
    if (!signedUrl) return { kind: 'error', message: 'Signing converted PDF failed' }
    return { kind: 'pdf', signedUrl }
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

type GenResult =
  | { ok: true; html: string }
  | { ok: false; error: string }

type PdfResult =
  | { ok: true; pdfPath: string }
  | { ok: false; error: string }

async function generateDocxHtml(
  admin: SupabaseAdmin,
  path: string
): Promise<GenResult> {
  const buf = await downloadBinary(admin, path)
  if (!buf) return { ok: false, error: 'Original file not found in storage' }

  try {
    const mammoth = await import('mammoth')
    const { value } = await mammoth.convertToHtml({ buffer: buf })
    // mammoth produces <p>, <h1-6>, <ul>, <ol>, <table>, <strong>, <em>, etc.
    // Sanitize defensively — users could in theory upload a docx with an
    // embedded script-like payload that mammoth might include as HTML.
    const clean = sanitizeHtml(value, {
      allowedTags: [
        'p', 'br', 'strong', 'em', 'u', 's',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'blockquote', 'a', 'img', 'hr', 'pre', 'code',
      ],
      allowedAttributes: {
        a: ['href', 'title', 'target', 'rel'],
        img: ['src', 'alt', 'width', 'height'],
        '*': ['style'],
      },
      transformTags: {
        // Always open external links in new tab safely.
        a: sanitizeHtml.simpleTransform('a', { rel: 'noreferrer noopener', target: '_blank' }),
      },
    })
    return { ok: true, html: clean }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'DOCX render failed' }
  }
}

// ---------------------------------------------------------------------------
// Generators: XLSX → HTML (SheetJS)
// ---------------------------------------------------------------------------

async function generateXlsxHtml(
  admin: SupabaseAdmin,
  path: string
): Promise<GenResult> {
  const buf = await downloadBinary(admin, path)
  if (!buf) return { ok: false, error: 'Original file not found in storage' }

  try {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(buf, { type: 'buffer' })

    // Render each sheet as its own <table>, joined by a small header
    // showing the sheet name. SheetJS's sheet_to_html gives us clean
    // semantic markup with colspan/rowspan honored.
    const sheets = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name]
      const html = XLSX.utils.sheet_to_html(ws, { editable: false })
      return { name, html }
    })

    // Wrap each sheet's table in a labeled block. Sanitize aggressively
    // to strip inline event handlers while preserving structure.
    const combined = sheets
      .map(
        (s) =>
          `<section class="kb-xlsx-sheet"><header class="kb-xlsx-sheet-name">${escapeHtml(s.name)}</header>${s.html}</section>`
      )
      .join('\n')

    const clean = sanitizeHtml(combined, {
      allowedTags: [
        'section', 'header', 'div', 'span',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
        'caption', 'colgroup', 'col', 'br', 'strong', 'em',
      ],
      allowedAttributes: {
        '*': ['class', 'colspan', 'rowspan', 'style'],
      },
      // SheetJS emits ids like "sjs-A1"; keep them so future JS can target
      // cells if needed (e.g. search highlight).
      allowedSchemesByTag: {},
    })
    return { ok: true, html: clean }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'XLSX render failed' }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Generators: PPT/PPTX → PDF (LibreOffice)
// ---------------------------------------------------------------------------

async function convertPptxToPdf(
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
    // needs `apt-get install -y libreoffice-core libreoffice-impress`.
    // In dev on macOS: `brew install libreoffice`.
    const libreoffice = await import('libreoffice-convert')
    const { convertAsync } = (libreoffice.default ?? libreoffice) as unknown as {
      convertAsync: (input: Buffer, format: string, filter: string | undefined) => Promise<Buffer>
    }
    if (typeof convertAsync !== 'function') {
      return { ok: false, error: 'libreoffice-convert API not available' }
    }
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
