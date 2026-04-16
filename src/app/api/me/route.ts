// ============================================================================
// GET /api/me
// Minimal caller info — id, email, primary org membership (orgId + role).
// Used by client components to gate UI based on role without re-querying.
// ============================================================================

import { NextResponse } from 'next/server'
import { authedRequest } from '@/lib/integrations/auth-helpers'

export async function GET() {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth
  const { supabase, membership } = auth

  const { data: { user } } = await supabase.auth.getUser()

  return NextResponse.json({
    userId: membership.userId,
    email: user?.email ?? null,
    orgId: membership.orgId,
    role: membership.role,
  })
}
