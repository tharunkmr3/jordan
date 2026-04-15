import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding } from './embeddings'

export async function queryKnowledgeBase(
  agentId: string,
  query: string,
  topK = 5
): Promise<string[]> {
  const embedding = await generateEmbedding(query)
  const supabase = createAdminClient()

  const { data, error } = await supabase.rpc('match_kb_chunks', {
    query_embedding: embedding,
    match_agent_id: agentId,
    match_count: topK,
  })

  if (error) {
    console.error('Knowledge base query error:', error)
    return []
  }

  return (data ?? []).map((chunk: { content: string }) => chunk.content)
}
