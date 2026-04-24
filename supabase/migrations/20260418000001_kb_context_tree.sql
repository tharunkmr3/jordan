-- ============================================================================
-- KB context tree — per-collection semantic hints for the LLM
-- ============================================================================
--
-- Borrowed from tobi/qmd. Each knowledge_base row gets a short plain-
-- English description of WHAT this collection contains and HOW to treat
-- it. On retrieval, the context string is injected into the system
-- prompt above the matched chunks — the LLM then knows whether the
-- source is authoritative (HR policies, SOPs) or reference (dumped
-- helpdesk transcripts) and weights its answer accordingly.
--
-- Example prompts with + without context:
--
--   Without:  "Here are 4 matching chunks. Answer."
--   With:     "HR Policies — authoritative company rules. Trust these
--             over general knowledge. Here are 4 matching chunks..."
--
-- The distinction matters for regulated replies (benefits, refund
-- policy) where general-knowledge drift is a real quality risk.
--
-- Optional field — NULL means "no hint, treat generically". Existing
-- KBs keep working without a migration of their own content; operators
-- add context over time from the Knowledge page when they notice
-- recurring misses.
-- ============================================================================

ALTER TABLE knowledge_bases
  ADD COLUMN IF NOT EXISTS context TEXT;

COMMENT ON COLUMN knowledge_bases.context IS
  'Plain-English description injected into the RAG system prompt when chunks from this KB are retrieved. Helps the LLM weight authoritative vs. reference sources. Optional.';
