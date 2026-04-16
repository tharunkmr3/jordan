/**
 * Composio reconcile
 * ------------------
 * Periodic (every 6h recommended):
 *   1. Refresh toolkit cache.
 *   2. Re-sync status of all non-terminal org_integrations against Composio.
 *   3. Delete expired pending connect sessions (> 15 min).
 *   4. Prune integration_tool_calls older than RETENTION_DAYS (default 90).
 *
 * Usage:
 *   npm run composio:reconcile
 *
 * Schedule via Coolify's cron (daily is fine during early scale).
 */

import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })
loadEnv()

import { createClient } from '@supabase/supabase-js'
import { refreshToolkitCache } from '../src/lib/composio/toolkits'
import { reconcileOrgIntegrations } from '../src/lib/composio/accounts'

const RETENTION_DAYS = Number(process.env.INTEGRATION_TOOL_CALLS_RETENTION_DAYS ?? '90')

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey || !process.env.COMPOSIO_API_KEY) {
    console.error('[reconcile] Missing required env vars')
    process.exit(1)
  }
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log('[reconcile] Refreshing toolkit cache...')
  const cache = await refreshToolkitCache(supabase).catch((e) => {
    console.error('[reconcile] cache error:', e)
    return { inserted: 0, errors: 1 }
  })
  console.log(`[reconcile] cache: ${cache.inserted} upserted, ${cache.errors} errors`)

  console.log('[reconcile] Reconciling org_integrations...')
  const rec = await reconcileOrgIntegrations(supabase)
  console.log(`[reconcile] integrations: ${rec.synced} synced, ${rec.errors} errors`)

  console.log('[reconcile] Cleaning expired connect sessions...')
  const { error: e1, count: c1 } = await supabase
    .from('integration_connect_sessions')
    .delete({ count: 'exact' })
    .lt('expires_at', new Date().toISOString())
    .eq('status', 'pending')
  if (e1) console.error('[reconcile] session cleanup error:', e1)
  else console.log(`[reconcile] sessions: ${c1 ?? 0} expired rows removed`)

  console.log(`[reconcile] Pruning tool_calls older than ${RETENTION_DAYS} days...`)
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString()
  const { error: e2, count: c2 } = await supabase
    .from('integration_tool_calls')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff)
  if (e2) console.error('[reconcile] tool_calls prune error:', e2)
  else console.log(`[reconcile] tool_calls: ${c2 ?? 0} rows pruned`)

  console.log('[reconcile] Done.')
}

main().catch((err) => {
  console.error('[reconcile] Fatal:', err)
  process.exit(1)
})
