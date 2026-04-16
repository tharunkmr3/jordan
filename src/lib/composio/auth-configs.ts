// ============================================================================
// Jordon AI — Composio auth_config resolver
// Resolves the correct auth_config_id for (orgId, toolkitSlug):
// prefers org-specific override, falls back to platform default.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { getComposio } from './client'
import { logAudit } from './audit'

export interface ResolvedAuthConfig {
  id: string                        // row id in composio_auth_configs
  composioAuthConfigId: string      // id on Composio's side (ac_...)
  toolkitSlug: string
  orgId: string | null
  displayName: string | null
  isComposioManaged: boolean
}

/**
 * Resolve an auth config for (orgId, toolkitSlug). Org-specific overrides
 * take precedence over the platform default.
 *
 * Returns null if neither exists — caller should surface "not configured".
 */
export async function resolveAuthConfig(
  supabase: SupabaseClient,
  orgId: string,
  toolkitSlug: string
): Promise<ResolvedAuthConfig | null> {
  const { data, error } = await supabase
    .from('composio_auth_configs')
    .select('id, composio_auth_config_id, toolkit_slug, org_id, display_name, is_composio_managed')
    .eq('toolkit_slug', toolkitSlug)
    .eq('is_active', true)
    .or(`org_id.is.null,org_id.eq.${orgId}`)
    // Prefer org-specific (non-null) over platform-default (null). Postgres
    // sorts NULLs last by default on ASC — reverse to get org row first.
    .order('org_id', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[composio/auth-configs] Query failed:', error)
    return null
  }
  if (!data) return null

  return {
    id: data.id,
    composioAuthConfigId: data.composio_auth_config_id,
    toolkitSlug: data.toolkit_slug,
    orgId: data.org_id,
    displayName: data.display_name,
    isComposioManaged: data.is_composio_managed,
  }
}

/**
 * Create a Composio-managed auth config (uses Composio's shared OAuth app)
 * and persist the row. Idempotent per (toolkitSlug, orgId) thanks to the
 * unique index on composio_auth_configs.
 *
 * Pass orgId=null for a platform-default config (used for most customers).
 */
export async function ensureAuthConfig(
  supabase: SupabaseClient,
  toolkitSlug: string,
  opts: {
    orgId?: string | null
    displayName?: string
    actorUserId?: string | null
  } = {}
): Promise<ResolvedAuthConfig> {
  const orgId = opts.orgId ?? null

  // Idempotence: return existing row if present.
  const existingQuery = supabase
    .from('composio_auth_configs')
    .select('id, composio_auth_config_id, toolkit_slug, org_id, display_name, is_composio_managed')
    .eq('toolkit_slug', toolkitSlug)
  if (orgId === null) existingQuery.is('org_id', null)
  else existingQuery.eq('org_id', orgId)

  const { data: existing } = await existingQuery.maybeSingle()
  if (existing) {
    return {
      id: existing.id,
      composioAuthConfigId: existing.composio_auth_config_id,
      toolkitSlug: existing.toolkit_slug,
      orgId: existing.org_id,
      displayName: existing.display_name,
      isComposioManaged: existing.is_composio_managed,
    }
  }

  // Create on Composio side — managed means we rely on Composio's shared OAuth app.
  const composio = getComposio()
  const created = await composio.authConfigs.create(toolkitSlug, {
    type: 'use_composio_managed_auth',
    name: opts.displayName ?? `Jordon ${toolkitSlug}${orgId ? ` (org ${orgId.slice(0, 8)})` : ''}`,
  } as Parameters<typeof composio.authConfigs.create>[1])

  const composioId = (created as unknown as { id?: string; nanoid?: string }).id
    ?? (created as unknown as { nanoid?: string }).nanoid
  if (!composioId) {
    throw new Error(`Composio did not return an id from authConfigs.create for ${toolkitSlug}`)
  }

  const { data: inserted, error } = await supabase
    .from('composio_auth_configs')
    .insert({
      toolkit_slug: toolkitSlug,
      composio_auth_config_id: composioId,
      org_id: orgId,
      display_name: opts.displayName ?? null,
      is_active: true,
      is_composio_managed: true,
    })
    .select('id, composio_auth_config_id, toolkit_slug, org_id, display_name, is_composio_managed')
    .single()

  if (error || !inserted) {
    throw new Error(`Failed to persist auth config for ${toolkitSlug}: ${error?.message}`)
  }

  if (orgId) {
    await logAudit(supabase, {
      orgId,
      actorUserId: opts.actorUserId ?? null,
      action: 'auth_config_created',
      toolkitSlug,
      details: { auth_config_id: composioId, display_name: opts.displayName },
    })
  }

  return {
    id: inserted.id,
    composioAuthConfigId: inserted.composio_auth_config_id,
    toolkitSlug: inserted.toolkit_slug,
    orgId: inserted.org_id,
    displayName: inserted.display_name,
    isComposioManaged: inserted.is_composio_managed,
  }
}
