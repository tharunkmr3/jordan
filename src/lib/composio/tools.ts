// ============================================================================
// Jordon AI — Composio tool loading + execution for the chat pipeline
// Multi-tenant: tools are scoped per-agent, executed per-org, audited per-call.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { getComposio, composioUserIdForOrg } from './client'
import { logToolCall } from './audit'

/**
 * Shape of the tools list returned to the LLM. Composio returns
 * OpenAI-compatible tool schemas by default; we keep that as our
 * canonical shape across providers.
 */
export type LlmTool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface AgentToolContext {
  agentId: string
  orgId: string
  /** Map from tool_slug → org_integration_id. Lets us route execute() to the right account. */
  toolToIntegration: Map<string, { orgIntegrationId: string; connectedAccountId: string; toolkitSlug: string }>
  /** Flat list of tool slugs the agent is allowed to call. */
  allowedToolSlugs: Set<string>
}

/**
 * Fetch the tool list for an agent: joins agent_integrations → org_integrations
 * (only active ones), collects enabled_tools across attachments, and asks
 * Composio for the schemas.
 *
 * Returns an empty list if the agent has no integrations — callers should
 * gracefully skip tool-calling in that case.
 */
export async function buildAgentTools(
  supabase: SupabaseClient,
  agentId: string
): Promise<{ tools: LlmTool[]; ctx: AgentToolContext } | null> {
  const { data: rows, error } = await supabase
    .from('agent_integrations')
    .select(`
      id,
      enabled_tools,
      org_id,
      org_integration:org_integration_id (
        id,
        toolkit_slug,
        connected_account_id,
        status
      )
    `)
    .eq('agent_id', agentId)

  if (error) {
    console.error('[composio/tools] buildAgentTools query failed:', error)
    return null
  }
  if (!rows || rows.length === 0) return null

  const orgId = rows[0].org_id as string
  const toolToIntegration = new Map<
    string,
    { orgIntegrationId: string; connectedAccountId: string; toolkitSlug: string }
  >()
  const allowedToolSlugs = new Set<string>()
  const allSlugs: string[] = []

  for (const row of rows) {
    const orgInt = Array.isArray(row.org_integration)
      ? row.org_integration[0]
      : (row.org_integration as { id: string; toolkit_slug: string; connected_account_id: string; status: string } | null)
    if (!orgInt) continue
    if (orgInt.status !== 'active') continue

    const enabledTools = (row.enabled_tools as string[] | null) ?? []
    for (const slug of enabledTools) {
      if (!slug) continue
      allSlugs.push(slug)
      allowedToolSlugs.add(slug)
      toolToIntegration.set(slug, {
        orgIntegrationId: orgInt.id,
        connectedAccountId: orgInt.connected_account_id,
        toolkitSlug: orgInt.toolkit_slug,
      })
    }
  }

  if (allSlugs.length === 0) return null

  const composio = getComposio()
  const userId = composioUserIdForOrg(orgId)

  try {
    const result = await composio.tools.get(
      userId,
      { tools: allSlugs } as unknown as Parameters<typeof composio.tools.get>[1]
    )

    // Composio's OpenAI provider returns an array of OpenAI-style tool defs.
    const tools = Array.isArray(result) ? (result as LlmTool[]) : []

    return {
      tools,
      ctx: { agentId, orgId, toolToIntegration, allowedToolSlugs },
    }
  } catch (err) {
    console.error('[composio/tools] composio.tools.get failed:', err)
    return null
  }
}

/**
 * Execute a single tool call the LLM emitted. Enforces the allow-list
 * defensively (never trust the model). Logs every invocation to
 * `integration_tool_calls`.
 *
 * Returns a stringified result suitable for feeding back to the LLM.
 */
export async function executeAgentToolCall(
  supabase: SupabaseClient,
  ctx: AgentToolContext,
  toolCall: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  },
  messageMeta: {
    conversationId?: string | null
    messageId?: string | null
  } = {}
): Promise<{ success: boolean; content: string; raw: unknown }> {
  const toolSlug = toolCall.function.name
  const start = Date.now()

  // Defense: LLM can only call allow-listed tools.
  if (!ctx.allowedToolSlugs.has(toolSlug)) {
    const msg = `Tool "${toolSlug}" is not allowed for this agent.`
    await logToolCall(supabase, {
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      conversationId: messageMeta.conversationId ?? null,
      messageId: messageMeta.messageId ?? null,
      orgIntegrationId: null,
      toolkitSlug: 'unknown',
      toolSlug,
      arguments: safeJsonParse(toolCall.function.arguments),
      result: null,
      success: false,
      errorMessage: msg,
      latencyMs: Date.now() - start,
    })
    return { success: false, content: JSON.stringify({ error: msg }), raw: null }
  }

  const mapping = ctx.toolToIntegration.get(toolSlug)
  if (!mapping) {
    const msg = `No connected account found for tool "${toolSlug}"`
    await logToolCall(supabase, {
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      conversationId: messageMeta.conversationId ?? null,
      messageId: messageMeta.messageId ?? null,
      orgIntegrationId: null,
      toolkitSlug: 'unknown',
      toolSlug,
      arguments: safeJsonParse(toolCall.function.arguments),
      result: null,
      success: false,
      errorMessage: msg,
      latencyMs: Date.now() - start,
    })
    return { success: false, content: JSON.stringify({ error: msg }), raw: null }
  }

  const composio = getComposio()
  const userId = composioUserIdForOrg(ctx.orgId)

  try {
    const raw = await composio.provider.executeToolCall(
      userId,
      toolCall as unknown as Parameters<typeof composio.provider.executeToolCall>[1],
      { connectedAccountId: mapping.connectedAccountId } as Parameters<typeof composio.provider.executeToolCall>[2]
    )

    const content = typeof raw === 'string' ? raw : JSON.stringify(raw)

    await logToolCall(supabase, {
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      conversationId: messageMeta.conversationId ?? null,
      messageId: messageMeta.messageId ?? null,
      orgIntegrationId: mapping.orgIntegrationId,
      toolkitSlug: mapping.toolkitSlug,
      toolSlug,
      arguments: safeJsonParse(toolCall.function.arguments),
      result: safeJsonParse(content),
      success: true,
      latencyMs: Date.now() - start,
    })

    return { success: true, content, raw }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)

    // Detect auth-expired errors and propagate the signal to the
    // integration status (caller/webhook will also catch this).
    if (/token|expired|unauthor/i.test(msg)) {
      await supabase
        .from('org_integrations')
        .update({ status: 'expired', status_detail: msg.slice(0, 500) })
        .eq('id', mapping.orgIntegrationId)
    }

    await logToolCall(supabase, {
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      conversationId: messageMeta.conversationId ?? null,
      messageId: messageMeta.messageId ?? null,
      orgIntegrationId: mapping.orgIntegrationId,
      toolkitSlug: mapping.toolkitSlug,
      toolSlug,
      arguments: safeJsonParse(toolCall.function.arguments),
      result: null,
      success: false,
      errorMessage: msg,
      latencyMs: Date.now() - start,
    })

    return {
      success: false,
      content: JSON.stringify({ error: msg }),
      raw: null,
    }
  }
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
