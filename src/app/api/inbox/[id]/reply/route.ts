import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'
import { sendWhatsAppMessage, sendWhatsAppMedia } from '@/lib/channels/whatsapp'
import { sendFacebookMessage, sendFacebookAttachment } from '@/lib/channels/facebook'
import { signAttachmentUrl } from '@/lib/chat-attachments/signing'
import type { UploadedAttachment, AttachmentKind } from '@/lib/chat-attachments/constants'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: conversationId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  // Verify conversation belongs to this org and grab the full row so
  // we can read agent-level channel config (WhatsApp phone_number_id,
  // Facebook page token, etc.) for outbound sends.
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id, org_id, channel, agent_id, contact_id, channel_conversation_id')
    .eq('id', conversationId)
    .eq('org_id', membership.org_id)
    .single()

  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const body = await request.json()
  const { content, attachments } = body as { content?: string; attachments?: UploadedAttachment[] }

  const trimmedContent = typeof content === 'string' ? content.trim() : ''
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0

  if (!trimmedContent && !hasAttachments) {
    return NextResponse.json({ error: 'Content or attachments required' }, { status: 400 })
  }

  // Save the human-agent message. Attachments live in metadata so
  // the bubble renderer can reconstruct previews; same shape we use
  // for user-side attachments in /api/chat.
  const { data: message, error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      org_id: membership.org_id,
      role: 'human_agent' as const,
      content: trimmedContent,
      channel: conversation.channel,
      metadata: {
        sent_by: user.id,
        ...(hasAttachments ? { attachments } : {}),
      },
    })
    .select()
    .single()

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 })
  }

  // Update conversation status to active and assign to this user
  await supabase
    .from('conversations')
    .update({
      status: 'active',
      assigned_to: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  // Deliver outbound. website channel renders from the DB row via
  // Supabase Realtime, nothing else to do. WhatsApp / Messenger /
  // Phone need an actual API call. Dispatch fire-and-forget — if the
  // external API fails we log and carry on; the DB row is source of
  // truth and surfaces a retry path later.
  void deliverOutbound(conversation, trimmedContent, attachments ?? []).catch(err => {
    console.error('[inbox/reply] outbound delivery failed:', err)
  })

  return NextResponse.json(message, { status: 201 })
}

// ---------------------------------------------------------------------------
// Channel dispatcher
// ---------------------------------------------------------------------------

interface Conversation {
  id: string
  org_id: string
  channel: string
  agent_id: string | null
  contact_id: string | null
  channel_conversation_id: string | null
}

async function deliverOutbound(
  conversation: Conversation,
  text: string,
  attachments: UploadedAttachment[],
): Promise<void> {
  if (conversation.channel === 'website') return // Realtime handles it.
  if (!conversation.agent_id) return

  const admin = createAdminClient()

  // Fetch the agent's active channel config for this channel type.
  // Stored in agent_channels.channel_config as JSONB.
  const { data: channelRow } = await admin
    .from('agent_channels')
    .select('channel_config, is_active')
    .eq('agent_id', conversation.agent_id)
    .eq('channel_type', conversation.channel)
    .maybeSingle()
  if (!channelRow?.is_active) {
    console.warn('[inbox/reply] channel inactive, skipping outbound send:', conversation.channel)
    return
  }
  const config = (channelRow.channel_config ?? {}) as Record<string, string | undefined>

  // Sign each attachment to a URL the platform can fetch.
  const signed = await Promise.all(attachments.map(async a => ({
    attachment: a,
    url: await signAttachmentUrl(a.path, 24 * 3600), // 24h — gives the channel time to download
  })))
  const readyAttachments = signed.filter(s => s.url) as { attachment: UploadedAttachment; url: string }[]

  if (conversation.channel === 'whatsapp') {
    await sendWhatsAppReply(conversation, text, readyAttachments, config)
  } else if (conversation.channel === 'facebook') {
    await sendFacebookReply(conversation, text, readyAttachments, config)
  } else if (conversation.channel === 'phone') {
    // Phone is voice only — inbound SMS isn't wired yet. Attachments
    // can't ride a Twilio voice call anyway. No-op for now, with a
    // log breadcrumb so missed messages are discoverable.
    console.warn('[inbox/reply] phone channel outbound not implemented')
  }
}

async function sendWhatsAppReply(
  conversation: Conversation,
  text: string,
  attachments: { attachment: UploadedAttachment; url: string }[],
  config: Record<string, string | undefined>,
): Promise<void> {
  const phoneNumberId = config.phone_number_id
  const token = config.access_token || process.env.WHATSAPP_BUSINESS_TOKEN
  const to = await resolveWhatsAppRecipient(conversation)
  if (!phoneNumberId || !token || !to) {
    console.warn('[whatsapp/reply] missing phone_number_id / token / recipient')
    return
  }

  // WhatsApp can't combine text + media in one message. Send text first
  // (if any), then one media per attachment. For image / video / doc
  // with a caption we could inline text on the first media, but
  // keeping it simple — separate messages, consistent order.
  if (text) {
    await sendWhatsAppMessage(phoneNumberId, to, text, token)
  }

  for (const { attachment, url } of attachments) {
    const kind = whatsappKindFor(attachment.kind)
    if (!kind) continue
    await sendWhatsAppMedia(
      phoneNumberId,
      to,
      { kind, url, filename: kind === 'document' ? attachment.name : undefined },
      token,
    )
  }
}

async function sendFacebookReply(
  conversation: Conversation,
  text: string,
  attachments: { attachment: UploadedAttachment; url: string }[],
  config: Record<string, string | undefined>,
): Promise<void> {
  const pageToken = config.page_access_token || config.access_token
  const recipient = await resolveFacebookRecipient(conversation)
  if (!pageToken || !recipient) {
    console.warn('[facebook/reply] missing page_access_token / recipient')
    return
  }

  if (text) {
    await sendFacebookMessage(recipient, text, pageToken)
  }
  for (const { attachment, url } of attachments) {
    const kind = facebookKindFor(attachment.kind)
    if (!kind) continue
    await sendFacebookAttachment(recipient, { kind, url }, pageToken)
  }
}

// ---------------------------------------------------------------------------
// Recipient resolution — pull the platform-specific user id off contacts
// ---------------------------------------------------------------------------

async function resolveWhatsAppRecipient(conversation: Conversation): Promise<string | null> {
  if (!conversation.contact_id) return null
  const admin = createAdminClient()
  const { data } = await admin
    .from('contacts')
    .select('phone, channel_user_id')
    .eq('id', conversation.contact_id)
    .single()
  // WhatsApp wants the E.164 number without the '+'. channel_user_id is our
  // canonical copy; fall back to contacts.phone when it's missing.
  return (data?.channel_user_id ?? data?.phone)?.replace(/^\+/, '') ?? null
}

async function resolveFacebookRecipient(conversation: Conversation): Promise<string | null> {
  if (!conversation.contact_id) return null
  const admin = createAdminClient()
  const { data } = await admin
    .from('contacts')
    .select('channel_user_id')
    .eq('id', conversation.contact_id)
    .single()
  return data?.channel_user_id ?? null
}

// ---------------------------------------------------------------------------
// Kind mapping — our internal AttachmentKind → platform enum
// ---------------------------------------------------------------------------

function whatsappKindFor(kind: AttachmentKind): 'image' | 'audio' | 'document' | null {
  if (kind === 'image') return 'image'
  if (kind === 'audio') return 'audio'
  if (kind === 'pdf' || kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'markdown' || kind === 'text') {
    return 'document'
  }
  return null
}

function facebookKindFor(kind: AttachmentKind): 'image' | 'audio' | 'file' | null {
  if (kind === 'image') return 'image'
  if (kind === 'audio') return 'audio'
  // Messenger uses 'file' for any non-image/audio/video.
  return 'file'
}
