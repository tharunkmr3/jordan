import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding } from './embeddings'
import { rerank } from './rerank'

/**
 * A single KB chunk retrieved by hybrid search, with enough metadata
 * attached to render a clickable source citation in the chat UI and
 * deep-link back to the originating document in the KB viewer.
 */
export interface KbSource {
  /** chunk id — stable identifier per retrieved passage */
  id: string
  /** raw chunk text the agent saw as context */
  content: string
  /** weighted semantic + lexical score (0..1) */
  similarity: number
  /** fk to kb_documents.id — used to open the viewer */
  documentId: string
  /** human-readable filename for the chip label */
  documentName: string
  /** fk to knowledge_bases.id — used by the knowledge page to navigate */
  kbId: string
}

/**
 * Hybrid knowledge-base search: semantic vector similarity unioned with
 * pg_trgm lexical similarity. The RPC `match_kb_chunks` takes both the
 * query embedding and the raw query text, re-ranks them by a weighted
 * score, and returns the top-K chunks with document metadata.
 *
 * Returns `KbSource[]` so callers can both:
 *   - feed chunk content to the LLM as RAG context
 *   - show clickable source chips under the assistant's reply
 */
export async function queryKnowledgeBase(
  agentId: string,
  query: string,
  topK = 8
): Promise<KbSource[]> {
  const embedding = await generateEmbedding(query)
  const supabase = createAdminClient()

  // Pull a WIDER candidate pool than the final topK — the reranker below
  // needs headroom to pick cleanly. A pool of ~30 is the standard RAG
  // practice: large enough for the cross-encoder to find the right hit
  // even when bi-encoder search misses it, small enough to stay under
  // Voyage's 1s latency target for a reranker call.
  const POOL = Math.max(topK * 4, 30)
  const { data, error } = await supabase.rpc('match_kb_chunks', {
    query_embedding: embedding,
    match_agent_id: agentId,
    match_count: POOL,
    query_text: query,
  })

  if (error) {
    console.error('Knowledge base query error:', error)
    return []
  }

  type Row = {
    id: string
    content: string
    similarity: number
    document_id: string
    document_name: string
    kb_id: string
  }

  const pool: KbSource[] = (data as Row[] | null ?? []).map((row) => ({
    id: row.id,
    content: row.content,
    similarity: row.similarity,
    documentId: row.document_id,
    documentName: row.document_name,
    kbId: row.kb_id,
  }))

  if (pool.length === 0) return []

  // Cross-encoder rerank: scores (query, chunk) jointly via Voyage
  // rerank-2.5 and returns a reordered top-K. When VOYAGE_API_KEY is
  // unset this returns null and we fall back to the hybrid score order.
  //
  // We feed the reranker a "document-aware" content representation —
  // prepending the filename so chunks from named files don't get
  // outscored by purely-semantic matches. This is the text-level sibling
  // of the name_boost arm in the SQL hybrid search.
  const reranked = await rerank({
    query,
    documents: pool.map((s) => ({
      id: s.id,
      content: `[${s.documentName}]\n${s.content}`,
    })),
    topK,
  })

  if (!reranked) {
    // Reranker unavailable or failed — use pre-rerank order, still
    // honoring the requested topK.
    return pool.slice(0, topK)
  }

  // Map reranked ids back to the full KbSource (with documentId/kbId).
  // Replace similarity with the cross-encoder score so the downstream
  // noise-filter (buildMessageSources) has the authoritative relevance
  // number to work with.
  const byId = new Map(pool.map((s) => [s.id, s]))
  const hits: KbSource[] = []
  for (const r of reranked) {
    const base = byId.get(r.id)
    if (!base) continue
    hits.push({ ...base, similarity: r.score })
  }
  return hits
}

/**
 * List every document name the agent's knowledge base contains.
 *
 * Why this exists — the retrieved Chunk[] that RAG feeds the LLM is a
 * response to THIS query, not an inventory of what the agent has
 * access to. Without a file list in the system prompt the agent
 * cannot answer "do you have my resume?" truthfully; it treats the
 * retrieved chunks as if they were the complete set and says "I only
 * see four files" when the KB holds eight.
 *
 * Returns `[]` (not null) so buildPrompt can call it unconditionally
 * without branching on failure. We cap at 100 documents to keep the
 * system prompt bounded — past that, we'd need a searchable file-
 * list tool anyway.
 */
export async function listKbDocuments(agentId: string): Promise<string[]> {
  const supabase = createAdminClient()
  try {
    const { data, error } = await supabase
      .from('kb_documents')
      .select('name, knowledge_bases!inner(agent_id)')
      .eq('knowledge_bases.agent_id', agentId)
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) {
      console.error('[kb] listKbDocuments failed:', error)
      return []
    }
    return (data ?? []).map((d: { name: string }) => d.name)
  } catch (err) {
    console.error('[kb] listKbDocuments threw:', err)
    return []
  }
}
