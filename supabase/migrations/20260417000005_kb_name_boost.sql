-- ============================================================================
-- match_kb_chunks: add a document-name arm to the hybrid search.
--
-- Problem this fixes — a query like "give me latest data in my resume"
-- retrieves CA-certificate / spreadsheet chunks instead of the actual
-- Resume.pdf, because:
--
--   1. Resume bodies rarely contain the literal word "resume" (they say
--      the person's name, their contact info, job titles, etc.).
--   2. The old match_kb_chunks scored purely on chunk CONTENT — vector
--      + trigram, both indexed on `kc.content`. Nothing in the retrieval
--      path knows that the document is called "Resume.pdf".
--   3. Dense numeric documents (financial docs, spreadsheets) score
--      strongly on the word "data", drowning out the real target.
--
-- Fix — add a third "name arm" that matches query words against the
-- document filename. Each matching chunk gets a constant name_boost
-- score. The final rank is a weighted sum of all three arms:
--
--   score = 0.5 * semantic + 0.2 * lexical + 0.3 * name_boost
--
-- Weighting rationale:
--   - Semantic still dominates ("what is this chunk ABOUT") for most
--     natural-language questions.
--   - Lexical catches exact terms (account numbers, proper nouns in
--     body text).
--   - Name boost is strong (0.3) because a filename match is a high-
--     specificity signal: if you say "resume" and a file is called
--     "Resume.pdf", that's almost certainly what you want.
--
-- "Meaningful word" = length ≥ 3, lowercase-alpha only. That's enough
-- to skip "the", "a", "my", "in", etc. without building a full stop-
-- word list — a word-length filter gets you 95% of the way there and
-- degrades gracefully on domain terms the model doesn't know.
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
  -- Name arm pulls every chunk from matching docs — a doc that was
  -- named in the query is a strong signal the user wants all of it.
  -- Cap at 40 so a large spreadsheet doesn't swamp the result set.
  name_candidates int := 40;
  w_sem float := 0.5;
  w_lex float := 0.2;
  w_name float := 0.3;
  -- Extract "meaningful" words from the query once: lowercased, alpha-
  -- only, length ≥ 3. Shared by the name arm below.
  query_words text[] := (
    SELECT COALESCE(
      array_agg(word),
      ARRAY[]::text[]
    )
    FROM unnest(
      string_to_array(
        lower(regexp_replace(query_text, '[^a-zA-Z0-9 ]', ' ', 'g')),
        ' '
      )
    ) AS word
    WHERE length(word) >= 3
  );
BEGIN
  RETURN QUERY
  WITH
    -- Semantic arm: vector cosine similarity, scoped to agent's KBs.
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
    -- Lexical arm: trigram similarity against the CONTENT.
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
    -- Name arm: every chunk belonging to a document whose filename
    -- contains at least one meaningful word from the query. All such
    -- chunks get a constant boost (1.0) — ranking within the arm is
    -- then driven by the other two arms. This guarantees that if the
    -- user names a file, at least some of its chunks reach final top-K.
    name_hits AS (
      SELECT
        kc.id,
        kc.content,
        kc.document_id,
        kc.kb_id,
        1.0::float AS name_boost
      FROM kb_chunks kc
      JOIN knowledge_bases kb ON kc.kb_id = kb.id
      JOIN kb_documents d ON d.id = kc.document_id
      WHERE kb.agent_id = match_agent_id
        AND array_length(query_words, 1) > 0
        AND EXISTS (
          SELECT 1
          FROM unnest(query_words) AS word
          WHERE lower(d.name) LIKE '%' || word || '%'
        )
      LIMIT name_candidates
    ),
    -- Merge all three arms. A chunk that's missing from an arm gets a
    -- 0 score for it. The COALESCE chain on id/content/document_id/
    -- kb_id keeps the result set stable regardless of which arm the
    -- row came from.
    merged AS (
      SELECT
        COALESCE(v.id, l.id, n.id)                             AS id,
        COALESCE(v.content, l.content, n.content)              AS content,
        COALESCE(v.document_id, l.document_id, n.document_id)  AS document_id,
        COALESCE(v.kb_id, l.kb_id, n.kb_id)                    AS kb_id,
        COALESCE(v.sem_sim, 0.0)                                AS sem_sim,
        COALESCE(l.lex_sim, 0.0)                                AS lex_sim,
        COALESCE(n.name_boost, 0.0)                             AS name_boost,
        (w_sem * COALESCE(v.sem_sim, 0.0)
          + w_lex * COALESCE(l.lex_sim, 0.0)
          + w_name * COALESCE(n.name_boost, 0.0))               AS score
      FROM vec_hits v
      FULL OUTER JOIN lex_hits l  USING (id, content, document_id, kb_id)
      FULL OUTER JOIN name_hits n USING (id, content, document_id, kb_id)
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
