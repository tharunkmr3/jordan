// ============================================================================
// Jordon AI — Integration audit helpers
// Typed writers for integration_audit_log and integration_tool_calls.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type AuditAction =
  | 'connect_initiated'
  | 'connect_completed'
  | 'connect_failed'
  | 'connect_cancelled'
  | 'disconnect'
  | 'attach'
  | 'detach'
  | 'tools_updated'
  | 'status_changed'
  | 'auth_config_created'
  | 'auth_config_deleted'
  | 'reconciled'

export interface AuditParams {
  orgId: string
  action: AuditAction
  actorUserId?: string | null
  actorType?: 'user' | 'system' | 'webhook'
  orgIntegrationId?: string | null
  agentId?: string | null
  toolkitSlug?: string | null
  details?: Record<string, unknown>
}

/**
 * Write an audit entry. Failures are logged, not thrown — auditing must
 * never block the primary action, and a best-effort record is acceptable.
 */
export async function logAudit(
  supabase: SupabaseClient,
  params: AuditParams
): Promise<void> {
  const { error } = await supabase.from('integration_audit_log').insert({
    org_id: params.orgId,
    actor_user_id: params.actorUserId ?? null,
    actor_type: params.actorType ?? 'user',
    action: params.action,
    org_integration_id: params.orgIntegrationId ?? null,
    agent_id: params.agentId ?? null,
    toolkit_slug: params.toolkitSlug ?? null,
    details: params.details ?? {},
  })
  if (error) {
    console.error('[integrations/audit] Failed to write audit log:', error)
  }
}

export interface ToolCallParams {
  orgId: string
  agentId: string
  conversationId?: string | null
  messageId?: string | null
  orgIntegrationId?: string | null
  toolkitSlug: string
  toolSlug: string
  arguments?: Record<string, unknown> | null
  result?: Record<string, unknown> | null
  success: boolean
  errorMessage?: string | null
  latencyMs?: number | null
}

export async function logToolCall(
  supabase: SupabaseClient,
  params: ToolCallParams
): Promise<void> {
  const { error } = await supabase.from('integration_tool_calls').insert({
    org_id: params.orgId,
    agent_id: params.agentId,
    conversation_id: params.conversationId ?? null,
    message_id: params.messageId ?? null,
    org_integration_id: params.orgIntegrationId ?? null,
    toolkit_slug: params.toolkitSlug,
    tool_slug: params.toolSlug,
    arguments: params.arguments ?? null,
    result: params.result ?? null,
    success: params.success,
    error_message: params.errorMessage ?? null,
    latency_ms: params.latencyMs ?? null,
  })
  if (error) {
    console.error('[integrations/audit] Failed to log tool call:', error)
  }
}
