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

// ---------------------------------------------------------------------------
// Per-agent cache
//
// buildAgentTools runs on EVERY chat turn and makes two network hops:
//   1. Supabase query against agent_integrations (~50–150ms)
//   2. Composio tools.get() for the schema list (~200–400ms)
//
// Neither result changes on the order-of-seconds timescale — integration
// attachments change via admin UI, tool schemas change only on Composio
// SDK releases. A 60s in-memory cache per agent cuts a reliable ~200–
// 400ms off the pre-generation setup latency without meaningfully
// stale-ing anyone's experience.
//
// The cached value is safe to share across turns: toolToIntegration is a
// Map of string→string, allowedToolSlugs is a Set of strings, tools is
// a plain schema array. No live DB handles, no live Composio clients.
//
// Invalidation: invalidateBuildAgentTools(agentId) is exported so the
// integrations-management UI can bust the cache on save. Without that
// call, edits to enabled_tools would take up to CACHE_TTL_MS to reflect
// in running chats — still eventually consistent, never wrong.
// ---------------------------------------------------------------------------

const BUILD_AGENT_TOOLS_CACHE_TTL_MS = 60_000
const buildAgentToolsCache = new Map<
  string,
  { expires: number; value: { tools: LlmTool[]; ctx: AgentToolContext } | null }
>()

/** Bust the cache for a specific agent. Call after editing integrations. */
export function invalidateBuildAgentTools(agentId: string): void {
  buildAgentToolsCache.delete(agentId)
}

/**
 * Fetch the tool list for an agent: joins agent_integrations → org_integrations
 * (only active ones), collects enabled_tools across attachments, and asks
 * Composio for the schemas.
 *
 * Returns an empty list if the agent has no integrations — callers should
 * gracefully skip tool-calling in that case.
 *
 * Cached per-agent for BUILD_AGENT_TOOLS_CACHE_TTL_MS. See cache block
 * above for rationale. Stale caches are refreshed lazily on the next
 * call; no background refresh.
 */
export async function buildAgentTools(
  supabase: SupabaseClient,
  agentId: string
): Promise<{ tools: LlmTool[]; ctx: AgentToolContext } | null> {
  const now = Date.now()
  const cached = buildAgentToolsCache.get(agentId)
  if (cached && cached.expires > now) return cached.value

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
    // Don't cache failures — transient DB issues shouldn't wedge the
    // agent into a tool-less state for 60 seconds.
    return null
  }
  if (!rows || rows.length === 0) {
    buildAgentToolsCache.set(agentId, { expires: now + BUILD_AGENT_TOOLS_CACHE_TTL_MS, value: null })
    return null
  }

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

  if (allSlugs.length === 0) {
    buildAgentToolsCache.set(agentId, { expires: now + BUILD_AGENT_TOOLS_CACHE_TTL_MS, value: null })
    return null
  }

  const composio = getComposio()
  const userId = composioUserIdForOrg(orgId)

  try {
    const result = await composio.tools.get(
      userId,
      { tools: allSlugs } as unknown as Parameters<typeof composio.tools.get>[1]
    )

    // Composio's OpenAI provider returns an array of OpenAI-style tool defs.
    const tools = Array.isArray(result) ? (result as LlmTool[]) : []

    const value = {
      tools,
      ctx: { agentId, orgId, toolToIntegration, allowedToolSlugs },
    }
    buildAgentToolsCache.set(agentId, { expires: now + BUILD_AGENT_TOOLS_CACHE_TTL_MS, value })
    return value
  } catch (err) {
    // Don't cache Composio API failures — tool listing is eventually
    // consistent, but a transient 5xx shouldn't leave the agent without
    // tools for 60 seconds.
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
