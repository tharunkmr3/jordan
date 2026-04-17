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

  const formData = await request.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  const allowedTypes = ['text/plain', 'text/csv', 'text/markdown', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  const fileType = file.type || 'text/plain'
  const allowedExt = ['.txt', '.csv', '.md', '.markdown']
  const nameLower = file.name.toLowerCase()

  if (!allowedTypes.includes(fileType) && !allowedExt.some(ext => nameLower.endsWith(ext))) {
    return NextResponse.json({ error: 'Unsupported file type. Supported: .txt, .md, .csv, .pdf, .docx' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Extract text content
  const text = await file.text()

  // Create document record with processing status.
  // file.size is the byte count of the original upload — we record it so
  // the UI can show a real file-size column alongside char_count.
  const { data: doc, error: docError } = await admin
    .from('kb_documents')
    .insert({
      kb_id: kbId,
      org_id: membership.org_id,
      name: file.name,
      file_type: fileType,
      content_text: text,
      status: 'processing' as const,
      char_count: text.length,
      file_size: file.size,
    })
    .select()
    .single()

  if (docError || !doc) {
    return NextResponse.json({ error: docError?.message || 'Failed to create document' }, { status: 500 })
  }

  // Process in background: chunk and embed
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not configured')
    }

    const chunks = chunkText(text)

    // Generate embeddings and insert chunks
    for (const chunkContent of chunks) {
      const embedding = await generateEmbedding(chunkContent)

      await admin.from('kb_chunks').insert({
        document_id: doc.id,
        kb_id: kbId,
        org_id: membership.org_id,
        content: chunkContent,
        embedding: embedding,
        metadata: { source: file.name },
      })
    }

    // Update document status to ready
    await admin
      .from('kb_documents')
      .update({ status: 'ready' as const })
      .eq('id', doc.id)

    return NextResponse.json({ ...doc, status: 'ready', chunk_count: chunks.length }, { status: 201 })
  } catch (err) {
    console.error('Embedding error:', err)

    // Mark document as error
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
