import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
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

  const { data: kb, error } = await supabase
    .from('knowledge_bases')
    .select(`
      *,
      kb_documents(*)
    `)
    .eq('id', id)
    .eq('org_id', membership.org_id)
    .single()

  if (error || !kb) {
    return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
  }

  return NextResponse.json(kb)
}

export async function PATCH(
  request: Request,
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

  const { data: kb } = await supabase
    .from('knowledge_bases')
    .select('id')
    .eq('id', id)
    .eq('org_id', membership.org_id)
    .single()

  if (!kb) {
    return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
  }

  const body = await request.json()
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ('name' in body) updates.name = body.name
  if ('description' in body) updates.description = body.description
  // context = per-KB prompt hint used by the RAG pipeline; trim empty
  // strings to null so the retrieval code can cleanly skip the hint.
  if ('context' in body) updates.context = typeof body.context === 'string' && body.context.trim() ? body.context.trim() : null
  if ('agent_id' in body) updates.agent_id = body.agent_id
  if ('color' in body) updates.color = body.color

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('knowledge_bases')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}

export async function DELETE(
  _request: Request,
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

  // Verify ownership
  const { data: kb } = await supabase
    .from('knowledge_bases')
    .select('id')
    .eq('id', id)
    .eq('org_id', membership.org_id)
    .single()

  if (!kb) {
    return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
  }

  // Use admin client to cascade delete chunks, documents, then KB
  const admin = createAdminClient()

  // Delete chunks first
  await admin.from('kb_chunks').delete().eq('kb_id', id)
  // Delete documents
  await admin.from('kb_documents').delete().eq('kb_id', id)
  // Delete knowledge base
  const { error } = await admin.from('knowledge_bases').delete().eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
