// ============================================================================
// POST /api/integrations/connect
// Body: { toolkitSlug: string, agentId?: string }
// Initiates a Composio OAuth connection for the caller's org. Returns a
// redirect URL to open in a popup; the callback route finalizes.
//
// Requires role admin+ (OAuth consent commits org credentials).
// ============================================================================

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { authedRequest, getAppBaseUrl } from '@/lib/integrations/auth-helpers'
import { requireIntegrationAction, PermissionError } from '@/lib/permissions/integrations'
import { initiateConnect, ConnectError } from '@/lib/composio/connect'

export async function POST(request: Request) {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth
  const { membership } = auth

  let body: { toolkitSlug?: unknown; agentId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const toolkitSlug = typeof body.toolkitSlug === 'string' ? body.toolkitSlug.trim() : ''
  if (!toolkitSlug) {
    return NextResponse.json({ error: 'toolkitSlug is required' }, { status: 400 })
  }

  const agentId = typeof body.agentId === 'string' ? body.agentId : null

  try {
    requireIntegrationAction(membership, 'connect_new_account')
  } catch (err) {
    if (err instanceof PermissionError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    throw err
  }

  // If an agentId is passed, confirm it belongs to the org
  const admin = createAdminClient()
  if (agentId) {
    const { data: agent } = await admin
      .from('agents')
      .select('id, org_id')
      .eq('id', agentId)
      .maybeSingle()
    if (!agent || agent.org_id !== membership.orgId) {
      return NextResponse.json({ error: 'Invalid agentId' }, { status: 400 })
    }
  }

  try {
    const result = await initiateConnect(admin, {
      orgId: membership.orgId,
      userId: membership.userId,
      toolkitSlug,
      agentId,
      appBaseUrl: getAppBaseUrl(request),
    })
    return NextResponse.json({
      sessionId: result.sessionId,
      redirectUrl: result.redirectUrl,
      toolkitSlug: result.toolkitSlug,
    })
  } catch (err) {
    if (err instanceof ConnectError) {
      const status = err.code === 'NO_AUTH_CONFIG' ? 501 : 500
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
