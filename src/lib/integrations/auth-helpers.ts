// ============================================================================
// Jordon AI — Auth helpers for integration API routes
// Consolidates: load caller's org_id + role via user-scoped supabase client.
// Returns a 401/403-shaped NextResponse on failure, else the membership.
// ============================================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { MembershipContext } from '@/lib/permissions/integrations'
import type { OrgRole } from '@/types/database'

export interface AuthedRequest {
  supabase: Awaited<ReturnType<typeof createClient>>
  membership: MembershipContext
}

/**
 * Load the caller's primary org membership. Returns a NextResponse on error
 * or an AuthedRequest on success. Most integration routes want a single org,
 * so we pick the first membership if the user belongs to multiple.
 */
export async function authedRequest(): Promise<NextResponse | AuthedRequest> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: memberships, error } = await supabase
    .from('org_members')
    .select('org_id, user_id, role')
    .eq('user_id', user.id)
    .limit(1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const m = memberships[0]
  return {
    supabase,
    membership: { orgId: m.org_id, userId: m.user_id, role: m.role as OrgRole },
  }
}

/**
 * Helper to determine the app's public origin for callback URLs.
 * Uses NEXT_PUBLIC_APP_URL if set, otherwise falls back to the Request's origin.
 */
export function getAppBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL
  if (envUrl) return envUrl.replace(/\/$/, '')
  try {
    const u = new URL(request.url)
    return `${u.protocol}//${u.host}`
  } catch {
    return 'http://localhost:3000'
  }
}
