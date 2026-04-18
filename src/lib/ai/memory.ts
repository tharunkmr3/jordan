// ============================================================================
// Memories — cross-session memory for internal agents
// ============================================================================
//
// Internal agents (agents.settings.is_customer_facing === false) get a memory
// layer that spans conversations. This module owns:
//
//   - queryMemories()      retrieval: semantic search over the user's memories
//                          plus org-shared memories, called from the chat
//                          pipeline alongside the KB lookup.
//   - extractFromTurn()    write path: post-turn fire-and-forget LLM call that
//                          pulls durable facts/preferences/instructions out of
//                          the last user message. Dedupes via embedding
//                          similarity before inserting.
//   - detectExplicitMemoryRequest()  regex for "remember that …" etc., so the
//                          user can force a memory even if the extractor
//                          wouldn't have picked it up.
//
// Customer-facing agents MUST NOT call these. RLS is the UI-side guard; the
// pipeline uses the service role, so the check lives at the call site in
// chat-pipeline.ts.
// ============================================================================

import OpenAI from 'openai'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding } from './embeddings'

export interface MemoryHit {
  id: string
  content: string
  similarity: number
  source: 'auto' | 'explicit' | 'manual'
  isShared: boolean
  importance: number
  createdAt: string
}

export interface MemoryOwner {
  /** auth.users.id of the memory owner (the team member chatting). */
  userId: string
  orgId: string
}

// The extractor prompts a cheap, fast model to decide what (if anything) is
// worth remembering. Kept as a separate OpenAI client from models.ts because
// the prompt/response_format is purpose-built for this pipeline and doesn't
// fit the multi-provider router's signatures.
let _openai: OpenAI | null = null
function openai(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
    _openai = new OpenAI({ apiKey })
  }
  return _openai
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/**
 * Return the top-K memories relevant to the current query, visible to the
 * given (userId, orgId) — own memories plus org-shared memories.
 *
 * Safe to call under the service role because the RPC takes identity as
 * arguments and scopes internally. Any extraction error is swallowed and
 * returns [] so a transient OpenAI blip never kills the chat turn.
 */
export async function queryMemories(
  owner: MemoryOwner,
  query: string,
  topK = 5,
): Promise<MemoryHit[]> {
  try {
    const embedding = await generateEmbedding(query)
    const supabase = createAdminClient()
    const { data, error } = await supabase.rpc('match_memories', {
      query_embedding: embedding,
      p_user_id: owner.userId,
      p_org_id: owner.orgId,
      match_count: topK,
      min_similarity: 0.3,
    })
    if (error) {
      console.error('[memory] match_memories error:', error)
      return []
    }
    type Row = {
      id: string
      content: string
      similarity: number
      source: 'auto' | 'explicit' | 'manual'
      is_shared: boolean
      importance: number
      created_at: string
    }
    return (data as Row[] | null ?? []).map((r) => ({
      id: r.id,
      content: r.content,
      similarity: r.similarity,
      source: r.source,
      isShared: r.is_shared,
      importance: r.importance,
      createdAt: r.created_at,
    }))
  } catch (err) {
    console.error('[memory] queryMemories failed:', err)
    return []
  }
}

/**
 * Format retrieved memories as a system-prompt block. Kept short — each
 * memory is one line. Type hint ("shared" vs the user's own) is conveyed
 * implicitly; the model just needs to know it's durable context about the
 * current user.
 */
export function formatMemoryContext(hits: MemoryHit[]): string {
  if (hits.length === 0) return ''
  return hits
    .map((h) => `- ${h.content}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Regex-sniff the user's message for explicit memory commands ("remember
 * that X", "note that Y", "from now on Z", "always do W"). Returns the
 * extracted directive if matched, else null. Matching a pattern here
 * bypasses the extractor's "is this durable?" gate — user intent is
 * explicit.
 */
export function detectExplicitMemoryRequest(text: string): string | null {
  const patterns = [
    /\b(?:please\s+)?remember(?:\s+that)?[:,]?\s+(.{5,400})/i,
    /\bnote(?:\s+that)?[:,]?\s+(.{5,400})/i,
    /\bfrom now on[:,]?\s+(.{5,400})/i,
    /\balways\s+(.{5,400})/i,
    /\bdon'?t forget(?:\s+that)?[:,]?\s+(.{5,400})/i,
  ]
  for (const rx of patterns) {
    const match = text.match(rx)
    if (match && match[1]) {
      const snippet = match[1].trim().replace(/[.!?]+$/, '').trim()
      if (snippet.length >= 5) return snippet
    }
  }
  return null
}

interface ExtractedMemory {
  content: string
  importance: number
}

interface ExtractionInput {
  owner: MemoryOwner
  lastUserMessage: string
  lastAssistantMessage: string
  sourceMessageId?: string | null
}

/**
 * Post-turn extraction. Runs two LLM calls at most:
 *
 *   1. Extract: one cheap call asking "what durable facts/preferences did
 *      the user just reveal?" JSON-mode with a fixed schema. Empty result
 *      is the common case — most turns don't contain anything worth
 *      remembering.
 *
 *   2. Dedupe: for each candidate, semantic-search the user's existing
 *      memories. If a near-duplicate exists (similarity > 0.88), skip.
 *      No LLM call here — embedding distance is enough to catch "X prefers
 *      Hindi" colliding with "user likes to chat in Hindi".
 *
 * Fire-and-forget from the caller. Errors are logged but never thrown —
 * memory extraction failing must not break the user-visible chat flow.
 */
export async function extractFromTurn(input: ExtractionInput): Promise<void> {
  try {
    const explicit = detectExplicitMemoryRequest(input.lastUserMessage)
    const candidates: ExtractedMemory[] = []

    if (explicit) {
      // Explicit commands bypass extraction entirely — user intent is
      // unambiguous, just persist it verbatim.
      candidates.push({ content: normalizeExtracted(explicit), importance: 8 })
    } else {
      const extracted = await extractWithLLM(
        input.lastUserMessage,
        input.lastAssistantMessage,
      )
      candidates.push(...extracted)
    }

    if (candidates.length === 0) return

    await persistCandidates(
      input.owner,
      candidates,
      explicit ? 'explicit' : 'auto',
      input.sourceMessageId ?? null,
    )
  } catch (err) {
    console.error('[memory] extractFromTurn failed:', err)
  }
}

/**
 * One cheap LLM call to extract durable memories from the latest turn.
 * Returns [] aggressively — the prompt is biased toward skipping
 * ephemeral context because over-extraction pollutes the memory store
 * and makes retrieval noisy.
 */
async function extractWithLLM(
  userMessage: string,
  assistantMessage: string,
): Promise<ExtractedMemory[]> {
  const system = [
    'You extract durable memories about the user from a chat turn.',
    '',
    'RULES:',
    '- Only extract facts, preferences, identity details, projects, goals, or explicit instructions that should persist across future conversations.',
    '- Do NOT extract: questions the user asked, transient task context, greetings, generic observations, anything already general knowledge.',
    '- Each memory is ONE short declarative sentence in third person ("User prefers ...", "User works at ...", "User is building ...").',
    '- Prefer precision over quantity. Most turns should produce an empty list.',
    '- Importance 1-10: preferences/instructions 7-9, personal facts 5-7, mild context 3-4.',
    '',
    'Return JSON: { "memories": [{ "content": string, "importance": number }] }. Empty list is fine.',
  ].join('\n')

  const user = [
    '=== User said ===',
    userMessage,
    '',
    '=== Assistant replied ===',
    assistantMessage,
  ].join('\n')

  try {
    const response = await openai().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_completion_tokens: 400,
    })
    const raw = response.choices[0]?.message?.content ?? '{"memories":[]}'
    const parsed = JSON.parse(raw) as { memories?: ExtractedMemory[] }
    if (!parsed.memories || !Array.isArray(parsed.memories)) return []
    return parsed.memories
      .filter((m) => typeof m?.content === 'string' && m.content.trim().length >= 5)
      .slice(0, 5)
      .map((m) => ({
        content: normalizeExtracted(m.content),
        importance: clampImportance(m.importance),
      }))
  } catch (err) {
    console.error('[memory] extractWithLLM failed:', err)
    return []
  }
}

function normalizeExtracted(s: string): string {
  return s.trim().replace(/\s+/g, ' ').slice(0, 500)
}

function clampImportance(n: unknown): number {
  const v = typeof n === 'number' ? Math.round(n) : 5
  if (v < 1) return 1
  if (v > 10) return 10
  return v
}

/**
 * Embed each candidate, check for a near-duplicate against existing memories
 * for this (user, org), and insert the survivors. The dedupe threshold
 * (0.88 cosine similarity) is tight enough to keep legitimate rephrasings as
 * separate entries but loose enough to catch the obvious duplicates like
 * "User prefers Hindi" vs "User likes to chat in Hindi".
 */
async function persistCandidates(
  owner: MemoryOwner,
  candidates: ExtractedMemory[],
  source: 'auto' | 'explicit',
  sourceMessageId: string | null,
): Promise<void> {
  const supabase = createAdminClient()

  for (const c of candidates) {
    try {
      const embedding = await generateEmbedding(c.content)

      // Fast dedupe via the same RPC the read path uses. If any existing
      // memory scores above the threshold, skip — don't re-insert.
      const { data: existing } = await supabase.rpc('match_memories', {
        query_embedding: embedding,
        p_user_id: owner.userId,
        p_org_id: owner.orgId,
        match_count: 1,
        min_similarity: 0.88,
      })

      if (Array.isArray(existing) && existing.length > 0) {
        console.log('[memory] dedupe skipped:', c.content, '→ matches', (existing[0] as { content: string }).content)
        continue
      }

      const { error } = await supabase
        .from('memories')
        .insert({
          org_id: owner.orgId,
          user_id: owner.userId,
          content: c.content,
          embedding,
          is_shared: false,
          source,
          importance: c.importance,
          source_message_id: sourceMessageId,
        })
      if (error) console.error('[memory] insert failed:', error)
      else console.log('[memory] saved:', source, c.content)
    } catch (err) {
      console.error('[memory] persist candidate failed:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Manual CRUD (used by /api/memories routes + the Memories page)
// ---------------------------------------------------------------------------

/**
 * Insert a memory created manually from the Memories page. Generates an
 * embedding so the new row is immediately searchable. Caller is responsible
 * for auth — this accepts owner identity from a verified session.
 */
export async function createMemoryManual(
  owner: MemoryOwner,
  content: string,
  isShared: boolean,
): Promise<{ id: string } | { error: string }> {
  const trimmed = normalizeExtracted(content)
  if (trimmed.length < 3) return { error: 'Memory is too short' }

  try {
    const embedding = await generateEmbedding(trimmed)
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('memories')
      .insert({
        org_id: owner.orgId,
        user_id: owner.userId,
        content: trimmed,
        embedding,
        is_shared: isShared,
        source: 'manual',
        importance: 7,
      })
      .select('id')
      .single()

    if (error) return { error: error.message }
    return { id: data.id as string }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to save memory' }
  }
}

/**
 * Update content (regenerate embedding) and/or sharing flag. Null means
 * "don't change". Returns the updated row or an error.
 */
export async function updateMemoryFields(
  owner: MemoryOwner,
  memoryId: string,
  patch: { content?: string; isShared?: boolean },
): Promise<{ ok: true } | { error: string }> {
  const supabase = createAdminClient()

  const update: Record<string, unknown> = {}
  if (patch.content !== undefined) {
    const trimmed = normalizeExtracted(patch.content)
    if (trimmed.length < 3) return { error: 'Memory is too short' }
    try {
      update.content = trimmed
      update.embedding = await generateEmbedding(trimmed)
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Embedding failed' }
    }
  }
  if (patch.isShared !== undefined) {
    update.is_shared = patch.isShared
  }

  if (Object.keys(update).length === 0) return { ok: true }

  const { error } = await supabase
    .from('memories')
    .update(update)
    .eq('id', memoryId)
    .eq('user_id', owner.userId) // defensive — owner check

  if (error) return { error: error.message }
  return { ok: true }
}
