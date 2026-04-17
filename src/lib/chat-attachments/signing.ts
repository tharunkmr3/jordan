/**
 * Signed-URL helper for chat-attachments. The bucket is private, so
 * reading a file (in the pipeline for vision parts, or in the client
 * for display) requires a short-lived signed URL.
 *
 * Used on two surfaces:
 * - Pipeline: mints URLs that OpenAI/Anthropic servers fetch when
 *   responding to vision messages.
 * - Client: mints URLs the browser renders for chips / previews.
 */

import { createAdminClient } from '@/lib/supabase/admin'

/** Default lifetime: 1 hour. Enough for a single chat turn round-trip. */
const DEFAULT_EXPIRES_IN = 3600

export async function signAttachmentUrl(path: string, expiresIn = DEFAULT_EXPIRES_IN): Promise<string | null> {
  const admin = createAdminClient()
  const { data, error } = await admin.storage
    .from('chat-attachments')
    .createSignedUrl(path, expiresIn)
  if (error || !data) {
    console.error('[attachments/signing] createSignedUrl failed:', error)
    return null
  }
  return data.signedUrl
}

/**
 * Sign a batch of paths in parallel. Preserves order with the input paths.
 * Items that fail to sign are returned as null — callers drop those.
 */
export async function signAttachmentUrls(paths: string[], expiresIn = DEFAULT_EXPIRES_IN): Promise<(string | null)[]> {
  if (paths.length === 0) return []
  return Promise.all(paths.map(p => signAttachmentUrl(p, expiresIn)))
}
