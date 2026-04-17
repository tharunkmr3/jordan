// ============================================================================
// POST /api/knowledge-base/[id]/documents/[docId]/reindex
//
// Re-runs the extraction + embedding pipeline for a document that was
// uploaded before a chunking/extraction improvement shipped. Uses the
// original binary (kept in the kb-documents storage bucket) as the
// source of truth, so reindex produces the same result as a fresh
// re-upload — but without making the user click Upload again.
//
// Flow:
//   1. Fetch the binary from storage via file_url.
//   2. Re-extract text with the current extractor.
//   3. Clear existing kb_chunks.
//   4. Re-chunk + re-embed.
//   5. Invalidate the preview cache so the next viewer open regenerates.
//
// Status goes through processing → ready (or error). Works for any
// file type we can extract.
// ============================================================================

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { chunkText, generateEmbedding } from '@/lib/ai/embeddings'
import { extractTextFromFile, sanitizeText } from '@/lib/ai/extract-text'
import { invalidatePreviewCache } from '@/lib/kb/preview'

const BUCKET = 'kb-documents'

export async function POST(
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

  // Ownership / existence check via RLS (user-scoped client).
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
  const { data: doc } = await admin
    .from('kb_documents')
    .select('id, name, file_type, file_url')
    .eq('id', docId)
    .eq('kb_id', kbId)
    .single()
  if (!doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }
  if (!doc.file_url) {
    return NextResponse.json(
      { error: 'This document has no original file stored (uploaded before preview support). Re-upload to reindex.' },
      { status: 409 }
    )
  }

  // Pull the binary back from storage so we re-extract the exact same
  // bytes the user originally uploaded.
  const { data: blob, error: dlErr } = await admin.storage
    .from(BUCKET)
    .download(doc.file_url)
  if (dlErr || !blob) {
    return NextResponse.json(
      { error: `Could not fetch original file: ${dlErr?.message ?? 'unknown'}` },
      { status: 500 }
    )
  }

  // Extract text. The current extractor emits structured rows for
  // spreadsheets, headings-preserving text for DOCX, pdf-parse output
  // for PDFs, and so on. Whatever lands here gets re-embedded.
  let text: string
  try {
    // Recreate a File-like input for the extractor, which expects a
    // browser File object (it calls .arrayBuffer() and .text()).
    const file = new File([blob], doc.name, { type: doc.file_type ?? 'application/octet-stream' })
    const extracted = await extractTextFromFile(file)
    if (!extracted.hasContent) {
      return NextResponse.json({ error: 'Extractor produced no content for this file.' }, { status: 422 })
    }
    text = extracted.text
  } catch (err) {
    return NextResponse.json(
      { error: `Could not extract text: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 422 }
    )
  }

  // Persist new text + mark processing up-front so the UI can reflect
  // progress in the list immediately.
  const safeText = sanitizeText(text)
  await admin
    .from('kb_documents')
    .update({
      content_text: safeText,
      char_count: safeText.length,
      status: 'processing' as const,
    })
    .eq('id', docId)

  // Wipe old chunks so stale embeddings never survive a reindex.
  await admin.from('kb_chunks').delete().eq('document_id', docId)

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not configured')
    }
    const chunks = chunkText(safeText)
    for (const chunkContent of chunks) {
      const embedding = await generateEmbedding(chunkContent)
      await admin.from('kb_chunks').insert({
        document_id: docId,
        kb_id: kbId,
        org_id: membership.org_id,
        content: chunkContent,
        embedding,
        metadata: { source: doc.name, reindexed: true },
      })
    }

    await admin
      .from('kb_documents')
      .update({ status: 'ready' as const })
      .eq('id', docId)

    // Preview cache might be stale if this was a DOCX/XLSX/PPTX where
    // the preview_html / preview_pdf_path needs refreshing too.
    await invalidatePreviewCache(admin, docId)

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
      { error: err instanceof Error ? err.message : 'Reindex failed' },
      { status: 500 }
    )
  }
}
