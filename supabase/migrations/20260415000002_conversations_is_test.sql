-- Mark test-chat conversations so they can be hidden from the inbox.
-- The agent settings Test Chat panel writes to the same pipeline as
-- real customer channels, so without this flag test noise mingles
-- with real conversations in the inbox list.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

-- Backfill: any existing conversation where the contact's
-- channel_user_id starts with 'test-' is a test chat.
UPDATE conversations c
SET is_test = true
FROM contacts ct
WHERE c.contact_id = ct.id
  AND ct.channel_user_id LIKE 'test-%';

-- Useful for the inbox filter when a user has show_test_in_inbox=false
CREATE INDEX IF NOT EXISTS idx_conversations_is_test
  ON conversations (org_id, is_test);
