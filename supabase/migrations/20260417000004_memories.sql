-- ============================================================================
-- Memories — cross-session agent memory for internal agents
-- ============================================================================
--
-- Scope model:
--   - Every memory belongs to a specific auth user (the "owner") inside an org.
--   - Default visibility is private: only the owner's internal-agent chats can
--     surface it.
--   - Owner can flip `is_shared = true` to share org-wide; then any internal
--     agent chatting with any member of that org can see it.
--
-- Only internal agents (agents.settings->>'is_customer_facing' = 'false') read
-- or write memories. Customer-facing agents never touch this table — that's
-- enforced in application code (src/lib/ai/memory.ts), not in RLS, because the
-- chat pipeline runs with the service role and RLS is bypassed there. RLS on
-- this table governs the CRUD UI and user-initiated access only.
-- ============================================================================

CREATE TABLE memories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  embedding         vector(1536),
  is_shared         BOOLEAN NOT NULL DEFAULT false,
  -- 'auto' (LLM-extracted from conversation), 'explicit' (user said "remember
  -- that ..."), 'manual' (typed into the Memories page directly).
  source            TEXT NOT NULL DEFAULT 'auto',
  importance        SMALLINT NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_user_id ON memories (user_id);
CREATE INDEX idx_memories_org_id ON memories (org_id);
CREATE INDEX idx_memories_org_shared ON memories (org_id) WHERE is_shared = true;
CREATE INDEX idx_memories_created_at ON memories (user_id, created_at DESC);

-- HNSW index for semantic search, matching the pattern used by kb_chunks.
CREATE INDEX idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

-- SELECT: user sees their own memories + org-shared memories within orgs they
-- belong to.
CREATE POLICY memories_select ON memories
  FOR SELECT USING (
    (user_id = auth.uid() AND org_id IN (SELECT public.user_org_ids()))
    OR
    (is_shared = true AND org_id IN (SELECT public.user_org_ids()))
  );

-- INSERT: only for yourself, in an org you're a member of.
CREATE POLICY memories_insert ON memories
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT public.user_org_ids())
  );

-- UPDATE: only owner can modify (flip is_shared, edit content, etc).
CREATE POLICY memories_update ON memories
  FOR UPDATE USING (user_id = auth.uid());

-- DELETE: only owner can delete their own memory.
CREATE POLICY memories_delete ON memories
  FOR DELETE USING (user_id = auth.uid());

-- ============================================================================
-- match_memories — semantic search RPC
--
-- Returns the top-K memories visible to (p_user_id, p_org_id):
--   - own memories in that org, OR
--   - org-shared memories in that org
--
-- Called from the chat pipeline under the service role, so it accepts the
-- identity as arguments rather than relying on auth.uid(). The pipeline
-- resolves (user_id, org_id) from the contact record before calling.
--
-- Bumps last_accessed_at on every hit so the Memories page can surface the
-- "recently used" list.
-- ============================================================================

CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(1536),
  p_user_id uuid,
  p_org_id uuid,
  match_count int DEFAULT 5,
  min_similarity float DEFAULT 0.3
)
RETURNS TABLE (
  id uuid,
  content text,
  similarity float,
  source text,
  is_shared boolean,
  importance smallint,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH hits AS (
    SELECT
      m.id,
      m.content,
      1 - (m.embedding <=> query_embedding) AS similarity,
      m.source,
      m.is_shared,
      m.importance,
      m.created_at
    FROM memories m
    WHERE m.org_id = p_org_id
      AND (m.user_id = p_user_id OR m.is_shared = true)
      AND m.embedding IS NOT NULL
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_count * 2
  )
  SELECT h.id, h.content, h.similarity, h.source, h.is_shared, h.importance, h.created_at
  FROM hits h
  WHERE h.similarity >= min_similarity
  ORDER BY h.similarity DESC
  LIMIT match_count;

  UPDATE memories m
  SET last_accessed_at = now()
  WHERE m.id IN (
    SELECT h.id FROM (
      SELECT m2.id, 1 - (m2.embedding <=> query_embedding) AS s
      FROM memories m2
      WHERE m2.org_id = p_org_id
        AND (m2.user_id = p_user_id OR m2.is_shared = true)
        AND m2.embedding IS NOT NULL
      ORDER BY m2.embedding <=> query_embedding
      LIMIT match_count
    ) h
    WHERE h.s >= min_similarity
  );
END;
$$;
