// ============================================================================
// Jordon AI Platform — Facebook Messenger Channel Helpers
// Parse incoming webhooks and send messages via Facebook Send API
// ============================================================================

export interface ParsedFacebookMessage {
  senderId: string
  text: string
  messageId: string
  pageId: string
}

/**
 * Parse a Facebook Messenger webhook payload into a simple structure.
 * Returns null for non-text messages or malformed payloads.
 */
export function parseFacebookWebhook(
  body: Record<string, unknown>
): ParsedFacebookMessage | null {
  try {
    const entry = (body.entry as Array<Record<string, unknown>>)?.[0]
    if (!entry) return null

    const messaging = (entry.messaging as Array<Record<string, unknown>>)?.[0]
    if (!messaging) return null

    const sender = messaging.sender as Record<string, string>
    const message = messaging.message as Record<string, unknown>
    if (!sender?.id || !message) return null

    const text = message.text as string
    if (!text) return null

    return {
      senderId: sender.id,
      text,
      messageId: (message.mid as string) || '',
      pageId: (entry.id as string) || '',
    }
  } catch {
    return null
  }
}

/**
 * Check if the webhook payload contains a non-text message (attachment, etc.)
 */
export function isNonTextMessage(body: Record<string, unknown>): boolean {
  try {
    const entry = (body.entry as Array<Record<string, unknown>>)?.[0]
    const messaging = (entry?.messaging as Array<Record<string, unknown>>)?.[0]
    if (!messaging) return false

    const message = messaging.message as Record<string, unknown>
    if (!message) return false

    // Has attachments but no text
    return !message.text && !!message.attachments
  } catch {
    return false
  }
}

/**
 * Extract sender/page metadata from a Facebook webhook (for non-text messages).
 */
export function extractFacebookMetadata(body: Record<string, unknown>): {
  senderId: string
  pageId: string
  messageId: string
} | null {
  try {
    const entry = (body.entry as Array<Record<string, unknown>>)?.[0]
    const messaging = (entry?.messaging as Array<Record<string, unknown>>)?.[0]
    if (!messaging) return null

    const sender = messaging.sender as Record<string, string>
    const message = messaging.message as Record<string, unknown>

    return {
      senderId: sender?.id || '',
      pageId: (entry.id as string) || '',
      messageId: (message?.mid as string) || '',
    }
  } catch {
    return null
  }
}

/**
 * Send a text message via Facebook Messenger Send API.
 */
export async function sendFacebookMessage(
  recipientId: string,
  text: string,
  pageToken: string
): Promise<void> {
  const response = await fetch(
    'https://graph.facebook.com/v18.0/me/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
        access_token: pageToken,
      }),
    }
  )

  if (!response.ok) {
    const err = await response.text()
    console.error('[facebook] Failed to send message:', err)
  }
}
