// ============================================================================
// GET /api/integrations/callback?s=<csrfToken>&status=<success|failure>
// Composio redirects here after the user completes OAuth. We finalize the
// session, upsert org_integration, auto-attach to the originating agent,
// and return a minimal HTML page that postMessages the result to the opener.
// ============================================================================

import { createAdminClient } from '@/lib/supabase/admin'
import { completeConnect, ConnectError } from '@/lib/composio/connect'
import { logAudit } from '@/lib/composio/audit'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const csrfToken = searchParams.get('s')
  const status = searchParams.get('status')

  if (!csrfToken) {
    return htmlResponse(renderCallbackHtml({
      ok: false,
      error: 'Missing session token',
    }))
  }

  const admin = createAdminClient()

  // User cancelled OAuth on Composio/provider side
  if (status && status.toLowerCase() !== 'success' && status.toLowerCase() !== 'active') {
    // Mark session cancelled + audit
    const { data: session } = await admin
      .from('integration_connect_sessions')
      .select('id, org_id, initiated_by_user_id, toolkit_slug, agent_id')
      .eq('csrf_token', csrfToken)
      .maybeSingle()

    if (session) {
      await admin
        .from('integration_connect_sessions')
        .update({ status: 'cancelled', completed_at: new Date().toISOString() })
        .eq('id', session.id)
      await logAudit(admin, {
        orgId: session.org_id,
        actorUserId: session.initiated_by_user_id,
        action: 'connect_cancelled',
        toolkitSlug: session.toolkit_slug,
        agentId: session.agent_id,
        details: { provider_status: status },
      })
    }

    return htmlResponse(renderCallbackHtml({
      ok: false,
      error: 'Connection was cancelled.',
    }))
  }

  try {
    const result = await completeConnect(admin, csrfToken)
    return htmlResponse(renderCallbackHtml({
      ok: true,
      orgIntegrationId: result.orgIntegrationId,
      toolkitSlug: result.toolkitSlug,
      agentId: result.agentId,
      status: result.status,
    }))
  } catch (err) {
    const msg = err instanceof ConnectError
      ? err.message
      : err instanceof Error
      ? err.message
      : 'Unknown error'
    return htmlResponse(renderCallbackHtml({ ok: false, error: msg }))
  }
}

// ---------------------------------------------------------------------------
// HTML response — posts message to window.opener and closes.
// ---------------------------------------------------------------------------

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cache callback responses — they contain session-specific data
      'cache-control': 'no-store',
    },
  })
}

function renderCallbackHtml(
  payload:
    | { ok: true; orgIntegrationId: string; toolkitSlug: string; agentId: string | null; status: string }
    | { ok: false; error: string }
): string {
  const json = JSON.stringify({ source: 'jordon:composio-callback', ...payload })
  const headline = payload.ok ? 'Connection complete' : 'Connection failed'
  const detail = payload.ok
    ? 'You can close this window.'
    : escapeHtml(payload.error)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${headline} · Jordon AI</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #fafafa; color: #1f1f1f; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: #fff; border-radius: 12px; padding: 28px 32px; max-width: 420px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.06); }
  h1 { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
  p { margin: 0; font-size: 14px; color: #525252; line-height: 1.5; }
  .ok { color: #166534; }
  .err { color: #991b1b; }
</style>
</head>
<body>
  <div class="card">
    <h1 class="${payload.ok ? 'ok' : 'err'}">${headline}</h1>
    <p>${detail}</p>
  </div>
  <script>
    (function () {
      try {
        var msg = ${JSON.stringify(json)};
        if (window.opener) {
          window.opener.postMessage(JSON.parse(msg), window.location.origin);
        }
      } catch (e) { /* noop */ }
      setTimeout(function () {
        try { window.close(); } catch (e) { /* noop */ }
      }, 1200);
    })();
  </script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
