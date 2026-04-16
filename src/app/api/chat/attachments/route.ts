// ============================================================================
// POST /api/chat/attachments
// Upload a chat attachment (image, audio, or document) that will be attached
// to the next chat message. Returns a manifest the client includes in the
// /api/chat body — the pipeline then fetches bytes (or extracts text) and
// passes them to the LLM.
//
// Access model:
// - Authenticated team members upload into <org_id>/<user_id>/<random>/<file>
//   inside the private chat-attachments bucket.
// - Unauthenticated widget uploads (public chat) are rejected for now.
//   Public widget attachments will need a visitor-scoped signed-upload flow
//   in a later iteration; internal agents are the primary driver right now.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  MAX_ATTACHMENT_BYTES,
  classifyMimeType,
  isAcceptedMimeType,
  newAttachmentId,
  type AttachmentKind,
} from '@/lib/chat-attachments/constants'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const form = await req.formData()
  const file = form.get('file') as File | null
  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: `File too large. Max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB.` },
      { status: 413 },
    )
  }

  const mime = file.type || 'application/octet-stream'
  if (!isAcceptedMimeType(mime, file.name)) {
    return NextResponse.json(
      { error: `Unsupported type: ${mime}. Supported: images, audio, PDF, docx, xlsx, pptx, md, txt.` },
      { status: 415 },
    )
  }

  // Random path segment so two files with the same name don't collide, and
  // so a stolen public URL can't be guessed from user_id + filename.
  const id = newAttachmentId()
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)
  const path = `${membership.org_id}/${user.id}/${id}/${safeName}`

  const admin = createAdminClient()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { error: uploadError } = await admin.storage
    .from('chat-attachments')
    .upload(path, bytes, { contentType: mime, cacheControl: '3600', upsert: false })

  if (uploadError) {
    console.error('[api/chat/attachments] upload failed:', uploadError)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }

  const kind: AttachmentKind = classifyMimeType(mime, file.name)

  return NextResponse.json({
    id,
    path,
    name: file.name,
    size: file.size,
    mime,
    kind,
  })
}
