import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  // Load conversation with contact and agent
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select(`
      *,
      contact:contacts(*),
      agent:agents(id, name, avatar_url)
    `)
    .eq('id', id)
    .eq('org_id', membership.org_id)
    .single()

  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  // Load all messages
  const { data: messages, error: msgError } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 })
  }

  // Count total conversations for this contact
  let conversationCount = 0
  if (conversation.contact_id) {
    const { count } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', conversation.contact_id)
      .eq('org_id', membership.org_id)

    conversationCount = count || 0
  }

  return NextResponse.json({
    ...conversation,
    messages: messages || [],
    conversation_count: conversationCount,
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  const body = await request.json()

  // Build update object from allowed fields
  const update: Record<string, unknown> = {}
  if (body.status) update.status = body.status
  if (body.assigned_to !== undefined) update.assigned_to = body.assigned_to
  if (body.status === 'resolved') update.resolved_at = new Date().toISOString()

  const { data: conversation, error } = await supabase
    .from('conversations')
    .update(update)
    .eq('id', id)
    .eq('org_id', membership.org_id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(conversation)
}
