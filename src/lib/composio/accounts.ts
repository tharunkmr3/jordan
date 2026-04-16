// ============================================================================
// Jordon AI — org_integrations (Composio connected account) helpers
// CRUD + sync helpers. All writes go through these functions so we have
// a single choke-point for audit logging + status normalization.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrgIntegration, IntegrationStatus } from '@/types/database'
import { getComposio, composioUserIdForOrg } from './client'
import { logAudit } from './audit'

/**
 * Normalize Composio's uppercase statuses to our lowercase enum.
 */
export function normalizeStatus(raw: string | null | undefined): IntegrationStatus {
  const s = String(raw ?? '').toUpperCase()
  switch (s) {
    case 'ACTIVE': return 'active'
    case 'INACTIVE': return 'inactive'
    case 'INITIATED': return 'initiated'
    case 'PENDING': return 'pending'
    case 'EXPIRED': return 'expired'
    case 'FAILED': return 'failed'
    default: return 'initiated'
  }
}

/**
 * Derive a human-readable account label from Composio metadata.
 * Tries: email → username → account_id → slug-based fallback.
 */
export function deriveAccountLabel(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta || typeof meta !== 'object') return null
  const m = meta as Record<string, unknown>
  const candidates = [m.email, m.username, m.account_id, m.accountId, m.account_name, m.accountName, m.handle, m.login]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
  }
  return null
}

export interface ListOrgIntegrationsOptions {
  toolkitSlug?: string
  includeInactive?: boolean
}

/**
 * List an org's pool of connected accounts. Defaults to active only.
 * Service-role client recommended for use inside API handlers that have
 * already performed their own auth checks.
 */
export async function listOrgIntegrations(
  supabase: SupabaseClient,
  orgId: string,
  opts: ListOrgIntegrationsOptions = {}
): Promise<OrgIntegration[]> {
  let q = supabase
    .from('org_integrations')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })

  if (opts.toolkitSlug) q = q.eq('toolkit_slug', opts.toolkitSlug)
  if (!opts.includeInactive) q = q.in('status', ['active', 'pending', 'initiated', 'expired'])

  const { data, error } = await q
  if (error) {
    console.error('[composio/accounts] listOrgIntegrations failed:', error)
    return []
  }
  return (data ?? []) as OrgIntegration[]
}

export async function getOrgIntegration(
  supabase: SupabaseClient,
  id: string
): Promise<OrgIntegration | null> {
  const { data, error } = await supabase
    .from('org_integrations')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.error('[composio/accounts] getOrgIntegration failed:', error)
    return null
  }
  return (data as OrgIntegration) ?? null
}

export async function getOrgIntegrationByConnectedAccount(
  supabase: SupabaseClient,
  connectedAccountId: string
): Promise<OrgIntegration | null> {
  const { data, error } = await supabase
    .from('org_integrations')
    .select('*')
    .eq('connected_account_id', connectedAccountId)
    .maybeSingle()
  if (error) {
    console.error('[composio/accounts] getByConnectedAccount failed:', error)
    return null
  }
  return (data as OrgIntegration) ?? null
}

/**
 * Upsert an org_integration row from a fresh Composio `connectedAccount`.
 * Used in the connect callback + the reconcile job + the webhook handler.
 */
export async function upsertFromComposio(
  supabase: SupabaseClient,
  args: {
    orgId: string
    toolkitSlug: string
    authConfigId: string
    connectedAccount: Record<string, unknown>
    connectedByUserId?: string | null
    actorType?: 'user' | 'system' | 'webhook'
  }
): Promise<OrgIntegration | null> {
  const ca = args.connectedAccount
  const composioId = String(ca.id ?? '')
  if (!composioId) {
    console.error('[composio/accounts] upsert: missing connectedAccount.id')
    return null
  }

  const status = normalizeStatus(ca.status as string | undefined)
  const meta = (ca.meta ?? ca.metadata ?? {}) as Record<string, unknown>
  const label = deriveAccountLabel(meta)

  // Check if already exists
  const existing = await getOrgIntegrationByConnectedAccount(supabase, composioId)

  if (existing) {
    const { data, error } = await supabase
      .from('org_integrations')
      .update({
        status,
        status_detail: (ca.statusReason as string | undefined) ?? null,
        account_label: label ?? existing.account_label,
        metadata: meta,
        last_synced_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error) {
      console.error('[composio/accounts] upsert update failed:', error)
      return null
    }

    if (existing.status !== status) {
      await logAudit(supabase, {
        orgId: args.orgId,
        actorType: args.actorType ?? 'system',
        action: 'status_changed',
        orgIntegrationId: existing.id,
        toolkitSlug: args.toolkitSlug,
        details: { from: existing.status, to: status },
      })
    }
    return data as OrgIntegration
  }

  const { data, error } = await supabase
    .from('org_integrations')
    .insert({
      org_id: args.orgId,
      toolkit_slug: args.toolkitSlug,
      connected_account_id: composioId,
      auth_config_id: args.authConfigId,
      account_label: label,
      status,
      status_detail: (ca.statusReason as string | undefined) ?? null,
      connected_by_user_id: args.connectedByUserId ?? null,
      metadata: meta,
      last_synced_at: new Date().toISOString(),
    })
    .select('*')
    .single()

  if (error) {
    console.error('[composio/accounts] upsert insert failed:', error)
    return null
  }
  return data as OrgIntegration
}

/**
 * Delete an org_integration: first on Composio (to revoke tokens), then locally.
 * Uses best-effort Composio delete — if it fails (e.g. already deleted), we
 * still remove the local row and audit the action with the error.
 */
export async function disconnectOrgIntegration(
  supabase: SupabaseClient,
  args: {
    orgIntegrationId: string
    orgId: string
    actorUserId?: string | null
  }
): Promise<void> {
  const integration = await getOrgIntegration(supabase, args.orgIntegrationId)
  if (!integration) return

  const composio = getComposio()
  let composioError: string | null = null
  try {
    await composio.connectedAccounts.delete(integration.connected_account_id)
  } catch (err) {
    composioError = err instanceof Error ? err.message : String(err)
    console.warn('[composio/accounts] Composio delete failed, proceeding with local delete:', composioError)
  }

  const { error } = await supabase
    .from('org_integrations')
    .delete()
    .eq('id', integration.id)

  if (error) {
    console.error('[composio/accounts] Local delete failed:', error)
    throw new Error(`Failed to delete integration: ${error.message}`)
  }

  await logAudit(supabase, {
    orgId: args.orgId,
    actorUserId: args.actorUserId ?? null,
    action: 'disconnect',
    orgIntegrationId: integration.id,
    toolkitSlug: integration.toolkit_slug,
    details: {
      connected_account_id: integration.connected_account_id,
      composio_error: composioError,
    },
  })
}

/**
 * Pull fresh state from Composio for every non-terminal integration in the org
 * (or all orgs if orgId is null). Used by the reconcile cron.
 */
export async function reconcileOrgIntegrations(
  supabase: SupabaseClient,
  orgId?: string
): Promise<{ synced: number; errors: number }> {
  const composio = getComposio()

  let q = supabase
    .from('org_integrations')
    .select('id, org_id, toolkit_slug, connected_account_id, status')
    .in('status', ['active', 'initiated', 'pending', 'expired'])

  if (orgId) q = q.eq('org_id', orgId)

  const { data, error } = await q
  if (error || !data) {
    console.error('[composio/accounts] reconcile list failed:', error)
    return { synced: 0, errors: 1 }
  }

  let synced = 0
  let errors = 0

  for (const row of data) {
    try {
      const userId = composioUserIdForOrg(row.org_id)
      const accounts = await composio.connectedAccounts.list({
        userIds: [userId],
      } as Parameters<typeof composio.connectedAccounts.list>[0])

      const items = (accounts as { items?: Array<Record<string, unknown>> }).items ?? []
      const match = items.find((a) => String(a.id) === row.connected_account_id)

      if (!match) {
        // Disappeared on Composio side — mark failed/revoked
        await supabase
          .from('org_integrations')
          .update({
            status: 'revoked',
            status_detail: 'Not found on Composio during reconcile',
            last_synced_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        await logAudit(supabase, {
          orgId: row.org_id,
          actorType: 'system',
          action: 'status_changed',
          orgIntegrationId: row.id,
          toolkitSlug: row.toolkit_slug,
          details: { from: row.status, to: 'revoked', reason: 'not_found_on_composio' },
        })
      } else {
        const newStatus = normalizeStatus(match.status as string | undefined)
        if (newStatus !== row.status) {
          await supabase
            .from('org_integrations')
            .update({
              status: newStatus,
              last_synced_at: new Date().toISOString(),
            })
            .eq('id', row.id)
          await logAudit(supabase, {
            orgId: row.org_id,
            actorType: 'system',
            action: 'reconciled',
            orgIntegrationId: row.id,
            toolkitSlug: row.toolkit_slug,
            details: { from: row.status, to: newStatus },
          })
        } else {
          await supabase
            .from('org_integrations')
            .update({ last_synced_at: new Date().toISOString() })
            .eq('id', row.id)
        }
      }
      synced++
    } catch (err) {
      errors++
      console.error('[composio/accounts] reconcile row failed:', row.id, err)
    }
  }

  return { synced, errors }
}
