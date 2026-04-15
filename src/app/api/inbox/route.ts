import { createClient } from '@/lib/supabase/server'
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

  if (status && status !== 'all') {
    query = query.eq('status', status)
  }

  if (channel) {
    query = query.eq('channel', channel)
  }

  const { data: conversations, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // For each conversation, fetch last message and unread count
  const enriched = await Promise.all(
    (conversations || []).map(async (conv) => {
      // Last message
      const { data: lastMsg } = await supabase
        .from('messages')
        .select('content, role, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      // Message count
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conv.id)

      return {
        ...conv,
        last_message: lastMsg || null,
        message_count: count || 0,
      }
    })
  )

  // Filter by search term (contact name) if provided
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
