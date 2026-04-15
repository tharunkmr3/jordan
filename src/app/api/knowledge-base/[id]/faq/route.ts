import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { generateEmbedding, chunkText } from '@/lib/ai/embeddings'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: kbId } = await params
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

  const body = await request.json()

  if (!body.question || !body.answer) {
    return NextResponse.json({ error: 'Both question and answer are required' }, { status: 400 })
  }

  const content = `Q: ${body.question}\nA: ${body.answer}`
  const admin = createAdminClient()

  // Create document record
  const { data: doc, error: docError } = await admin
    .from('kb_documents')
    .insert({
      kb_id: kbId,
      org_id: membership.org_id,
      name: `FAQ: ${body.question.substring(0, 50)}`,
      file_type: 'faq',
      content_text: content,
      status: 'processing' as const,
      char_count: content.length,
    })
    .select()
    .single()

  if (docError || !doc) {
    return NextResponse.json({ error: docError?.message || 'Failed to create FAQ' }, { status: 500 })
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not configured')
    }

    const chunks = chunkText(content)

    for (const chunkContent of chunks) {
      const embedding = await generateEmbedding(chunkContent)

      await admin.from('kb_chunks').insert({
        document_id: doc.id,
        kb_id: kbId,
        org_id: membership.org_id,
        content: chunkContent,
        embedding: embedding,
        metadata: { source: 'faq', question: body.question },
      })
    }

    await admin
      .from('kb_documents')
      .update({ status: 'ready' as const })
      .eq('id', doc.id)

    return NextResponse.json({ ...doc, status: 'ready' }, { status: 201 })
  } catch (err) {
    console.error('FAQ embedding error:', err)

    await admin
      .from('kb_documents')
      .update({ status: 'error' as const })
      .eq('id', doc.id)

    return NextResponse.json(
      { ...doc, status: 'error', error: err instanceof Error ? err.message : 'Embedding failed' },
      { status: 201 }
    )
  }
}
