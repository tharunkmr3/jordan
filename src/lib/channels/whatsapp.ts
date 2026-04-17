// ============================================================================
// Jordon AI Platform — WhatsApp Channel Helpers
// Parse incoming webhooks and send messages via WhatsApp Business Cloud API
// ============================================================================

export interface ParsedWhatsAppMessage {
  from: string
  text: string
  name: string
  phoneNumberId: string
  messageId: string
}

/**
 * Parse a WhatsApp Business Cloud API webhook payload into a simple structure.
 * Returns null for non-text messages or malformed payloads.
 */
export function parseWhatsAppWebhook(
  body: Record<string, unknown>
): ParsedWhatsAppMessage | null {
  try {
    const entry = (body.entry as Array<Record<string, unknown>>)?.[0]
    if (!entry) return null

    const changes = (entry.changes as Array<Record<string, unknown>>)?.[0]
    if (!changes) return null

    const value = changes.value as Record<string, unknown>
    if (!value) return null

    const messages = value.messages as Array<Record<string, unknown>>
    if (!messages || messages.length === 0) return null

    const message = messages[0]
    const messageType = message.type as string

    // Only handle text messages
    if (messageType !== 'text') return null

    const textObj = message.text as Record<string, string>
    if (!textObj?.body) return null

    const contacts = value.contacts as Array<Record<string, unknown>>
    const profile = contacts?.[0]?.profile as Record<string, string>
    const metadata = value.metadata as Record<string, string>

    return {
      from: message.from as string,
      text: textObj.body,
      name: profile?.name || '',
      phoneNumberId: metadata?.phone_number_id || '',
      messageId: message.id as string,
    }
  } catch {
    return null
  }
}

/**
 * Check if the webhook payload contains a non-text message (image, audio, etc.)
 */
export function isNonTextMessage(body: Record<string, unknown>): boolean {
  try {
    const entry = (body.entry as Array<Record<string, unknown>>)?.[0]
    const changes = (entry?.changes as Array<Record<string, unknown>>)?.[0]
    const value = changes?.value as Record<string, unknown>
    const messages = value?.messages as Array<Record<string, unknown>>
    if (!messages || messages.length === 0) return false

    const messageType = messages[0].type as string
    return messageType !== 'text' && messageType !== undefined
  } catch {
    return false
  }
}

/**
 * Extract the phone_number_id from a webhook payload (for non-text messages).
 */
export function extractWhatsAppMetadata(body: Record<string, unknown>): {
  from: string
  phoneNumberId: string
  messageId: string
} | null {
  try {
    const entry = (body.entry as Array<Record<string, unknown>>)?.[0]
    const changes = (entry?.changes as Array<Record<string, unknown>>)?.[0]
    const value = changes?.value as Record<string, unknown>
    const messages = value?.messages as Array<Record<string, unknown>>
    if (!messages || messages.length === 0) return null

    const metadata = value.metadata as Record<string, string>
    return {
      from: messages[0].from as string,
      phoneNumberId: metadata?.phone_number_id || '',
      messageId: messages[0].id as string,
    }
  } catch {
    return null
  }
}

/**
 * Send a text message via WhatsApp Business Cloud API.
 */
export async function sendWhatsAppMessage(
  phoneNumberId: string,
  to: string,
  text: string,
  token: string
): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  )

  if (!response.ok) {
    const err = await response.text()
    console.error('[whatsapp] Failed to send message:', err)
  }
}

/**
 * Send a media attachment (image / audio / video / document) via
 * WhatsApp. Each call is one media object — the Cloud API doesn't
 * allow combining text with media in a single message, so the caller
 * dispatches one sendWhatsAppMessage for the text + one
 * sendWhatsAppMedia per attachment.
 *
 * WhatsApp accepts either a URL the server can fetch or an uploaded
 * media_id. We use URLs since our attachments bucket issues signed
 * URLs — no double-hop through Meta's media API.
 */
export async function sendWhatsAppMedia(
  phoneNumberId: string,
  to: string,
  media: { kind: 'image' | 'audio' | 'video' | 'document'; url: string; filename?: string; caption?: string },
  token: string,
): Promise<void> {
  // WhatsApp's schema nests the payload under the kind key.
  const mediaPayload: Record<string, unknown> = { link: media.url }
  if (media.kind === 'document' && media.filename) mediaPayload.filename = media.filename
  if ((media.kind === 'image' || media.kind === 'video' || media.kind === 'document') && media.caption) {
    mediaPayload.caption = media.caption
  }

  const response = await fetch(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: media.kind,
        [media.kind]: mediaPayload,
      }),
    },
  )

  if (!response.ok) {
    const err = await response.text()
    console.error('[whatsapp] Failed to send media:', err)
  }
}
