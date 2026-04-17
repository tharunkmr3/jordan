import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { generateEmbedding, chunkText } from '@/lib/ai/embeddings'
import { extractTextFromFile } from '@/lib/ai/extract-text'

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

  // Accept text, PDF, and every Office format we can preview natively.
  // We check BOTH the browser-reported MIME and the filename extension
  // because some browsers send an empty/generic MIME for .xlsx/.pptx.
  const allowedTypes = [
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/pdf',
    // Office Open XML
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // .xlsx
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
    // Legacy binary Office
    'application/msword',         // .doc
    'application/vnd.ms-excel',   // .xls
    'application/vnd.ms-powerpoint', // .ppt
  ]
  const fileType = file.type || 'text/plain'
  const allowedExt = [
    '.txt', '.csv', '.md', '.markdown',
    '.pdf',
    '.doc', '.docx',
    '.xls', '.xlsx', '.xlsm',
    '.ppt', '.pptx',
  ]
  const nameLower = file.name.toLowerCase()

  if (!allowedTypes.includes(fileType) && !allowedExt.some(ext => nameLower.endsWith(ext))) {
    return NextResponse.json(
      { error: 'Unsupported file type. Supported: .txt, .md, .csv, .pdf, .doc/.docx, .xls/.xlsx, .ppt/.pptx' },
      { status: 400 }
    )
  }

  const admin = createAdminClient()

  // Extract text content. Branches by format: PDFs go through pdf-parse,
  // DOCX through mammoth, everything else is read as plain text.
  // Sanitizes out NUL bytes + control chars so Postgres (TEXT + JSONB)
  // doesn't reject the insert with "unsupported Unicode escape sequence".
  let extracted
  try {
    extracted = await extractTextFromFile(file)
  } catch (err) {
    return NextResponse.json(
      { error: `Could not extract text from file: ${err instanceof Error ? err.message : 'unknown error'}` },
      { status: 400 }
    )
  }
  const text = extracted.text

  if (!extracted.hasContent) {
    return NextResponse.json(
      { error: 'File appears to be empty or contains no extractable text.' },
      { status: 400 }
    )
  }

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

  // Store the original binary in the kb-documents storage bucket so the
  // file viewer can render the file in its native format (PDF iframe,
  // DOCX/XLSX via server-side conversion, etc.). Path is namespaced by
  // org for easy RLS / cleanup on org deletion.
  //
  // Best-effort: if storage upload fails (bucket missing, disk full), we
  // still keep the document row — RAG on the extracted text continues to
  // work, and the viewer will surface a "preview unavailable" hint.
  try {
    const arrayBuf = await file.arrayBuffer()
    const objectPath = `${membership.org_id}/${doc.id}/${file.name}`
    const { error: upErr } = await admin.storage
      .from('kb-documents')
      .upload(objectPath, Buffer.from(arrayBuf), {
        contentType: fileType,
        upsert: true,
      })
    if (upErr) {
      console.error('[kb/upload] storage upload failed:', upErr)
    } else {
      await admin
        .from('kb_documents')
        .update({ file_url: objectPath })
        .eq('id', doc.id)
      doc.file_url = objectPath
    }
  } catch (err) {
    console.error('[kb/upload] storage upload exception:', err)
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
