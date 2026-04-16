-- Mark test-chat conversations so they can be hidden from the inbox.
-- The agent settings Test Chat panel writes to the same pipeline as
-- real customer channels, so without this flag test noise mingles
-- with real conversations in the inbox list.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

-- Backfill: mark any pre-existing test-panel conversation. Historical
-- runs could identify themselves two ways — either by a 'test-' prefix
-- on channel_user_id (explicit visitorId) or by the contact name
-- landing as 'Test' (what the pipeline wrote when visitorId was null).
UPDATE conversations c
SET is_test = true
FROM contacts ct
WHERE c.contact_id = ct.id
  AND c.channel = 'website'
  AND (ct.channel_user_id LIKE 'test-%' OR ct.name = 'Test');

-- Useful for the inbox filter when a user has show_test_in_inbox=false
CREATE INDEX IF NOT EXISTS idx_conversations_is_test
  ON conversations (org_id, is_test);
