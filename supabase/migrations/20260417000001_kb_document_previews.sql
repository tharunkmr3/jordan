-- ============================================================================
-- KB document previews — storage bucket + cache columns
--
-- Adds infrastructure for rendering uploaded KB documents in their native
-- format in the file viewer. Extracted text stays in content_text for RAG;
-- these new fields handle the "show me the original file" story.
--
-- Cache strategy:
--   - preview_html  → textual HTML for DOCX, XLSX, CSV (generated once,
--                     stored inline so GETs are fast after first hit).
--   - preview_pdf_path → storage path for PPT/PPTX converted to PDF via
--                     LibreOffice. PDF itself lives in the bucket.
--   - preview_generated_at → last regeneration timestamp; useful for TTL
--                     policies and cache debugging.
--   - preview_error → captured error string when generation fails so the
--                     UI can show a helpful message instead of a silent
--                     "Preview not available".
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Storage bucket
-- ---------------------------------------------------------------------------
-- Private bucket; 50MB per-file cap matches the typical business doc size.
-- Access via signed URLs from the server — no public reads.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('kb-documents', 'kb-documents', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- Only the service role writes / reads; no authenticated user policies
-- needed because the app always reaches storage through the API layer.
-- If we later want direct client downloads we'll add org-membership policies.

-- ---------------------------------------------------------------------------
-- 2. Preview cache columns
-- ---------------------------------------------------------------------------

ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS preview_html TEXT,
  ADD COLUMN IF NOT EXISTS preview_pdf_path TEXT,
  ADD COLUMN IF NOT EXISTS preview_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preview_error TEXT;

-- Partial index: lets the reconcile / TTL job find stale previews quickly
-- without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_kb_documents_preview_generated_at
  ON kb_documents (preview_generated_at)
  WHERE preview_generated_at IS NOT NULL;
