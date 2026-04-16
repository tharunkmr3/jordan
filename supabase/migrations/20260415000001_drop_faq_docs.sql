-- Remove FAQ-type knowledge base entries.
-- FAQs were stored as kb_documents rows with file_type='faq' alongside a
-- matching kb_chunk with metadata.source='faq'. The feature is being
-- retired before launch; users will upload a file for Q&A content instead.
--
-- kb_chunks has ON DELETE CASCADE on document_id, so a single DELETE from
-- kb_documents is enough — chunks go with it.

DELETE FROM kb_documents WHERE file_type = 'faq';

-- Safety net in case any FAQ chunks were orphaned (e.g. by a historical bug).
DELETE FROM kb_chunks WHERE metadata->>'source' = 'faq';
