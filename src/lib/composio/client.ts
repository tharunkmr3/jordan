// ============================================================================
// Jordon AI — Composio SDK client singleton
// Lazy-initialized to avoid build-time errors when env vars are absent.
// ============================================================================

import { Composio } from '@composio/core'

let _composio: Composio | null = null

/**
 * Returns a process-wide singleton Composio client.
 * Throws at first call if COMPOSIO_API_KEY is missing — callers should treat
 * this as a hard configuration error and surface a clear message.
 */
export function getComposio(): Composio {
  if (_composio) return _composio

  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) {
    throw new Error(
      'COMPOSIO_API_KEY is not set. Add it to .env.local (local) or Coolify env (prod).'
    )
  }

  _composio = new Composio({
    apiKey,
    allowTracking: process.env.NODE_ENV === 'production',
    // Suppress console noise on cold start in serverless routes.
    disableVersionCheck: true,
  })
  return _composio
}

/**
 * Stable identity passed as Composio's `userId`. We scope at the ORG level,
 * not the agent or user level, so a single OAuth connection can be shared
 * across agents in the same org. The org_id is a UUID — prefix it to make
 * it obvious in Composio dashboards what identity space this is.
 */
export function composioUserIdForOrg(orgId: string): string {
  return `org_${orgId}`
}
