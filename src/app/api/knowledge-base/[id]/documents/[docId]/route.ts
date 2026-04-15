import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  const { id: kbId, docId } = await params
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

  // Verify KB ownership
  const { data: kb } = await supabase
    .from('knowledge_bases')
    .select('id')
    .eq('id', kbId)
    .eq('org_id', membership.org_id)
    .single()

  if (!kb) {
    return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
  }

  const admin = createAdminClient()

  // Delete chunks for this document first
  await admin.from('kb_chunks').delete().eq('document_id', docId)
  // Delete document
  const { error } = await admin.from('kb_documents').delete().eq('id', docId).eq('kb_id', kbId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
