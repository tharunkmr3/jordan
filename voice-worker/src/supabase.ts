// ============================================================================
// Supabase — pull agent row that drives a given voice call.
// ============================================================================
//
// The main Next.js app owns the schema (agents table) and UI for editing
// configs. The voice worker is read-only: it pulls the row on demand at
// call start, renders the system prompt, and hands everything else over
// to LiveKit Agents.
//
// A thin wrapper around the supabase-js client — no caching yet because
// (a) a fresh row per call is cheap and (b) the operator might edit the
// agent mid-call; stale cached config would produce a jarring shift on
// the next turn.
// ============================================================================

import { createClient } from '@supabase/supabase-js'

export interface AgentConfig {
  id: string
  name: string
  system_prompt: string
  language: string
  voice_id: string
  greeting_message: string
  fallback_message?: string | null
  max_tokens?: number | null
}

let _client: ReturnType<typeof createClient> | null = null

function getClient() {
  if (_client) return _client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set')
  // We never speak to Supabase as an end-user — the worker runs as a
  // trusted backend, so service role is correct. Persists no session
  // because we're not authenticating users; every call is a one-shot
  // read.
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _client
}

/**
 * Fetch the agent row for a given id. Throws on not-found so the
 * worker can surface a clear failure instead of silently running with
 * empty prompt.
 */
export async function loadAgentConfig(agentId: string): Promise<AgentConfig> {
  const { data, error } = await getClient()
    .from('agents')
    .select('id, name, system_prompt, language, voice_id, greeting_message, fallback_message, max_tokens')
    .eq('id', agentId)
    .single()

  if (error || !data) {
    throw new Error(`[voice-worker] Agent ${agentId} not found: ${error?.message ?? 'no row'}`)
  }

  return {
    id: data.id as string,
    name: (data.name as string) ?? 'Jordon',
    system_prompt: (data.system_prompt as string) ?? 'You are a helpful assistant.',
    language: (data.language as string) ?? 'en',
    voice_id: (data.voice_id as string) ?? 'priya',
    greeting_message: (data.greeting_message as string) ?? `Hello, how can I help you?`,
    fallback_message: (data.fallback_message as string | null) ?? null,
    max_tokens: (data.max_tokens as number | null) ?? 220,
  }
}
