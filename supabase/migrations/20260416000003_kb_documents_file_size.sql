-- Add file_size (bytes) to kb_documents so the knowledge base UI can show
-- the actual upload size rather than only char_count. Nullable because
-- historical rows and server-side imports may not have the source bytes
-- available.

ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS file_size BIGINT;
