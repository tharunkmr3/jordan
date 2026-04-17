// ============================================================================
// Unstructured.io — high-quality extraction for every supported file type
//
// Why we use this:
//   - One API handles PDF, DOCX, XLSX, PPTX, HTML, RTF, ODT, EML, MSG,
//     CSV, TSV, EPUB, images-with-OCR, and more with consistent output.
//   - Layout-aware: it detects Title / NarrativeText / ListItem / Table
//     blocks and preserves document structure instead of flattening
//     everything to a single blob.
//   - Table extraction is genuinely good — much better than pdf-parse
//     for financial / tabular PDFs where our old path produced jumbled
//     text.
//   - OCR included for scanned PDFs and images (strategy=hi_res).
//
// Pricing / quota: free tier gives 1000 pages/month, then $0.01/page
// on the hosted API. The service is also self-hostable as a Docker
// container if you want zero-cost + data residency later — no code
// changes needed, just flip UNSTRUCTURED_API_URL.
//
// Fallback: when UNSTRUCTURED_API_KEY is unset (or the API errors),
// extract-text.ts drops back to the local extractors (pdf-parse,
// mammoth, SheetJS, officeparser). The local path still works; it
// just produces lower-quality extractions on tables and scanned PDFs.
// ============================================================================

export interface UnstructuredElement {
  type: string
  text: string
  metadata?: Record<string, unknown>
}

/**
 * True when Unstructured is configured. Callers check this before
 * building out a FormData and paying the extra round-trip.
 */
export function unstructuredEnabled(): boolean {
  return Boolean(process.env.UNSTRUCTURED_API_KEY)
}

/**
 * Send a file to Unstructured.io and return the extracted plain text.
 * Returns null when:
 *   - UNSTRUCTURED_API_KEY is not set (soft-disable)
 *   - the API rejects the file (unsupported format, rate limit, auth)
 *   - parsing succeeded but produced no usable text
 *
 * Caller should fall back to local extractors on null.
 */
export async function extractViaUnstructured(file: File): Promise<string | null> {
  const apiKey = process.env.UNSTRUCTURED_API_KEY
  if (!apiKey) return null

  // Self-hostable — operators can flip UNSTRUCTURED_API_URL to point at
  // their own Docker deployment for data residency. Hosted default is
  // the Unstructured serverless API.
  const endpoint = process.env.UNSTRUCTURED_API_URL?.trim()
    || 'https://api.unstructuredapp.io/general/v0/general'

  // `strategy=hi_res` triggers layout-aware parsing — enables OCR on
  // scanned PDFs, detects table structure, and preserves reading
  // order on multi-column layouts. Slower but dramatically better than
  // the default `fast` strategy for the document types we care about.
  const fd = new FormData()
  fd.append('files', file, file.name)
  fd.append('strategy', 'hi_res')
  // Structured output — return Title, NarrativeText, Table, ListItem
  // etc. as separate elements so we can reassemble with hierarchy.
  fd.append('output_format', 'application/json')
  // For tables specifically, ask Unstructured to also include an HTML
  // representation so we can emit a Markdown-table approximation below.
  fd.append('include_page_breaks', 'true')
  fd.append('pdf_infer_table_structure', 'true')

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'unstructured-api-key': apiKey,
        accept: 'application/json',
      },
      body: fd,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[unstructured] ${res.status}: ${body.slice(0, 300)}`)
      return null
    }
    const elements = await res.json() as UnstructuredElement[]
    if (!Array.isArray(elements) || elements.length === 0) return null
    return elementsToText(elements)
  } catch (err) {
    console.error('[unstructured] request failed:', err)
    return null
  }
}

/**
 * Collapse an element list into a single text blob that preserves
 * structural hints useful for RAG:
 *   - Titles become Markdown # / ## headings
 *   - Tables get a "Table:" label so retrieval can surface them for
 *     "show me the table" queries
 *   - ListItems become "- ..." bullets
 *   - PageBreak markers become blank lines so mid-doc page breaks
 *     aren't rendered as mid-paragraph splits
 *
 * The goal isn't pretty Markdown — it's retrieval-friendly text where
 * structure hints give the embedding model something to latch onto.
 */
function elementsToText(elements: UnstructuredElement[]): string {
  const lines: string[] = []
  let firstTitleSeen = false

  for (const el of elements) {
    const text = (el.text ?? '').trim()
    if (!text) continue

    switch (el.type) {
      case 'Title':
      case 'Header': {
        // First title becomes an H1, subsequent titles become H2.
        // Doesn't have to be exact — just enough hierarchy for the
        // embedding model to anchor on.
        if (!firstTitleSeen) {
          lines.push(`# ${text}`)
          firstTitleSeen = true
        } else {
          lines.push(`## ${text}`)
        }
        break
      }
      case 'ListItem':
        lines.push(`- ${text}`)
        break
      case 'Table': {
        // Unstructured returns table text as tab-separated / newline-
        // separated plain text. Wrap with a label so the retrieval
        // scorer can match "table" / "table of contents" queries.
        const label = (el.metadata?.text_as_html as string | undefined) || text
        lines.push(`[Table]\n${label}`)
        break
      }
      case 'PageBreak':
        lines.push('')  // blank line between pages
        break
      case 'Footer':
      case 'PageNumber':
      case 'Image':
        // Low-signal for retrieval. Page numbers and image captions
        // without OCR text rarely help the model; skip them to keep
        // chunks lean.
        continue
      case 'NarrativeText':
      case 'UncategorizedText':
      case 'Address':
      case 'EmailAddress':
      case 'FigureCaption':
      case 'Formula':
      case 'CodeSnippet':
      default:
        lines.push(text)
        break
    }
  }
  return lines.join('\n\n').trim()
}
