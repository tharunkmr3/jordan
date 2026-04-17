import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { chunkText, generateEmbedding } from '@/lib/ai/embeddings'
import { sanitizeText } from '@/lib/ai/extract-text'
import { getDocumentPreview, invalidatePreviewCache, classifyFileType } from '@/lib/kb/preview'

/**
 * GET /api/knowledge-base/[id]/documents/[docId]
 * Returns the full document row including content_text for the file viewer.
 * The list endpoint (/api/knowledge-base) omits content_text to keep payloads
 * small; this endpoint is paid for explicitly when the user opens a file.
 */
export async function GET(
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
  const { data: doc, error } = await admin
    .from('kb_documents')
    .select('*')
    .eq('id', docId)
    .eq('kb_id', kbId)
    .single()

  if (error || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // Resolve a native-format preview for the file viewer. This:
  //   - returns a signed URL (15m) for PDFs and images (browser renders)
  //   - returns sanitized HTML for DOCX + XLSX (cached in preview_html)
  //   - returns a signed PDF URL for PPT/PPTX (cached in preview_pdf_path,
  //     original converted via LibreOffice)
  //   - returns { kind: 'text' | 'missing' | 'error' } for fallback paths
  // Cache is populated lazily here and invalidated by the PATCH route.
  const preview = await getDocumentPreview(admin, doc)
  const kind = classifyFileType(doc.file_type, doc.name)

  return NextResponse.json({ ...doc, preview, kind })
}

/**
 * PATCH /api/knowledge-base/[id]/documents/[docId]
 * Body: { content_text: string }
 *
 * Replaces the extracted text of a document and re-builds its embedding
 * chunks. The original binary (file_url) is left untouched — the agent
 * only ever sees content_text at retrieval time, so this is the
 * authoritative piece to edit.
 *
 * Flow:
 *   1. Persist new text + mark "processing" so the list shows feedback.
 *   2. Delete old kb_chunks (stale embeddings must not survive re-index).
 *   3. Re-chunk + re-embed via the same helpers the upload pipeline uses.
 *   4. Mark "ready" on success; "error" on any failure.
 */
export async function PATCH(
  request: Request,
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

  const { data: kb } = await supabase
    .from('knowledge_bases')
    .select('id')
    .eq('id', kbId)
    .eq('org_id', membership.org_id)
    .single()
  if (!kb) {
    return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
  }

  let body: { content_text?: unknown }
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const rawText = typeof body.content_text === 'string' ? body.content_text : null
  if (rawText === null) {
    return NextResponse.json({ error: 'content_text (string) is required' }, { status: 400 })
  }
  if (rawText.length > 2_000_000) {
    return NextResponse.json({ error: 'Document too large (max 2MB text)' }, { status: 413 })
  }
  // Strip NULs / control chars — same hygiene as the upload path so edited
  // docs never crash the Postgres insert with "unsupported Unicode escape".
  const nextText = sanitizeText(rawText)

  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('kb_documents')
    .select('id, name')
    .eq('id', docId)
    .eq('kb_id', kbId)
    .single()
  if (!existing) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // Persist text + processing status up-front so the list reflects the edit
  // immediately even if embedding takes a moment.
  await admin
    .from('kb_documents')
    .update({
      content_text: nextText,
      char_count: nextText.length,
      status: 'processing' as const,
    })
    .eq('id', docId)

  // Wipe old chunks — never leave stale embeddings retrievable.
  await admin.from('kb_chunks').delete().eq('document_id', docId)

  // Drop any cached native-format preview. Editing the extracted text
  // typically doesn't change the original binary, but a) some formats
  // (CSV) use the text as the source-of-truth for rendering, and b)
  // users explicitly expect "save = everything refreshes". Safer to
  // regenerate on the next GET than to serve stale content.
  await invalidatePreviewCache(admin, docId)

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not configured')
    }
    const chunks = chunkText(nextText)
    for (const chunkContent of chunks) {
      const embedding = await generateEmbedding(chunkContent)
      await admin.from('kb_chunks').insert({
        document_id: docId,
        kb_id: kbId,
        org_id: membership.org_id,
        content: chunkContent,
        embedding,
        metadata: { source: existing.name },
      })
    }

    await admin
      .from('kb_documents')
      .update({ status: 'ready' as const })
      .eq('id', docId)

    const { data: updated } = await admin
      .from('kb_documents')
      .select('*')
      .eq('id', docId)
      .single()
    return NextResponse.json({ ...updated, chunk_count: chunks.length })
  } catch (err) {
    await admin
      .from('kb_documents')
      .update({ status: 'error' as const })
      .eq('id', docId)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Re-embedding failed' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/knowledge-base/[id]/documents/[docId]
 * Removes a document and its kb_chunks.
 */
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
  // Chunks have ON DELETE CASCADE but we delete explicitly for clarity.
  await admin.from('kb_chunks').delete().eq('document_id', docId)
  const { error } = await admin
    .from('kb_documents')
    .delete()
    .eq('id', docId)
    .eq('kb_id', kbId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
