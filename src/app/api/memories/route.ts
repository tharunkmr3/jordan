import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createMemoryManual } from '@/lib/ai/memory'

/**
 * List memories visible to the current user:
 *   - scope=mine (default): only your own memories
 *   - scope=shared: org-shared memories created by any team member
 *   - scope=all: both, merged
 *
 * RLS already restricts to memories the caller can see; the scope query
 * param just narrows further so the UI can tab between "My memories" and
 * "Shared with team".
 */
export async function GET(request: Request) {
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

  const { searchParams } = new URL(request.url)
  const scope = searchParams.get('scope') ?? 'all'

  let query = supabase
    .from('memories')
    .select('id, content, is_shared, source, importance, created_at, updated_at, last_accessed_at, user_id')
    .eq('org_id', membership.org_id)
    .order('created_at', { ascending: false })
    .limit(500)

  if (scope === 'mine') query = query.eq('user_id', user.id)
  if (scope === 'shared') query = query.eq('is_shared', true)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Join against profiles for the owner's display name so the Memories
  // page can show "Shared by Priya" next to org-wide entries.
  const userIds = [...new Set((data ?? []).map((m) => m.user_id as string))]
  const profiles = userIds.length > 0
    ? await supabase.from('profiles').select('id, full_name, email').in('id', userIds)
    : { data: [] as { id: string; full_name: string | null; email: string }[] }

  const byId = new Map((profiles.data ?? []).map((p) => [p.id, p]))

  const enriched = (data ?? []).map((m) => ({
    ...m,
    owner_name: byId.get(m.user_id as string)?.full_name || byId.get(m.user_id as string)?.email?.split('@')[0] || 'Someone',
    is_own: (m.user_id as string) === user.id,
  }))

  return NextResponse.json(enriched)
}

/**
 * Create a memory from the Memories page. Input: { content, is_shared }.
 * Source is recorded as 'manual' (not 'explicit' — that's the chat-command
 * path in memory.ts).
 */
export async function POST(request: Request) {
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

  const body = await request.json().catch(() => null) as { content?: string; is_shared?: boolean } | null
  if (!body || typeof body.content !== 'string') {
    return NextResponse.json({ error: 'content is required' }, { status: 400 })
  }

  const result = await createMemoryManual(
    { userId: user.id, orgId: membership.org_id as string },
    body.content,
    Boolean(body.is_shared),
  )

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }
  return NextResponse.json({ id: result.id }, { status: 201 })
}
