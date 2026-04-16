// ============================================================================
// GET /api/integrations/toolkits
// Returns paginated toolkit catalog from composio_toolkits_cache.
// Any authenticated org member can browse.
// ============================================================================

import { NextResponse } from 'next/server'
import { authedRequest } from '@/lib/integrations/auth-helpers'
import { listToolkits } from '@/lib/composio/toolkits'

export async function GET(request: Request) {
  const auth = await authedRequest()
  if (auth instanceof NextResponse) return auth
  const { supabase } = auth

  const { searchParams } = new URL(request.url)
  const search = searchParams.get('search') ?? undefined
  const categoriesParam = searchParams.get('categories')
  const categories = categoriesParam ? categoriesParam.split(',').filter(Boolean) : undefined
  const hasAuth = searchParams.get('hasAuth') !== 'false'  // default true
  const limit = Math.min(Number(searchParams.get('limit') ?? 50) || 50, 200)
  const offset = Number(searchParams.get('offset') ?? 0) || 0

  const result = await listToolkits(supabase, { search, categories, hasAuth, limit, offset })
  return NextResponse.json(result)
}
