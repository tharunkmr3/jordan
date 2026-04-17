// ============================================================================
// GET /api/chat/attachments/sign?path=<path>
// Returns a short-lived signed URL for reading a chat attachment. The
// bucket is private — this is how the browser gets a URL it can hand to
// <img> / <audio> / <a download>. Scoped to the caller's org so a user
// can't read another org's files even if they guess the path.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { signAttachmentUrl } from '@/lib/chat-attachments/signing'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No organization' }, { status: 403 })

  const path = req.nextUrl.searchParams.get('path')
  if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 })

  // Path prefix guard: chat-attachments paths are <orgId>/<userId>/...
  // — a member of orgA can't sign a path that starts with orgB.
  const orgPrefix = `${membership.org_id}/`
  if (!path.startsWith(orgPrefix)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = await signAttachmentUrl(path, 3600)
  if (!url) return NextResponse.json({ error: 'Sign failed' }, { status: 500 })
  return NextResponse.json({ url })
}
