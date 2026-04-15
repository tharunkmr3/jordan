// ============================================================================
// Jordon AI Platform — WhatsApp Business Cloud API Webhook
// Handles verification (GET) and incoming messages (POST)
// ============================================================================

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processChatMessage } from '@/lib/ai/chat-pipeline'
import {
  parseWhatsAppWebhook,
  isNonTextMessage,
  extractWhatsAppMetadata,
  sendWhatsAppMessage,
} from '@/lib/channels/whatsapp'

// ---------------------------------------------------------------------------
// GET — Webhook verification
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 })
  }
  return new Response('Forbidden', { status: 403 })
}

// ---------------------------------------------------------------------------
// POST — Handle incoming messages
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const body = await request.json()

  // Return 200 immediately — WhatsApp requires fast acknowledgment
  // Process message asynchronously via waitUntil-style fire-and-forget
  handleWebhook(body).catch((err) => {
    console.error('[whatsapp-webhook] Unhandled error:', err)
  })

  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

// ---------------------------------------------------------------------------
// Async handler
// ---------------------------------------------------------------------------

async function handleWebhook(body: Record<string, unknown>): Promise<void> {
  const supabase = createAdminClient()
  const token = process.env.WHATSAPP_BUSINESS_TOKEN

  if (!token) {
    console.error('[whatsapp-webhook] WHATSAPP_BUSINESS_TOKEN not configured')
    return
  }

  // Handle non-text messages (images, audio, etc.)
  if (isNonTextMessage(body)) {
    const meta = extractWhatsAppMetadata(body)
    if (meta) {
      // Look up agent for this phone number
      const agent = await findAgentByPhoneNumberId(supabase, meta.phoneNumberId)
      if (agent) {
        await sendWhatsAppMessage(
          meta.phoneNumberId,
          meta.from,
          'I can only respond to text messages for now.',
          token
        )
      }
      // Log the event
      await logWebhookEvent(supabase, agent?.org_id || null, 'non_text_message', body)
    }
    return
  }

  // Parse text message
  const parsed = parseWhatsAppWebhook(body)
  if (!parsed) {
    // Not a message event (could be a status update, etc.) — just log and return
    await logWebhookEvent(supabase, null, 'ignored', body)
    return
  }

  // Dedup: check if we already processed this message ID
  const { data: existingEvent } = await supabase
    .from('webhook_events')
    .select('id')
    .eq('source', 'whatsapp')
    .eq('event_type', 'message')
    .contains('payload', { message_id: parsed.messageId })
    .limit(1)
    .maybeSingle()

  if (existingEvent) {
    console.log('[whatsapp-webhook] Duplicate message, skipping:', parsed.messageId)
    return
  }

  // Look up which agent is connected to this WhatsApp phone number
  const agent = await findAgentByPhoneNumberId(supabase, parsed.phoneNumberId)
  if (!agent) {
    console.error(
      '[whatsapp-webhook] No agent found for phone_number_id:',
      parsed.phoneNumberId
    )
    await logWebhookEvent(supabase, null, 'unmatched', body)
    return
  }

  // Log the webhook event
  await logWebhookEvent(supabase, agent.org_id, 'message', {
    ...body,
    message_id: parsed.messageId,
  })

  // Process through the AI chat pipeline
  try {
    const result = await processChatMessage({
      agentId: agent.agent_id,
      message: parsed.text,
      channel: 'whatsapp',
      contactInfo: {
        name: parsed.name || undefined,
        phone: parsed.from,
        channelUserId: parsed.from,
      },
    })

    // Send response back to WhatsApp
    await sendWhatsAppMessage(
      parsed.phoneNumberId,
      parsed.from,
      result.response,
      token
    )
  } catch (err) {
    console.error('[whatsapp-webhook] Pipeline error:', err)

    // Send a fallback error message
    await sendWhatsAppMessage(
      parsed.phoneNumberId,
      parsed.from,
      "I'm sorry, I'm having trouble right now. Please try again in a moment.",
      token
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SupabaseAdmin = ReturnType<typeof createAdminClient>

async function findAgentByPhoneNumberId(
  supabase: SupabaseAdmin,
  phoneNumberId: string
): Promise<{ agent_id: string; org_id: string } | null> {
  // Query agent_channels where channel_type='whatsapp' and config has matching phone_number_id
  const { data, error } = await supabase
    .from('agent_channels')
    .select('agent_id, org_id, channel_config')
    .eq('channel_type', 'whatsapp')
    .eq('is_active', true)

  if (error || !data) {
    console.error('[whatsapp-webhook] Error querying agent_channels:', error)
    return null
  }

  // Find the channel whose config.phone_number_id matches
  const match = data.find((ch) => {
    const config = ch.channel_config as Record<string, unknown>
    return config?.phone_number_id === phoneNumberId
  })

  if (!match) return null

  return { agent_id: match.agent_id, org_id: match.org_id }
}

async function logWebhookEvent(
  supabase: SupabaseAdmin,
  orgId: string | null,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from('webhook_events').insert({
    org_id: orgId,
    source: 'whatsapp' as const,
    event_type: eventType,
    payload,
    processed: true,
  })

  if (error) {
    console.error('[whatsapp-webhook] Failed to log event:', error)
  }
}
