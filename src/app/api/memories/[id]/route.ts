import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { updateMemoryFields } from '@/lib/ai/memory'

/**
 * PATCH /api/memories/[id] — edit content or toggle sharing. Body accepts
 * { content?, is_shared? }. Only the memory's owner can modify it (double-
 * enforced: RLS via update policy + the helper's own user_id filter).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) return NextResponse.json({ error: 'No organization found' }, { status: 403 })

  const body = await request.json().catch(() => null) as { content?: string; is_shared?: boolean } | null
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const patch: { content?: string; isShared?: boolean } = {}
  if (typeof body.content === 'string') patch.content = body.content
  if (typeof body.is_shared === 'boolean') patch.isShared = body.is_shared

  const result = await updateMemoryFields(
    { userId: user.id, orgId: membership.org_id as string },
    id,
    patch,
  )
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}

/**
 * DELETE /api/memories/[id] — owner-only. The RLS delete policy filters on
 * user_id = auth.uid() so attempts to delete someone else's shared memory
 * fail at the row level.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabase.from('memories').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
