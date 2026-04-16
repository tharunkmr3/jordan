/**
 * Composio bootstrap
 * ------------------
 * Idempotent one-shot (run once, re-run safely) that:
 *   1. Refreshes composio_toolkits_cache from the live Composio catalog.
 *   2. Ensures platform-default composio_auth_configs rows for a seed list
 *      of popular toolkits, creating Composio-managed auth configs where
 *      missing.
 *
 * Usage:
 *   npm run composio:bootstrap
 *
 * Requires env vars:
 *   COMPOSIO_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Reads .env.local automatically via dotenv.
 */

import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })
loadEnv() // fallback to .env

import { createClient } from '@supabase/supabase-js'
import { refreshToolkitCache } from '../src/lib/composio/toolkits'
import { ensureAuthConfig } from '../src/lib/composio/auth-configs'

// Seed list of toolkits that get a platform-default auth config on bootstrap.
// Adding here just ensures an auth config exists; users still connect per-org.
// Composio-managed OAuth only. Toolkits that require merchant/custom OAuth
// (e.g. shopify) are skipped here — orgs configure those via per-org auth
// configs when needed.
const SEED_TOOLKITS = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'googledocs',
  'googlesheets',
  'slack',
  'notion',
  'github',
  'hubspot',
  'linear',
  'stripe',
  'airtable',
  'zoom',
]

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const composioKey = process.env.COMPOSIO_API_KEY

  if (!supabaseUrl || !supabaseKey) {
    console.error('[bootstrap] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  if (!composioKey) {
    console.error('[bootstrap] Missing COMPOSIO_API_KEY')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ---- 1. Refresh toolkit cache --------------------------------------------
  console.log('[bootstrap] Refreshing toolkit cache...')
  try {
    const { inserted, errors } = await refreshToolkitCache(supabase)
    console.log(`[bootstrap] Toolkit cache: ${inserted} upserted, ${errors} errors`)
  } catch (err) {
    console.error('[bootstrap] Toolkit cache refresh failed:', err)
    // Continue — we can still seed auth configs.
  }

  // ---- 2. Seed platform-default auth configs -------------------------------
  console.log('[bootstrap] Ensuring seed auth configs...')
  let ok = 0
  let failed = 0
  for (const slug of SEED_TOOLKITS) {
    try {
      const config = await ensureAuthConfig(supabase, slug, {
        orgId: null,
        displayName: `Jordon AI (${slug})`,
      })
      console.log(`  [${slug}] ok — ${config.composioAuthConfigId}`)
      ok++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  [${slug}] FAILED: ${msg}`)
      failed++
    }
  }

  console.log(`[bootstrap] Done. ${ok} auth configs ready, ${failed} failed.`)
  if (failed > 0) process.exit(2)
}

main().catch((err) => {
  console.error('[bootstrap] Fatal:', err)
  process.exit(1)
})
