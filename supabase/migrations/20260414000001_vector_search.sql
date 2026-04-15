CREATE OR REPLACE FUNCTION match_kb_chunks(
  query_embedding vector(1536),
  match_agent_id uuid,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  content text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    1 - (kc.embedding <=> query_embedding) as similarity
  FROM kb_chunks kc
  JOIN knowledge_bases kb ON kc.kb_id = kb.id
  WHERE kb.agent_id = match_agent_id
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
