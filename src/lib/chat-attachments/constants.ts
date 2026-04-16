/**
 * Shared constants + types for chat attachments. Used by the upload
 * API, the composer UI, and (in step 5) the LLM pipeline.
 */

export type AttachmentKind = 'image' | 'audio' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'markdown' | 'text'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MB per file

/**
 * Accepted MIME types — kept narrow intentionally. The composer's
 * file picker accept= string in AiComposer must stay in sync.
 */
export const ACCEPTED_MIME_TYPES = new Set<string>([
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // Audio
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
  // Documents
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  // Text
  'text/plain',
  'text/markdown',
])

const EXTENSION_FALLBACK: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/**
 * Returns true if mime-or-filename is an accepted type. Some browsers send
 * file.type='' for obscure extensions (.md, .markdown), so we fall back to
 * the extension for those.
 */
export function isAcceptedMimeType(mime: string, filename?: string): boolean {
  if (ACCEPTED_MIME_TYPES.has(mime)) return true
  if (!filename) return false
  const ext = filename.split('.').pop()?.toLowerCase()
  if (!ext) return false
  const inferred = EXTENSION_FALLBACK[ext]
  return Boolean(inferred && ACCEPTED_MIME_TYPES.has(inferred))
}

/**
 * Classify a mime/filename pair into one of the AttachmentKind buckets.
 * Used by both the UI (pick the right icon) and the pipeline (pick
 * the right extraction strategy).
 */
export function classifyMimeType(mime: string, filename: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx'
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx'
  if (mime === 'text/markdown') return 'markdown'

  // Extension fallback for ambiguous mime types
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'pptx') return 'pptx'
  return 'text'
}

/**
 * Accept string for the file picker. Mirrors ACCEPTED_MIME_TYPES with
 * some common extension aliases so native file dialogs include .md etc.
 */
export const COMPOSER_ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/*',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  '.md',
  '.markdown',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.txt',
].join(',')

/**
 * Shape returned by POST /api/chat/attachments. Included in the
 * message metadata.attachments array when the chat message is sent.
 */
export interface UploadedAttachment {
  id: string
  path: string
  name: string
  size: number
  mime: string
  kind: AttachmentKind
}

/**
 * 12-char URL-safe random id. Not cryptographic — just needs enough
 * entropy to avoid collision on the path segment.
 */
export function newAttachmentId(): string {
  const bytes = new Uint8Array(9)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}
