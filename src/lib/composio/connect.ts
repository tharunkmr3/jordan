// ============================================================================
// Jordon AI — Composio OAuth connect flow
// Handles: initiate connection → stash session state → complete in callback.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { getComposio, composioUserIdForOrg } from './client'
import { resolveAuthConfig } from './auth-configs'
import { upsertFromComposio } from './accounts'
import { logAudit } from './audit'

export interface InitiateConnectParams {
  orgId: string
  userId: string
  toolkitSlug: string
  agentId?: string | null     // if set, result auto-attaches to this agent on completion
  appBaseUrl: string          // e.g. https://app.jordon.ai or http://localhost:3000
}

export interface InitiateConnectResult {
  sessionId: string
  csrfToken: string
  redirectUrl: string
  toolkitSlug: string
}

/**
 * Start a new OAuth connection. Creates:
 *   1. A local session row (CSRF + origin + TTL).
 *   2. A Composio connection request.
 *
 * Returns the redirectUrl for the browser + session metadata. The client
 * opens redirectUrl in a popup; Composio will redirect the user to our
 * callback route with the CSRF token appended.
 */
export async function initiateConnect(
  supabase: SupabaseClient,
  params: InitiateConnectParams
): Promise<InitiateConnectResult> {
  const authConfig = await resolveAuthConfig(supabase, params.orgId, params.toolkitSlug)
  if (!authConfig) {
    throw new ConnectError(
      `No auth config for toolkit "${params.toolkitSlug}". Ask an admin to configure it, or run bootstrap.`,
      'NO_AUTH_CONFIG'
    )
  }

  const csrfToken = crypto.randomBytes(32).toString('base64url')
  const callbackUrl = `${params.appBaseUrl.replace(/\/$/, '')}/api/integrations/callback?s=${csrfToken}`

  // Insert session row first — if Composio fails we want a record of the attempt.
  const { data: session, error: sessionErr } = await supabase
    .from('integration_connect_sessions')
    .insert({
      org_id: params.orgId,
      initiated_by_user_id: params.userId,
      agent_id: params.agentId ?? null,
      toolkit_slug: params.toolkitSlug,
      auth_config_id: authConfig.composioAuthConfigId,
      csrf_token: csrfToken,
      status: 'pending',
    })
    .select('id')
    .single()

  if (sessionErr || !session) {
    throw new ConnectError(
      `Failed to create connect session: ${sessionErr?.message ?? 'unknown'}`,
      'DB_ERROR'
    )
  }

  const composio = getComposio()
  const composioUserId = composioUserIdForOrg(params.orgId)

  try {
    const connectionRequest = await composio.connectedAccounts.initiate(
      composioUserId,
      authConfig.composioAuthConfigId,
      { callbackUrl, allowMultiple: true } as Parameters<typeof composio.connectedAccounts.initiate>[2]
    )

    const redirectUrl = (connectionRequest as unknown as { redirectUrl?: string }).redirectUrl ?? ''
    const connectionRequestId = (connectionRequest as unknown as { id?: string }).id ?? null

    if (!redirectUrl) {
      await markSessionFailed(supabase, session.id, 'Composio did not return a redirectUrl')
      throw new ConnectError('Composio did not return an OAuth redirectUrl', 'COMPOSIO_NO_URL')
    }

    await supabase
      .from('integration_connect_sessions')
      .update({
        composio_connection_request_id: connectionRequestId,
        redirect_url: redirectUrl,
      })
      .eq('id', session.id)

    await logAudit(supabase, {
      orgId: params.orgId,
      actorUserId: params.userId,
      action: 'connect_initiated',
      agentId: params.agentId ?? null,
      toolkitSlug: params.toolkitSlug,
      details: {
        session_id: session.id,
        auth_config_id: authConfig.composioAuthConfigId,
        connection_request_id: connectionRequestId,
      },
    })

    return {
      sessionId: session.id,
      csrfToken,
      redirectUrl,
      toolkitSlug: params.toolkitSlug,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markSessionFailed(supabase, session.id, msg)
    await logAudit(supabase, {
      orgId: params.orgId,
      actorUserId: params.userId,
      action: 'connect_failed',
      agentId: params.agentId ?? null,
      toolkitSlug: params.toolkitSlug,
      details: { error: msg, phase: 'initiate' },
    })
    if (err instanceof ConnectError) throw err
    throw new ConnectError(`Composio initiate failed: ${msg}`, 'COMPOSIO_ERROR')
  }
}

export interface CompleteConnectResult {
  orgIntegrationId: string
  toolkitSlug: string
  agentId: string | null
  status: string
}

/**
 * Callback-time completion. Looks up the session by CSRF, polls Composio
 * for the connection, persists the org_integration, auto-attaches to the
 * originating agent if specified. Safe to retry (idempotent via
 * connected_account_id unique constraint).
 */
export async function completeConnect(
  supabase: SupabaseClient,
  csrfToken: string
): Promise<CompleteConnectResult> {
  const { data: session, error } = await supabase
    .from('integration_connect_sessions')
    .select('*')
    .eq('csrf_token', csrfToken)
    .maybeSingle()

  if (error || !session) {
    throw new ConnectError('Invalid or expired session', 'SESSION_NOT_FOUND')
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await supabase
      .from('integration_connect_sessions')
      .update({ status: 'expired' })
      .eq('id', session.id)
    throw new ConnectError('Session expired', 'SESSION_EXPIRED')
  }

  if (session.status === 'completed' && session.resulting_org_integration_id) {
    return {
      orgIntegrationId: session.resulting_org_integration_id,
      toolkitSlug: session.toolkit_slug,
      agentId: session.agent_id,
      status: 'completed',
    }
  }

  if (!session.composio_connection_request_id) {
    throw new ConnectError('Session has no connection request id', 'NO_REQUEST_ID')
  }

  const composio = getComposio()

  let connectedAccount: Record<string, unknown>
  try {
    connectedAccount = (await composio.connectedAccounts.waitForConnection(
      session.composio_connection_request_id,
      120_000
    )) as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markSessionFailed(supabase, session.id, msg)
    await logAudit(supabase, {
      orgId: session.org_id,
      actorUserId: session.initiated_by_user_id,
      action: 'connect_failed',
      agentId: session.agent_id,
      toolkitSlug: session.toolkit_slug,
      details: { error: msg, phase: 'waitForConnection' },
    })
    throw new ConnectError(`Connection did not complete: ${msg}`, 'COMPOSIO_WAIT_FAILED')
  }

  const integration = await upsertFromComposio(supabase, {
    orgId: session.org_id,
    toolkitSlug: session.toolkit_slug,
    authConfigId: session.auth_config_id,
    connectedAccount,
    connectedByUserId: session.initiated_by_user_id,
    actorType: 'user',
  })

  if (!integration) {
    throw new ConnectError('Failed to persist org_integration', 'DB_ERROR')
  }

  // Auto-attach to the originating agent with empty tool grants (explicit
  // opt-in required for each tool — security by default).
  if (session.agent_id) {
    const { error: attachErr } = await supabase
      .from('agent_integrations')
      .upsert(
        {
          agent_id: session.agent_id,
          org_integration_id: integration.id,
          org_id: session.org_id,
          enabled_tools: [],
          tool_configs: {},
          attached_by_user_id: session.initiated_by_user_id,
        },
        { onConflict: 'agent_id,org_integration_id' }
      )
    if (attachErr) {
      console.error('[composio/connect] auto-attach failed:', attachErr)
    } else {
      await logAudit(supabase, {
        orgId: session.org_id,
        actorUserId: session.initiated_by_user_id,
        action: 'attach',
        orgIntegrationId: integration.id,
        agentId: session.agent_id,
        toolkitSlug: session.toolkit_slug,
        details: { auto_attached_on_connect: true },
      })
    }
  }

  await supabase
    .from('integration_connect_sessions')
    .update({
      status: 'completed',
      resulting_org_integration_id: integration.id,
      completed_at: new Date().toISOString(),
    })
    .eq('id', session.id)

  await logAudit(supabase, {
    orgId: session.org_id,
    actorUserId: session.initiated_by_user_id,
    action: 'connect_completed',
    orgIntegrationId: integration.id,
    agentId: session.agent_id,
    toolkitSlug: session.toolkit_slug,
    details: { status: integration.status },
  })

  return {
    orgIntegrationId: integration.id,
    toolkitSlug: session.toolkit_slug,
    agentId: session.agent_id,
    status: integration.status,
  }
}

async function markSessionFailed(
  supabase: SupabaseClient,
  sessionId: string,
  errorMessage: string
): Promise<void> {
  await supabase
    .from('integration_connect_sessions')
    .update({
      status: 'failed',
      error_message: errorMessage.slice(0, 500),
      completed_at: new Date().toISOString(),
    })
    .eq('id', sessionId)
}

export class ConnectError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'ConnectError'
    this.code = code
  }
}
