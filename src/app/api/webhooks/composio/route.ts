// ============================================================================
// POST /api/webhooks/composio
// Receives Composio trigger + lifecycle webhooks. Verifies signature per
// Composio's HMAC-SHA256 scheme, logs to webhook_events, and reacts to
// connected-account status events where applicable.
//
// Signature scheme (from Composio SDK docs):
//   sign(`${webhook-id}.${webhook-timestamp}.${rawBody}`, COMPOSIO_WEBHOOK_SECRET)
//   Header 'webhook-signature' format: 'v1,base64(signature)'
// ============================================================================

import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { headers } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { getComposio } from '@/lib/composio/client'
import {
  getOrgIntegrationByConnectedAccount,
  upsertFromComposio,
  normalizeStatus,
} from '@/lib/composio/accounts'
import { logAudit } from '@/lib/composio/audit'

export async function POST(request: Request) {
  const secret = process.env.COMPOSIO_WEBHOOK_SECRET
  if (!secret) {
    console.error('[webhooks/composio] COMPOSIO_WEBHOOK_SECRET is not set — rejecting webhook')
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
  }

  // Read raw body for signature verification
  const rawBody = await request.text()
  const hdr = await headers()
  const webhookId = hdr.get('webhook-id') ?? ''
  const webhookTimestamp = hdr.get('webhook-timestamp') ?? ''
  const webhookSignature = hdr.get('webhook-signature') ?? ''

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return NextResponse.json({ error: 'Missing webhook headers' }, { status: 400 })
  }

  // Prefer SDK verifier — it handles version detection + timestamp tolerance.
  // Fall back to manual HMAC if SDK throws an unexpected shape.
  let verified = false
  try {
    await getComposio().triggers.verifyWebhook({
      id: webhookId,
      payload: rawBody,
      secret,
      signature: webhookSignature,
      timestamp: webhookTimestamp,
    })
    verified = true
  } catch (err) {
    // Fallback: manual verification
    verified = verifyManual({
      webhookId,
      timestamp: webhookTimestamp,
      signatureHeader: webhookSignature,
      rawBody,
      secret,
    })
    if (!verified) {
      const msg = err instanceof Error ? err.message : 'Signature verification failed'
      console.warn('[webhooks/composio] Signature rejected:', msg)
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  // Parse payload (already verified authentic at this point)
  let event: Record<string, unknown>
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Log everything we receive for auditability (and future replay).
  await supabase.from('webhook_events').insert({
    source: 'composio' as const,
    event_type: String(event.type ?? event.event ?? 'unknown'),
    payload: event,
    processed: false,
  }).select('id').single().then(() => undefined, (e) => {
    console.error('[webhooks/composio] failed to log event:', e)
  })

  // React to connected-account lifecycle events if present.
  // Composio's payload shape varies by version; we check both "data" and "payload" nests.
  await handleConnectedAccountEvent(supabase, event)

  return NextResponse.json({ received: true })
}

// ---------------------------------------------------------------------------
// Manual signature verifier (fallback)
// ---------------------------------------------------------------------------

function verifyManual(args: {
  webhookId: string
  timestamp: string
  signatureHeader: string
  rawBody: string
  secret: string
}): boolean {
  // Header format: 'v1,<base64>' — there may be multiple space-separated sigs
  const sigs = args.signatureHeader.split(/\s+/)
  const toSign = `${args.webhookId}.${args.timestamp}.${args.rawBody}`

  // Build expected HMAC (both base64 and hex, to be tolerant of encodings)
  const hmac = crypto.createHmac('sha256', args.secret).update(toSign).digest()
  const expectedB64 = hmac.toString('base64')
  const expectedB64Url = hmac.toString('base64url')
  const expectedHex = hmac.toString('hex')

  for (const raw of sigs) {
    const trimmed = raw.replace(/^v\d+,/, '')
    if (safeEq(trimmed, expectedB64)) return true
    if (safeEq(trimmed, expectedB64Url)) return true
    if (safeEq(trimmed, expectedHex)) return true
  }
  return false
}

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Connected-account event handler
// ---------------------------------------------------------------------------

async function handleConnectedAccountEvent(
  supabase: ReturnType<typeof createAdminClient>,
  event: Record<string, unknown>
): Promise<void> {
  // Event types we care about (defensive — shape unstable across versions):
  const type = String(event.type ?? event.event ?? '').toLowerCase()

  const looksLikeAccountEvent =
    type.includes('connected_account') ||
    type.includes('connection') ||
    type.includes('auth')

  if (!looksLikeAccountEvent) return

  // Dig for the connected account object (V1/V2/V3 shapes differ)
  const data = (event.data ?? event.payload ?? {}) as Record<string, unknown>
  const account =
    (data.connectedAccount as Record<string, unknown> | undefined) ??
    (data.connected_account as Record<string, unknown> | undefined) ??
    (data.account as Record<string, unknown> | undefined) ??
    data

  const connectedAccountId = typeof account.id === 'string' ? account.id : null
  if (!connectedAccountId) return

  const local = await getOrgIntegrationByConnectedAccount(supabase, connectedAccountId)
  if (!local) return   // not ours — ignore

  const newStatus = normalizeStatus(account.status as string | undefined)

  await upsertFromComposio(supabase, {
    orgId: local.org_id,
    toolkitSlug: local.toolkit_slug,
    authConfigId: local.auth_config_id,
    connectedAccount: account,
    actorType: 'webhook',
  })

  if (newStatus !== local.status) {
    await logAudit(supabase, {
      orgId: local.org_id,
      actorType: 'webhook',
      action: 'status_changed',
      orgIntegrationId: local.id,
      toolkitSlug: local.toolkit_slug,
      details: { from: local.status, to: newStatus, trigger: 'webhook', event_type: type },
    })
  }
}
