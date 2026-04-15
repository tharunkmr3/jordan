// ============================================================================
// Jordon AI Platform — Facebook Messenger Webhook
// Handles verification (GET) and incoming messages (POST)
// ============================================================================

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processChatMessage } from '@/lib/ai/chat-pipeline'
import {
  parseFacebookWebhook,
  isNonTextMessage,
  extractFacebookMetadata,
  sendFacebookMessage,
} from '@/lib/channels/facebook'

// ---------------------------------------------------------------------------
// GET — Webhook verification
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token === process.env.FACEBOOK_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 })
  }
  return new Response('Forbidden', { status: 403 })
}

// ---------------------------------------------------------------------------
// POST — Handle incoming messages
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const body = await request.json()

  // Return 200 immediately — Facebook requires fast acknowledgment
  handleWebhook(body).catch((err) => {
    console.error('[facebook-webhook] Unhandled error:', err)
  })

  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

// ---------------------------------------------------------------------------
// Async handler
// ---------------------------------------------------------------------------

async function handleWebhook(body: Record<string, unknown>): Promise<void> {
  const supabase = createAdminClient()
  const fallbackToken = process.env.FACEBOOK_PAGE_TOKEN || null

  // Handle non-text messages (attachments, images, etc.)
  if (isNonTextMessage(body)) {
    const meta = extractFacebookMetadata(body)
    if (meta) {
      const agent = await findAgentByPageId(supabase, meta.pageId)
      const pageToken = agent?.pageToken || fallbackToken
      if (pageToken) {
        await sendFacebookMessage(
          meta.senderId,
          'I can only respond to text messages for now.',
          pageToken
        )
      }
      await logWebhookEvent(supabase, agent?.org_id || null, 'non_text_message', body)
    }
    return
  }

  // Parse text message
  const parsed = parseFacebookWebhook(body)
  if (!parsed) {
    // Not a message event (could be a delivery receipt, read event, etc.)
    await logWebhookEvent(supabase, null, 'ignored', body)
    return
  }

  // Dedup: check if we already processed this message ID
  const { data: existingEvent } = await supabase
    .from('webhook_events')
    .select('id')
    .eq('source', 'facebook')
    .eq('event_type', 'message')
    .contains('payload', { message_id: parsed.messageId })
    .limit(1)
    .maybeSingle()

  if (existingEvent) {
    console.log('[facebook-webhook] Duplicate message, skipping:', parsed.messageId)
    return
  }

  // Look up which agent is connected to this Facebook page
  const agent = await findAgentByPageId(supabase, parsed.pageId)
  if (!agent) {
    console.error(
      '[facebook-webhook] No agent found for page_id:',
      parsed.pageId
    )
    await logWebhookEvent(supabase, null, 'unmatched', body)
    return
  }

  // Use agent-specific page token if available, otherwise fall back to env var
  const pageToken = agent.pageToken || fallbackToken
  if (!pageToken) {
    console.error('[facebook-webhook] No page token available for agent:', agent.agent_id)
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
      channel: 'facebook',
      contactInfo: {
        channelUserId: parsed.senderId,
      },
    })

    // Send response back to Facebook Messenger
    await sendFacebookMessage(parsed.senderId, result.response, pageToken)
  } catch (err) {
    console.error('[facebook-webhook] Pipeline error:', err)

    // Send a fallback error message
    await sendFacebookMessage(
      parsed.senderId,
      "I'm sorry, I'm having trouble right now. Please try again in a moment.",
      pageToken
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SupabaseAdmin = ReturnType<typeof createAdminClient>

async function findAgentByPageId(
  supabase: SupabaseAdmin,
  pageId: string
): Promise<{ agent_id: string; org_id: string; pageToken?: string } | null> {
  // Query agent_channels where channel_type='facebook' and config has matching page_id
  const { data, error } = await supabase
    .from('agent_channels')
    .select('agent_id, org_id, channel_config')
    .eq('channel_type', 'facebook')
    .eq('is_active', true)

  if (error || !data) {
    console.error('[facebook-webhook] Error querying agent_channels:', error)
    return null
  }

  // Find the channel whose config.page_id matches
  const match = data.find((ch) => {
    const config = ch.channel_config as Record<string, unknown>
    return config?.page_id === pageId
  })

  if (!match) return null

  const config = match.channel_config as Record<string, unknown>
  return {
    agent_id: match.agent_id,
    org_id: match.org_id,
    pageToken: (config?.page_access_token as string) || undefined,
  }
}

async function logWebhookEvent(
  supabase: SupabaseAdmin,
  orgId: string | null,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from('webhook_events').insert({
    org_id: orgId,
    source: 'facebook' as const,
    event_type: eventType,
    payload,
    processed: true,
  })

  if (error) {
    console.error('[facebook-webhook] Failed to log event:', error)
  }
}
