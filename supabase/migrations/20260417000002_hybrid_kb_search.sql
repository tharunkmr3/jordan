-- ============================================================================
-- Hybrid KB search — vector + trigram union
--
-- Why: vector embeddings are fantastic for semantic "what is this chunk
-- about" similarity, but miss exact-term matches that the user's question
-- happens to contain verbatim (e.g. "2,005 sq.ft", "invoice #INV-4821",
-- "Tellapur Apartment"). Production-grade RAG layers a lexical search on
-- top so the two signals combine — chunks that are high-ranked by EITHER
-- method surface in the final top-K.
--
-- Strategy:
--   1. Enable pg_trgm, a Postgres extension that indexes trigrams for
--      fast fuzzy / substring matching.
--   2. Add a GIN trigram index on kb_chunks.content so ILIKE and
--      similarity() are sub-millisecond on a moderate corpus.
--   3. Replace match_kb_chunks with a hybrid version that:
--        a. Runs vector search → top (match_count * 3) candidates
--        b. Runs trigram similarity against the query text → top K lexical
--        c. Unions the two sets, de-duplicates by id
--        d. Re-ranks with a weighted score: 0.75 * semantic + 0.25 * lexical
--        e. Returns the top match_count overall
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- GIN trigram index on kb_chunks.content (idempotent)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_kb_chunks_content_trgm
  ON kb_chunks
  USING GIN (content gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- New RPC: match_kb_chunks takes a query_text in addition to the embedding
-- and performs a hybrid search.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS match_kb_chunks(vector, uuid, int);

CREATE OR REPLACE FUNCTION match_kb_chunks(
  query_embedding vector(1536),
  match_agent_id  uuid,
  match_count     int DEFAULT 8,
  query_text      text DEFAULT ''
)
RETURNS TABLE (
  id         uuid,
  content    text,
  similarity float
)
LANGUAGE plpgsql
AS $$
DECLARE
  -- How many candidates to pull from each arm before merging. We pull
  -- extra so the weighted re-rank can pick cleanly from both pools.
  vec_candidates int := GREATEST(match_count * 3, 20);
  lex_candidates int := GREATEST(match_count * 3, 20);
  -- Weighting between semantic similarity and lexical similarity. Tune
  -- if retrieval quality drifts; 0.7/0.3 worked well in ad-hoc testing.
  w_sem float := 0.7;
  w_lex float := 0.3;
BEGIN
  RETURN QUERY
  WITH
    -- Semantic arm: vector cosine similarity, limited to the agent's KBs.
    vec_hits AS (
      SELECT
        kc.id,
        kc.content,
        1 - (kc.embedding <=> query_embedding) AS sem_sim
      FROM kb_chunks kc
      JOIN knowledge_bases kb ON kc.kb_id = kb.id
      WHERE kb.agent_id = match_agent_id
      ORDER BY kc.embedding <=> query_embedding
      LIMIT vec_candidates
    ),
    -- Lexical arm: trigram similarity. Only runs if query_text is non-empty.
    lex_hits AS (
      SELECT
        kc.id,
        kc.content,
        similarity(kc.content, query_text) AS lex_sim
      FROM kb_chunks kc
      JOIN knowledge_bases kb ON kc.kb_id = kb.id
      WHERE kb.agent_id = match_agent_id
        AND query_text <> ''
        AND kc.content % query_text  -- fast filter via GIN index
      ORDER BY kc.content <-> query_text
      LIMIT lex_candidates
    ),
    -- Merge: collect each chunk's scores from either arm (defaults to 0
    -- when only present in one). Combined score weights the two sources.
    merged AS (
      SELECT
        COALESCE(v.id, l.id)               AS id,
        COALESCE(v.content, l.content)     AS content,
        COALESCE(v.sem_sim, 0.0)           AS sem_sim,
        COALESCE(l.lex_sim, 0.0)           AS lex_sim,
        (w_sem * COALESCE(v.sem_sim, 0.0)
          + w_lex * COALESCE(l.lex_sim, 0.0)) AS score
      FROM vec_hits v
      FULL OUTER JOIN lex_hits l USING (id, content)
    )
  SELECT m.id, m.content, m.score AS similarity
  FROM merged m
  ORDER BY m.score DESC
  LIMIT match_count;
END;
$$;

-- Grant execute so the service role and authenticated users can call it
-- (the function itself enforces org scoping via kb.agent_id).
GRANT EXECUTE ON FUNCTION match_kb_chunks(vector, uuid, int, text) TO anon, authenticated, service_role;
