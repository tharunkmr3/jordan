// ============================================================================
// Jordon AI — Composio toolkit catalog
// DB-backed cache of Composio's toolkit list (500+ rows). Refreshed by
// the bootstrap script + a scheduled reconcile job. Read-heavy.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ComposioToolkitCache } from '@/types/database'
import { getComposio } from './client'

export interface ToolkitListFilters {
  search?: string
  categories?: string[]
  hasAuth?: boolean           // exclude no-auth toolkits (usually desired)
  limit?: number
  offset?: number
}

export interface ToolkitListResult {
  items: ComposioToolkitCache[]
  total: number
}

/**
 * Read toolkits from the DB cache. Expects cache to be populated by the
 * bootstrap script / reconcile job. Callers should handle empty cache
 * with a helpful "catalog still loading" message.
 */
export async function listToolkits(
  supabase: SupabaseClient,
  filters: ToolkitListFilters = {}
): Promise<ToolkitListResult> {
  let query = supabase
    .from('composio_toolkits_cache')
    .select('*', { count: 'exact' })
    .order('tools_count', { ascending: false })
    .order('name', { ascending: true })

  if (filters.hasAuth) {
    query = query.eq('no_auth', false)
  }
  if (filters.categories && filters.categories.length > 0) {
    query = query.overlaps('categories', filters.categories)
  }
  if (filters.search && filters.search.trim()) {
    const s = filters.search.trim()
    query = query.or(`name.ilike.%${s}%,description.ilike.%${s}%,slug.ilike.%${s}%`)
  }

  const limit = Math.min(filters.limit ?? 50, 200)
  const offset = filters.offset ?? 0
  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query
  if (error) {
    console.error('[composio/toolkits] listToolkits failed:', error)
    return { items: [], total: 0 }
  }
  return { items: (data ?? []) as ComposioToolkitCache[], total: count ?? 0 }
}

export async function getToolkit(
  supabase: SupabaseClient,
  slug: string
): Promise<ComposioToolkitCache | null> {
  const { data, error } = await supabase
    .from('composio_toolkits_cache')
    .select('*')
    .eq('slug', slug)
    .maybeSingle()
  if (error) {
    console.error('[composio/toolkits] getToolkit failed:', error)
    return null
  }
  return (data as ComposioToolkitCache) ?? null
}

/**
 * Fetch the full toolkit catalog from Composio and upsert into the cache.
 * Called by the bootstrap script + the nightly reconcile cron.
 *
 * Returns the count of toolkits written.
 */
export async function refreshToolkitCache(
  supabase: SupabaseClient
): Promise<{ inserted: number; errors: number }> {
  // The SDK's toolkits.get() returns a flat array (capped at 100 per call)
  // and swallows the nextCursor from the API response. For a full catalog
  // refresh we bypass the SDK and paginate the REST API directly.
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) throw new Error('COMPOSIO_API_KEY not set')

  const baseUrl = process.env.COMPOSIO_BASE_URL ?? 'https://backend.composio.dev'
  let inserted = 0
  let errors = 0
  let cursor: string | null = null
  const LIMIT = 100
  const MAX_PAGES = 30

  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(`${baseUrl}/api/v3/toolkits`)
    url.searchParams.set('limit', String(LIMIT))
    url.searchParams.set('sort_by', 'usage')
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString(), {
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[composio/toolkits] toolkit list HTTP ${res.status}: ${body.slice(0, 300)}`)
      errors += 1
      break
    }

    const payload = (await res.json()) as {
      items?: unknown[]
      next_cursor?: string | null
      nextCursor?: string | null
    }

    const items = Array.isArray(payload.items) ? payload.items : []
    if (items.length === 0) break

    const rows = items.map((raw) => toolkitToCacheRow(raw))
    const { error } = await supabase
      .from('composio_toolkits_cache')
      .upsert(rows, { onConflict: 'slug' })

    if (error) {
      console.error('[composio/toolkits] refresh batch failed:', error)
      errors += rows.length
    } else {
      inserted += rows.length
    }

    cursor = payload.next_cursor ?? payload.nextCursor ?? null
    if (!cursor) break
  }

  return { inserted, errors }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolkitToCacheRow(raw: unknown): Omit<ComposioToolkitCache, 'fetched_at'> {
  // Composio returns camelCase from SDK, snake_case from REST. Accept both.
  const t = raw as Record<string, unknown>
  const meta = (t.meta ?? {}) as Record<string, unknown>
  const authConfigDetails = (t.authConfigDetails ?? t.auth_config_details ?? []) as Array<Record<string, unknown>>

  const slug = String(t.slug ?? '')
  const name = String(t.name ?? slug)
  const description =
    typeof meta.description === 'string' ? meta.description :
    typeof t.description === 'string' ? t.description : null
  const logoUrl =
    typeof meta.logo === 'string' ? meta.logo :
    typeof t.logo === 'string' ? t.logo : null

  const rawCats = (meta.categories ?? t.categories ?? []) as unknown[]
  const categories = rawCats
    .map((c) => {
      if (typeof c === 'string') return c
      if (c && typeof c === 'object' && 'slug' in (c as object)) return String((c as Record<string, unknown>).slug)
      return ''
    })
    .filter(Boolean)

  const authSchemes = authConfigDetails
    .map((a) => (a.mode ?? a.authScheme ?? a.auth_scheme ?? a.type))
    .filter(Boolean)
    .map(String)

  const rawTags = (meta.tags ?? t.tags ?? []) as unknown[]
  const tags = rawTags.map(String).filter(Boolean)

  const toolsCount = pickNumber(meta.toolsCount, meta.tools_count, t.toolsCount, t.tools_count)
  const noAuth = Boolean(t.noAuth ?? t.no_auth ?? false)
  const isLocal = Boolean(t.isLocal ?? t.is_local ?? false)

  return {
    slug,
    name,
    description,
    logo_url: logoUrl,
    categories,
    auth_schemes: authSchemes,
    no_auth: noAuth,
    is_local: isLocal,
    tools_count: toolsCount,
    tags,
    raw: t as Record<string, unknown>,
  }
}

function pickNumber(...vals: unknown[]): number {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return 0
}
