-- ============================================================================
-- match_kb_chunks: return document + KB metadata so the chat UI can
-- render source citations (clickable chips linking back to the KB doc).
--
-- Previously returned { id, content, similarity }. Now also returns:
--   - document_id    — lets the client deep-link to the viewer
--   - document_name  — what shows on the chip
--   - kb_id          — needed to route to the right KB detail view
-- ============================================================================

DROP FUNCTION IF EXISTS match_kb_chunks(vector, uuid, int, text);

CREATE OR REPLACE FUNCTION match_kb_chunks(
  query_embedding vector(1536),
  match_agent_id  uuid,
  match_count     int DEFAULT 8,
  query_text      text DEFAULT ''
)
RETURNS TABLE (
  id            uuid,
  content       text,
  similarity    float,
  document_id   uuid,
  document_name text,
  kb_id         uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
  vec_candidates int := GREATEST(match_count * 3, 20);
  lex_candidates int := GREATEST(match_count * 3, 20);
  w_sem float := 0.7;
  w_lex float := 0.3;
BEGIN
  RETURN QUERY
  WITH
    vec_hits AS (
      SELECT
        kc.id,
        kc.content,
        kc.document_id,
        kc.kb_id,
        1 - (kc.embedding <=> query_embedding) AS sem_sim
      FROM kb_chunks kc
      JOIN knowledge_bases kb ON kc.kb_id = kb.id
      WHERE kb.agent_id = match_agent_id
      ORDER BY kc.embedding <=> query_embedding
      LIMIT vec_candidates
    ),
    lex_hits AS (
      SELECT
        kc.id,
        kc.content,
        kc.document_id,
        kc.kb_id,
        similarity(kc.content, query_text) AS lex_sim
      FROM kb_chunks kc
      JOIN knowledge_bases kb ON kc.kb_id = kb.id
      WHERE kb.agent_id = match_agent_id
        AND query_text <> ''
        AND kc.content % query_text
      ORDER BY kc.content <-> query_text
      LIMIT lex_candidates
    ),
    merged AS (
      SELECT
        COALESCE(v.id, l.id)           AS id,
        COALESCE(v.content, l.content) AS content,
        COALESCE(v.document_id, l.document_id) AS document_id,
        COALESCE(v.kb_id, l.kb_id)     AS kb_id,
        COALESCE(v.sem_sim, 0.0)       AS sem_sim,
        COALESCE(l.lex_sim, 0.0)       AS lex_sim,
        (w_sem * COALESCE(v.sem_sim, 0.0)
          + w_lex * COALESCE(l.lex_sim, 0.0)) AS score
      FROM vec_hits v
      FULL OUTER JOIN lex_hits l USING (id, content, document_id, kb_id)
    )
  SELECT
    m.id,
    m.content,
    m.score AS similarity,
    m.document_id,
    d.name  AS document_name,
    m.kb_id
  FROM merged m
  JOIN kb_documents d ON d.id = m.document_id
  ORDER BY m.score DESC
  LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION match_kb_chunks(vector, uuid, int, text) TO anon, authenticated, service_role;
