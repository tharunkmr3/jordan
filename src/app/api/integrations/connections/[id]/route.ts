// ============================================================================
// DELETE /api/integrations/connections/:id
// Removes an org-level connected account (cascades to all agent attachments).
// Admin+ OR the user who originally connected.
// ============================================================================

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { authedRequest } from '@/lib/integrations/auth-helpers'
import { canDisconnect } from '@/lib/permissions/integrations'
import {
  disconnectOrgIntegration,
  getOrgIntegration,
} from '@/lib/composio/accounts'

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth
  const { membership } = auth

  const { id } = await ctx.params

  // Use admin client for writes after we've validated permission above
  const admin = createAdminClient()
  const integration = await getOrgIntegration(admin, id)

  if (!integration) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (integration.org_id !== membership.orgId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (!canDisconnect(membership, integration.connected_by_user_id)) {
    return NextResponse.json(
      { error: 'Only admins or the original connector can disconnect this account.' },
      { status: 403 }
    )
  }

  try {
    await disconnectOrgIntegration(admin, {
      orgIntegrationId: id,
      orgId: membership.orgId,
      actorUserId: membership.userId,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
