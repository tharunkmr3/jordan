// ============================================================================
// GET /api/integrations/connections
// Lists the caller's org's pool of connected accounts (org_integrations).
// Optional ?toolkit=slug filter.
// ============================================================================

import { NextResponse } from 'next/server'
import { authedRequest } from '@/lib/integrations/auth-helpers'
import { listOrgIntegrations } from '@/lib/composio/accounts'

export async function GET(request: Request) {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth
  const { supabase, membership } = auth

  const { searchParams } = new URL(request.url)
  const toolkitSlug = searchParams.get('toolkit') ?? undefined
  const includeInactive = searchParams.get('includeInactive') === 'true'

  const items = await listOrgIntegrations(supabase, membership.orgId, {
    toolkitSlug,
    includeInactive,
  })

  return NextResponse.json({ items })
}
