// ============================================================================
// Jordon AI — Integrations Permissions
// Role-based gates for integration actions. All API routes that write
// integration state must pass through one of these helpers.
// ============================================================================

import type { OrgRole } from '@/types/database'
import type { SupabaseClient } from '@supabase/supabase-js'

export type IntegrationAction =
  | 'connect_new_account'      // initiate OAuth — commits org credentials
  | 'disconnect_account'       // remove from org (+ Composio)
  | 'attach_to_agent'          // attach existing org account to an agent
  | 'detach_from_agent'        // remove attachment
  | 'update_tool_grants'       // change enabled_tools on an attachment
  | 'view_audit'               // read full audit log
  | 'view_integrations'        // read list

const ROLES_BY_ACTION: Record<IntegrationAction, OrgRole[]> = {
  connect_new_account: ['owner', 'admin'],
  disconnect_account: ['owner', 'admin'], // OR connector — checked separately
  attach_to_agent: ['owner', 'admin', 'agent'],
  detach_from_agent: ['owner', 'admin', 'agent'],
  update_tool_grants: ['owner', 'admin', 'agent'],
  view_audit: ['owner', 'admin', 'agent', 'viewer'], // viewer can see own actions only (enforced in RLS)
  view_integrations: ['owner', 'admin', 'agent', 'viewer'],
}

export interface MembershipContext {
  orgId: string
  userId: string
  role: OrgRole
}

/**
 * Resolve the caller's membership for an org. Returns null if not a member.
 * Pass a user-scoped Supabase client (from createClient()) — this enforces RLS.
 */
export async function getMembership(
  supabase: SupabaseClient,
  userId: string,
  orgId?: string
): Promise<MembershipContext | null> {
  const query = supabase
    .from('org_members')
    .select('org_id, user_id, role')
    .eq('user_id', userId)

  if (orgId) query.eq('org_id', orgId)

  const { data, error } = await query.limit(1).maybeSingle()
  if (error || !data) return null
  return { orgId: data.org_id, userId: data.user_id, role: data.role as OrgRole }
}

/**
 * Throws 403-style error if the caller's role isn't allowed for this action.
 */
export function requireIntegrationAction(
  membership: MembershipContext,
  action: IntegrationAction
): void {
  const allowed = ROLES_BY_ACTION[action]
  if (!allowed.includes(membership.role)) {
    throw new PermissionError(
      `Role "${membership.role}" cannot perform action "${action}". Requires one of: ${allowed.join(', ')}`
    )
  }
}

export function canPerform(
  membership: MembershipContext,
  action: IntegrationAction
): boolean {
  return ROLES_BY_ACTION[action].includes(membership.role)
}

/**
 * Special case: disconnect allowed for admin+ OR the user who originally connected it.
 */
export function canDisconnect(
  membership: MembershipContext,
  connectedByUserId: string | null
): boolean {
  if (canPerform(membership, 'disconnect_account')) return true
  return connectedByUserId != null && membership.userId === connectedByUserId
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionError'
  }
}
