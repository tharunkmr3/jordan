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
