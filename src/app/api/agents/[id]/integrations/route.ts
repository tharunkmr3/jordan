// ============================================================================
// /api/agents/:id/integrations
//
//   GET  — list agent_integrations for this agent (with joined org_integration)
//   POST — attach an existing org_integration to this agent (no OAuth)
//          body: { orgIntegrationId: string, enabledTools?: string[] }
// ============================================================================

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { authedRequest } from '@/lib/integrations/auth-helpers'
import { requireIntegrationAction, PermissionError } from '@/lib/permissions/integrations'
import { logAudit } from '@/lib/composio/audit'
import { invalidateBuildAgentTools } from '@/lib/composio/tools'

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth
  const { supabase, membership } = auth

  const { id: agentId } = await ctx.params

  // Verify agent belongs to caller's org via RLS (select)
  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .select('id, org_id')
    .eq('id', agentId)
    .maybeSingle()
  if (agentErr || !agent || agent.org_id !== membership.orgId) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('agent_integrations')
    .select(`
      id, enabled_tools, tool_configs, attached_by_user_id, created_at, updated_at,
      org_integration:org_integration_id (
        id, toolkit_slug, connected_account_id, account_label, status, status_detail,
        connected_by_user_id, last_synced_at, created_at
      )
    `)
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ items: data ?? [] })
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth
  const { membership } = auth

  const { id: agentId } = await ctx.params

  try {
    requireIntegrationAction(membership, 'attach_to_agent')
  } catch (err) {
    if (err instanceof PermissionError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    throw err
  }

  let body: { orgIntegrationId?: unknown; enabledTools?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const orgIntegrationId = typeof body.orgIntegrationId === 'string' ? body.orgIntegrationId : ''
  if (!orgIntegrationId) {
    return NextResponse.json({ error: 'orgIntegrationId required' }, { status: 400 })
  }
  const enabledTools = Array.isArray(body.enabledTools)
    ? body.enabledTools.filter((t): t is string => typeof t === 'string')
    : []

  const admin = createAdminClient()

  // Ownership checks
  const { data: agent } = await admin
    .from('agents')
    .select('id, org_id')
    .eq('id', agentId)
    .maybeSingle()
  if (!agent || agent.org_id !== membership.orgId) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const { data: orgInt } = await admin
    .from('org_integrations')
    .select('id, org_id, toolkit_slug')
    .eq('id', orgIntegrationId)
    .maybeSingle()
  if (!orgInt || orgInt.org_id !== membership.orgId) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 })
  }

  const { data, error } = await admin
    .from('agent_integrations')
    .upsert(
      {
        agent_id: agentId,
        org_integration_id: orgIntegrationId,
        org_id: membership.orgId,
        enabled_tools: enabledTools,
        tool_configs: {},
        attached_by_user_id: membership.userId,
      },
      { onConflict: 'agent_id,org_integration_id' }
    )
    .select('*')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Attach failed' }, { status: 500 })
  }

  // Bust the buildAgentTools cache so the next chat turn picks up the
  // newly-attached integration immediately instead of waiting for the
  // 60s TTL. Without this call eventual consistency still works but
  // "I just enabled this, why doesn't the agent know about it yet?"
  // is the kind of UX confusion not worth saving 2 lines to avoid.
  invalidateBuildAgentTools(agentId)

  await logAudit(admin, {
    orgId: membership.orgId,
    actorUserId: membership.userId,
    action: 'attach',
    orgIntegrationId: orgIntegrationId,
    agentId,
    toolkitSlug: orgInt.toolkit_slug,
    details: { enabled_tools: enabledTools },
  })

  return NextResponse.json(data)
}
