import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding } from './embeddings'

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

  const { data, error } = await supabase.rpc('match_kb_chunks', {
    query_embedding: embedding,
    match_agent_id: agentId,
    match_count: topK,
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

  return (data as Row[] | null ?? []).map((row) => ({
    id: row.id,
    content: row.content,
    similarity: row.similarity,
    documentId: row.document_id,
    documentName: row.document_name,
    kbId: row.kb_id,
  }))
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
