// ============================================================================
// GET /api/integrations/toolkits/:slug/tools
// Lists the tools (actions) available for a toolkit. Used by the UI to let
// users pick which tools to enable per agent_integration.
//
// Calls Composio's REST API directly — the SDK's tools.get() requires a
// userId and tailors schemas to that user, whereas we need a neutral list.
// ============================================================================

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { authedRequest } from '@/lib/integrations/auth-helpers'

const COMPOSIO_BASE = process.env.COMPOSIO_BASE_URL ?? 'https://backend.composio.dev'

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ slug: string }> }
) {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth

  const { slug } = await ctx.params
  const apiKey = process.env.COMPOSIO_API_KEY
  console.log(`[integrations/tools] called with slug="${slug}", apiKey prefix=${apiKey?.slice(0, 6)}`)
  if (!apiKey) {
    return NextResponse.json({ error: 'COMPOSIO_API_KEY not set' }, { status: 500 })
  }

  const { searchParams } = new URL(request.url)
  const search = searchParams.get('search') ?? ''
  const limit = Math.min(Number(searchParams.get('limit') ?? 200) || 200, 500)

  const url = new URL(`${COMPOSIO_BASE}/api/v3/tools`)
  url.searchParams.set('toolkit_slug', slug)
  url.searchParams.set('limit', String(limit))
  if (search) url.searchParams.set('search', search)

  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[integrations/tools] Composio HTTP ${res.status} for ${slug}:`, body.slice(0, 300))
    return NextResponse.json(
      { error: `Composio returned ${res.status}`, detail: body.slice(0, 500) },
      { status: 502 }
    )
  }

  const payload = (await res.json()) as { items?: unknown[]; next_cursor?: string | null }
  const items = Array.isArray(payload.items) ? payload.items : []
  console.log(`[integrations/tools] ${slug}: Composio returned ${items.length} raw items; upstream url:`, url.toString())

  // Normalize minimal shape for the UI.
  // Note on shape: Composio's /v3/tools response has `deprecated` as an
  // OBJECT of version metadata (displayName, version, is_deprecated, …)
  // — NOT a boolean. The actual deprecation flag lives at top-level
  // `is_deprecated`. Treating `deprecated` as a boolean would filter
  // out every tool.
  type ToolRow = Record<string, unknown> & {
    deprecated?: { displayName?: string; is_deprecated?: boolean } | null
  }
  const tools = items.map((raw) => {
    const t = raw as ToolRow
    const depMeta = (t.deprecated && typeof t.deprecated === 'object') ? t.deprecated : null
    return {
      slug: String(t.slug ?? t.name ?? ''),
      name: String(
        depMeta?.displayName ??
        t.displayName ??
        t.display_name ??
        t.name ??
        t.slug ??
        ''
      ),
      description: typeof t.description === 'string' ? t.description : null,
      deprecated: Boolean(
        (typeof t.is_deprecated === 'boolean' ? t.is_deprecated : false) ||
        depMeta?.is_deprecated === true
      ),
      tags: Array.isArray(t.tags) ? (t.tags as unknown[]).map(String) : [],
    }
  }).filter((t) => t.slug && !t.deprecated)

  if (process.env.NODE_ENV !== 'production' && tools.length === 0 && items.length === 0) {
    return NextResponse.json({
      items: [],
      _debug: {
        upstreamUrl: url.toString(),
        upstreamStatus: res.status,
        upstreamPayloadKeys: Object.keys(payload ?? {}),
      },
    })
  }

  return NextResponse.json({ items: tools })
}
