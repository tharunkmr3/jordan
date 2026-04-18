import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * Flat list of ready KB documents in the org, for the composer's @-mention
 * menu. Keeps the shape minimal — name + parent KB is all the picker needs.
 * Status filter keeps documents-still-processing out of the list so the
 * user can't reference a file whose chunks haven't been embedded yet.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No organization found' }, { status: 403 })

  const { data, error } = await supabase
    .from('kb_documents')
    .select('id, name, kb_id, char_count, knowledge_bases!inner(name, color)')
    .eq('org_id', membership.org_id)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  type Row = {
    id: string
    name: string
    kb_id: string
    char_count: number | null
    knowledge_bases: { name: string; color: string | null } | { name: string; color: string | null }[]
  }

  const files = (data as Row[] | null ?? []).map((row) => {
    const kb = Array.isArray(row.knowledge_bases) ? row.knowledge_bases[0] : row.knowledge_bases
    return {
      id: row.id,
      name: row.name,
      kb_id: row.kb_id,
      kb_name: kb?.name ?? '',
      kb_color: kb?.color ?? null,
      char_count: row.char_count ?? 0,
    }
  })

  return NextResponse.json(files)
}
