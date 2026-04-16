-- ============================================================================
-- Storage policies for the chat-attachments bucket.
-- The bucket itself must be created via the Storage API (private, 50MB limit)
-- before running this migration. Supabase doesn't expose a CREATE BUCKET SQL
-- statement — see scripts/bootstrap-chat-attachments-bucket.md for the one-shot
-- curl. Hosted DB already has the bucket (created via REST).
-- ============================================================================

-- Authenticated team members can upload into their org's folder. The path
-- convention written by /api/chat/attachments is <org_id>/<user_id>/<random>/<name>.
-- We use the admin client on the server for uploads (service role), so this
-- policy is mostly belt-and-suspenders for any future direct-from-browser
-- upload flow.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'chat-attachments: team members can upload to their org'
  ) THEN
    CREATE POLICY "chat-attachments: team members can upload to their org"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'chat-attachments'
        AND (storage.foldername(name))[1] IN (
          SELECT org_id::text FROM public.org_members WHERE user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'chat-attachments: team members can read their org'
  ) THEN
    CREATE POLICY "chat-attachments: team members can read their org"
      ON storage.objects FOR SELECT TO authenticated
      USING (
        bucket_id = 'chat-attachments'
        AND (storage.foldername(name))[1] IN (
          SELECT org_id::text FROM public.org_members WHERE user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'chat-attachments: team members can delete their own'
  ) THEN
    -- Deletion allowed only for the uploader (user_id segment = auth.uid()).
    -- Handy for "undo attach" before sending.
    CREATE POLICY "chat-attachments: team members can delete their own"
      ON storage.objects FOR DELETE TO authenticated
      USING (
        bucket_id = 'chat-attachments'
        AND (storage.foldername(name))[2] = auth.uid()::text
      );
  END IF;
END $$;
