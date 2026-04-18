// ============================================================================
// /api/agents/:id/integrations/:attachmentId
//
//   PATCH  — update enabled_tools or tool_configs
//            body: { enabledTools?: string[], toolConfigs?: Record<string, object> }
//   DELETE — detach from this agent (org_integration stays in the pool)
// ============================================================================

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { authedRequest } from '@/lib/integrations/auth-helpers'
import { requireIntegrationAction, PermissionError } from '@/lib/permissions/integrations'
import { logAudit } from '@/lib/composio/audit'
import { invalidateBuildAgentTools } from '@/lib/composio/tools'

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; attachmentId: string }> }
) {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth
  const { membership } = auth

  const { id: agentId, attachmentId } = await ctx.params

  try {
    requireIntegrationAction(membership, 'update_tool_grants')
  } catch (err) {
    if (err instanceof PermissionError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    throw err
  }

  let body: { enabledTools?: unknown; toolConfigs?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const updates: Record<string, unknown> = {}
  if (Array.isArray(body.enabledTools)) {
    updates.enabled_tools = body.enabledTools.filter((t) => typeof t === 'string')
  }
  if (body.toolConfigs && typeof body.toolConfigs === 'object') {
    updates.tool_configs = body.toolConfigs
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Verify attachment belongs to agent, agent belongs to org
  const { data: existing } = await admin
    .from('agent_integrations')
    .select('id, agent_id, org_id, org_integration_id, enabled_tools')
    .eq('id', attachmentId)
    .maybeSingle()
  if (!existing || existing.agent_id !== agentId || existing.org_id !== membership.orgId) {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })
  }

  const { data, error } = await admin
    .from('agent_integrations')
    .update(updates)
    .eq('id', attachmentId)
    .select('*')
    .single()
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Update failed' }, { status: 500 })
  }

  // Bust the cache so enabled_tools / tool_configs changes reflect on
  // the next chat turn instead of after the 60s TTL.
  invalidateBuildAgentTools(agentId)

  await logAudit(admin, {
    orgId: membership.orgId,
    actorUserId: membership.userId,
    action: 'tools_updated',
    orgIntegrationId: existing.org_integration_id,
    agentId,
    details: {
      before: { enabled_tools: existing.enabled_tools },
      after: updates,
    },
  })

  return NextResponse.json(data)
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; attachmentId: string }> }
) {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth
  const { membership } = auth

  const { id: agentId, attachmentId } = await ctx.params

  try {
    requireIntegrationAction(membership, 'detach_from_agent')
  } catch (err) {
    if (err instanceof PermissionError) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    throw err
  }

  const admin = createAdminClient()
  const { data: existing } = await admin
    .from('agent_integrations')
    .select('id, agent_id, org_id, org_integration_id, org_integration:org_integration_id(toolkit_slug)')
    .eq('id', attachmentId)
    .maybeSingle()
  if (!existing || existing.agent_id !== agentId || existing.org_id !== membership.orgId) {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 })
  }

  const { error } = await admin
    .from('agent_integrations')
    .delete()
    .eq('id', attachmentId)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Bust the cache so the agent immediately drops the detached
  // integration's tools instead of continuing to offer them for 60s.
  invalidateBuildAgentTools(agentId)

  const orgInt = Array.isArray(existing.org_integration)
    ? existing.org_integration[0]
    : (existing.org_integration as { toolkit_slug?: string } | null)

  await logAudit(admin, {
    orgId: membership.orgId,
    actorUserId: membership.userId,
    action: 'detach',
    orgIntegrationId: existing.org_integration_id,
    agentId,
    toolkitSlug: orgInt?.toolkit_slug ?? null,
  })

  return NextResponse.json({ ok: true })
}
