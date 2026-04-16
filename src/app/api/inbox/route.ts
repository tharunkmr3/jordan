import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
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

  const orgId = membership.org_id
  const { searchParams } = request.nextUrl
  const status = searchParams.get('status')
  const channel = searchParams.get('channel')
  const search = searchParams.get('search')
  const agentId = searchParams.get('agentId')

  // Build conversations query with contact and agent joins
  let query = supabase
    .from('conversations')
    .select(`
      *,
      contact:contacts(id, name, email, phone, channel, language, metadata, tags),
      agent:agents(id, name, avatar_url)
    `)
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(100)

  if (status && status !== 'all') {
    query = query.eq('status', status)
  }

  if (channel) {
    query = query.eq('channel', channel)
  }

  if (agentId) {
    query = query.eq('agent_id', agentId)
  }

  const { data: conversations, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!conversations || conversations.length === 0) {
    return NextResponse.json([])
  }

  // Fetch last messages for all conversations in a SINGLE query using admin client
  // (Admin bypasses RLS, which is fine since we already scoped by org above)
  const conversationIds = conversations.map((c) => c.id)
  const admin = createAdminClient()

  const { data: lastMessages } = await admin
    .from('messages')
    .select('conversation_id, content, role, created_at')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: false })

  // Map: conversation_id → latest message
  const lastMsgMap = new Map<string, { content: string; role: string; created_at: string }>()
  for (const msg of lastMessages || []) {
    if (!lastMsgMap.has(msg.conversation_id)) {
      lastMsgMap.set(msg.conversation_id, {
        content: msg.content,
        role: msg.role,
        created_at: msg.created_at,
      })
    }
  }

  const enriched = conversations.map((conv) => ({
    ...conv,
    last_message: lastMsgMap.get(conv.id) || null,
    message_count: 0, // Computed on-demand in detail view
  }))

  // Filter by search term if provided
  let results = enriched
  if (search) {
    const term = search.toLowerCase()
    results = enriched.filter((conv) => {
      const contact = conv.contact as { name?: string; email?: string; phone?: string } | null
      if (!contact) return false
      return (
        contact.name?.toLowerCase().includes(term) ||
        contact.email?.toLowerCase().includes(term) ||
        contact.phone?.includes(term)
      )
    })
  }

  // Sort by last message time (most recent first)
  results.sort((a, b) => {
    const aTime = a.last_message?.created_at || a.updated_at
    const bTime = b.last_message?.created_at || b.updated_at
    return new Date(bTime).getTime() - new Date(aTime).getTime()
  })

  return NextResponse.json(results)
}
