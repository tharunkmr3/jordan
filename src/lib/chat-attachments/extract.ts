/**
 * Attachment → text extraction + audio transcription. Runs server-side
 * during /api/chat/attachments upload so the message arrives at /api/chat
 * already enriched with extractedText / transcript — saves a round trip
 * and means history replay doesn't re-process binaries.
 *
 * Kept deliberately thin: one function per kind, each returns { text }
 * or throws. The upload route wraps in try/catch so a failed extract
 * doesn't block the upload — the file is still saved, user just sees
 * the chip without the "extracted" indicator.
 */

import OpenAI from 'openai'
import type { AttachmentKind } from './constants'

// Audio transcription is gated on having an OpenAI key. Fail loudly in the
// upload route if it's missing so operators know why attachments are silent.
let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY not set — required for audio transcription')
    _openai = new OpenAI({ apiKey })
  }
  return _openai
}

/**
 * Hard caps so one pathological file doesn't blow out the prompt. Docs
 * over this limit get truncated with a trailing "[... truncated]" hint.
 */
const MAX_EXTRACTED_CHARS = 30_000

export async function extractDocumentText(
  kind: AttachmentKind,
  bytes: Uint8Array,
  filename: string,
): Promise<string | null> {
  const buffer = Buffer.from(bytes)

  try {
    if (kind === 'pdf' || kind === 'pptx' || kind === 'xlsx') {
      // officeparser handles PDF, PPTX, XLSX, ODT, ODP, ODS, DOCX. We
      // use it for PDF/PPTX/XLSX and mammoth for docx (cleaner
      // plain-text output on docx).
      const { parseOffice } = await import('officeparser')
      const ast = await parseOffice(buffer)
      // Walk the content node tree and collect text from every node
      // that exposes it. officeparser nests some structured types
      // (tables, headings) but nearly all have a .text field.
      const text = collectOfficeText(ast.content ?? [])
      return trimExtracted(text)
    }
    if (kind === 'docx') {
      const mammoth = await import('mammoth')
      const { value } = await mammoth.extractRawText({ buffer })
      return trimExtracted(value)
    }
    if (kind === 'markdown' || kind === 'text') {
      return trimExtracted(buffer.toString('utf-8'))
    }
    // image / audio handled elsewhere
    return null
  } catch (err) {
    console.error(`[extract] ${kind} extraction failed for ${filename}:`, err)
    return null
  }
}

/**
 * Transcribe an audio file via Whisper. Returns the full text with no
 * timestamps — the model doesn't need those. Returns null on failure so
 * the upload still succeeds (user can re-attach or describe in text).
 *
 * TODO: route to Sarvam for Indian-language agents via agent.language.
 * For now everything goes to Whisper (multilingual).
 */
export async function transcribeAudio(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<string | null> {
  try {
    const openai = getOpenAI()
    // OpenAI SDK expects a Web API File. Node 20+ has global File.
    // Cast to ArrayBuffer slice because lib.dom's BlobPart typing
    // doesn't admit Uint8Array<ArrayBufferLike> directly.
    const blobPart = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const file = new File([blobPart], filename, { type: mime })
    const result = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'text',
    })
    // response_format='text' returns a plain string.
    const text = typeof result === 'string' ? result : (result as { text?: string }).text ?? ''
    return trimExtracted(text)
  } catch (err) {
    console.error(`[extract] transcribeAudio failed for ${filename}:`, err)
    return null
  }
}

function trimExtracted(text: string): string {
  const clean = text.replace(/\u0000/g, '').trim()
  if (clean.length <= MAX_EXTRACTED_CHARS) return clean
  return clean.slice(0, MAX_EXTRACTED_CHARS) + '\n\n[... truncated]'
}

/**
 * Recursively pull .text from every node in an officeparser AST. The AST
 * has a handful of content-node shapes (paragraph, heading, cell, text,
 * list, table) — nearly all have a `text` field; tables / lists have
 * nested children. Kept untyped because the library types are huge and
 * we only care about flattening strings.
 */
function collectOfficeText(nodes: unknown[]): string {
  const out: string[] = []
  function walk(n: unknown) {
    if (n && typeof n === 'object') {
      const node = n as { text?: unknown; content?: unknown[]; children?: unknown[]; rows?: unknown[]; cells?: unknown[] }
      if (typeof node.text === 'string' && node.text.length > 0) out.push(node.text)
      if (Array.isArray(node.content)) node.content.forEach(walk)
      if (Array.isArray(node.children)) node.children.forEach(walk)
      if (Array.isArray(node.rows)) node.rows.forEach(walk)
      if (Array.isArray(node.cells)) node.cells.forEach(walk)
    }
  }
  nodes.forEach(walk)
  return out.join('\n')
}
