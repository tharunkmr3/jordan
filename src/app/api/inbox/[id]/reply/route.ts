import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

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

  // Verify conversation belongs to this org
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id, org_id, channel, agent_id, channel_conversation_id')
    .eq('id', conversationId)
    .eq('org_id', membership.org_id)
    .single()

  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const body = await request.json()
  const { content } = body

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return NextResponse.json({ error: 'Content is required' }, { status: 400 })
  }

  // Save the human agent message
  const { data: message, error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      org_id: membership.org_id,
      role: 'human_agent' as const,
      content: content.trim(),
      channel: conversation.channel,
      metadata: {
        sent_by: user.id,
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

  // Send reply via channel
  // For website channel, the message is already saved and will be
  // picked up by the widget via Supabase Realtime or polling.
  // For WhatsApp/Facebook/Phone, we would call the channel-specific API here.
  if (conversation.channel === 'whatsapp') {
    // TODO: Send via WhatsApp Business API
    // await sendWhatsAppMessage(conversation, content)
  } else if (conversation.channel === 'facebook') {
    // TODO: Send via Facebook Messenger API
    // await sendFacebookMessage(conversation, content)
  } else if (conversation.channel === 'phone') {
    // TODO: Send via Twilio SMS
    // await sendTwilioSMS(conversation, content)
  }
  // website channel: no external send needed

  return NextResponse.json(message, { status: 201 })
}
