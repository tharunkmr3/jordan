-- ============================================================================
-- Jordon AI Platform — Initial Schema Migration
-- Multi-tenant SaaS with RLS, RBAC, and pgvector for RAG
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- ENUM TYPES
-- ============================================================================

CREATE TYPE plan_type AS ENUM ('free', 'starter', 'growth', 'enterprise');
CREATE TYPE org_role AS ENUM ('owner', 'admin', 'agent', 'viewer');
CREATE TYPE model_provider AS ENUM ('sarvam', 'openai', 'anthropic', 'gemini');
CREATE TYPE voice_provider AS ENUM ('sarvam', 'elevenlabs', 'none');
CREATE TYPE agent_status AS ENUM ('draft', 'active', 'paused');
CREATE TYPE channel_type AS ENUM ('whatsapp', 'facebook', 'website', 'phone');
CREATE TYPE kb_document_status AS ENUM ('pending', 'processing', 'ready', 'error');
CREATE TYPE conversation_status AS ENUM ('active', 'waiting', 'resolved', 'escalated');
CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system', 'human_agent');
CREATE TYPE appointment_status AS ENUM ('scheduled', 'completed', 'cancelled');
CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'cancelled', 'trialing');
CREATE TYPE usage_event_type AS ENUM (
  'conversation', 'message', 'voice_minute',
  'tts_chars', 'stt_seconds', 'translation_chars'
);
CREATE TYPE webhook_source AS ENUM ('stripe', 'whatsapp', 'facebook', 'twilio');

-- ============================================================================
-- 1. ORGANIZATIONS
-- ============================================================================

CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  logo_url      TEXT,
  website       TEXT,
  industry      TEXT,
  country       TEXT NOT NULL DEFAULT 'IN',
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  plan          plan_type NOT NULL DEFAULT 'free',
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  trial_ends_at TIMESTAMPTZ,
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX idx_organizations_slug ON organizations (slug);
CREATE INDEX idx_organizations_plan ON organizations (plan);

-- ============================================================================
-- 2. PROFILES (linked to auth.users)
-- ============================================================================

CREATE TABLE profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  full_name  TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================================
-- 3. ORG_MEMBERS
-- ============================================================================

CREATE TABLE org_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       org_role NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX idx_org_members_org_id ON org_members (org_id);
CREATE INDEX idx_org_members_user_id ON org_members (user_id);

-- ============================================================================
-- 4. AGENTS
-- ============================================================================

CREATE TABLE agents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  description          TEXT,
  avatar_url           TEXT,
  system_prompt        TEXT,
  model_provider       model_provider NOT NULL DEFAULT 'openai',
  model_name           TEXT NOT NULL DEFAULT 'gpt-4o',
  voice_provider       voice_provider NOT NULL DEFAULT 'none',
  voice_id             TEXT,
  language             TEXT NOT NULL DEFAULT 'en',
  supported_languages  TEXT[] DEFAULT '{}',
  temperature          NUMERIC(3,2) DEFAULT 0.7,
  max_tokens           INTEGER DEFAULT 4096,
  greeting_message     TEXT,
  fallback_message     TEXT,
  escalation_enabled   BOOLEAN NOT NULL DEFAULT false,
  escalation_email     TEXT,
  status               agent_status NOT NULL DEFAULT 'draft',
  settings             JSONB DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);

CREATE INDEX idx_agents_org_id ON agents (org_id);
CREATE INDEX idx_agents_status ON agents (status);
CREATE INDEX idx_agents_org_status ON agents (org_id, status);

-- ============================================================================
-- 5. AGENT_CHANNELS
-- ============================================================================

CREATE TABLE agent_channels (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_type   channel_type NOT NULL,
  channel_config JSONB DEFAULT '{}',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_channels_agent_id ON agent_channels (agent_id);
CREATE INDEX idx_agent_channels_org_id ON agent_channels (org_id);

-- ============================================================================
-- 6. KNOWLEDGE_BASES
-- ============================================================================

CREATE TABLE knowledge_bases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_bases_org_id ON knowledge_bases (org_id);
CREATE INDEX idx_knowledge_bases_agent_id ON knowledge_bases (agent_id);

-- ============================================================================
-- 7. KB_DOCUMENTS
-- ============================================================================

CREATE TABLE kb_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id        UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  file_url     TEXT,
  file_type    TEXT,
  content_text TEXT,
  status       kb_document_status NOT NULL DEFAULT 'pending',
  char_count   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kb_documents_kb_id ON kb_documents (kb_id);
CREATE INDEX idx_kb_documents_org_id ON kb_documents (org_id);
CREATE INDEX idx_kb_documents_status ON kb_documents (status);

-- ============================================================================
-- 8. KB_CHUNKS (RAG with pgvector)
-- ============================================================================

CREATE TABLE kb_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  kb_id       UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   vector(1536),
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kb_chunks_document_id ON kb_chunks (document_id);
CREATE INDEX idx_kb_chunks_kb_id ON kb_chunks (kb_id);
CREATE INDEX idx_kb_chunks_org_id ON kb_chunks (org_id);

-- HNSW index for vector similarity search
CREATE INDEX idx_kb_chunks_embedding ON kb_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================================
-- 9. CONTACTS
-- ============================================================================

CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT,
  email           TEXT,
  phone           TEXT,
  channel         channel_type,
  channel_user_id TEXT,
  language        TEXT,
  metadata        JSONB DEFAULT '{}',
  tags            TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contacts_org_id ON contacts (org_id);
CREATE INDEX idx_contacts_email ON contacts (org_id, email);
CREATE INDEX idx_contacts_phone ON contacts (org_id, phone);
CREATE INDEX idx_contacts_channel_user ON contacts (org_id, channel, channel_user_id);

-- ============================================================================
-- 10. CONVERSATIONS
-- ============================================================================

CREATE TABLE conversations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id                UUID REFERENCES agents(id) ON DELETE SET NULL,
  contact_id              UUID REFERENCES contacts(id) ON DELETE SET NULL,
  channel                 channel_type NOT NULL,
  channel_conversation_id TEXT,
  status                  conversation_status NOT NULL DEFAULT 'active',
  assigned_to             UUID REFERENCES org_members(id) ON DELETE SET NULL,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_org_id ON conversations (org_id);
CREATE INDEX idx_conversations_agent_id ON conversations (agent_id);
CREATE INDEX idx_conversations_contact_id ON conversations (contact_id);
CREATE INDEX idx_conversations_status ON conversations (org_id, status);
CREATE INDEX idx_conversations_created_at ON conversations (created_at DESC);

-- ============================================================================
-- 11. MESSAGES
-- ============================================================================

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role            message_role NOT NULL,
  content         TEXT NOT NULL,
  channel         channel_type,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation_id ON messages (conversation_id);
CREATE INDEX idx_messages_org_id ON messages (org_id);
CREATE INDEX idx_messages_created_at ON messages (conversation_id, created_at);

-- ============================================================================
-- 12. APPOINTMENTS
-- ============================================================================

CREATE TABLE appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  start_time      TIMESTAMPTZ NOT NULL,
  end_time        TIMESTAMPTZ NOT NULL,
  status          appointment_status NOT NULL DEFAULT 'scheduled',
  meeting_link    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_appointments_org_id ON appointments (org_id);
CREATE INDEX idx_appointments_contact_id ON appointments (contact_id);
CREATE INDEX idx_appointments_start_time ON appointments (org_id, start_time);

-- ============================================================================
-- 13. SUBSCRIPTIONS
-- ============================================================================

CREATE TABLE subscriptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT,
  stripe_price_id        TEXT,
  plan                   plan_type NOT NULL DEFAULT 'free',
  status                 subscription_status NOT NULL DEFAULT 'trialing',
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscriptions_org_id ON subscriptions (org_id);
CREATE INDEX idx_subscriptions_status ON subscriptions (status);

-- ============================================================================
-- 14. USAGE_LOGS
-- ============================================================================

CREATE TABLE usage_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id   UUID REFERENCES agents(id) ON DELETE SET NULL,
  event_type usage_event_type NOT NULL,
  quantity   NUMERIC NOT NULL DEFAULT 1,
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_logs_org_id ON usage_logs (org_id);
CREATE INDEX idx_usage_logs_agent_id ON usage_logs (agent_id);
CREATE INDEX idx_usage_logs_event_type ON usage_logs (org_id, event_type);
CREATE INDEX idx_usage_logs_created_at ON usage_logs (org_id, created_at DESC);

-- ============================================================================
-- 15. WEBHOOK_EVENTS
-- ============================================================================

CREATE TABLE webhook_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID REFERENCES organizations(id) ON DELETE SET NULL,
  source     webhook_source NOT NULL,
  event_type TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  processed  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_events_org_id ON webhook_events (org_id);
CREATE INDEX idx_webhook_events_source ON webhook_events (source);
CREATE INDEX idx_webhook_events_processed ON webhook_events (processed) WHERE NOT processed;

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations', 'profiles', 'agents', 'agent_channels',
    'knowledge_bases', 'contacts', 'conversations', 'subscriptions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      t
    );
  END LOOP;
END;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

-- Helper: get org IDs for the current user
CREATE OR REPLACE FUNCTION public.user_org_ids()
RETURNS SETOF UUID AS $$
  SELECT org_id FROM public.org_members WHERE user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Enable RLS on all tenant tables
ALTER TABLE organizations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_channels     ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_bases    ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_documents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chunks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events     ENABLE ROW LEVEL SECURITY;

-- ---- Profiles ----
CREATE POLICY profiles_select ON profiles
  FOR SELECT USING (id = auth.uid());
CREATE POLICY profiles_update ON profiles
  FOR UPDATE USING (id = auth.uid());

-- ---- Organizations ----
CREATE POLICY org_select ON organizations
  FOR SELECT USING (id IN (SELECT public.user_org_ids()));
CREATE POLICY org_update ON organizations
  FOR UPDATE USING (
    id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- ---- Org Members ----
CREATE POLICY org_members_select ON org_members
  FOR SELECT USING (org_id IN (SELECT public.user_org_ids()));
CREATE POLICY org_members_insert ON org_members
  FOR INSERT WITH CHECK (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );
CREATE POLICY org_members_delete ON org_members
  FOR DELETE USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role = 'owner'
    )
  );

-- ---- Generic org_id policies (SELECT + INSERT + UPDATE + DELETE) ----
-- Macro: tables scoped by org_id where members can read, admins+ can write

CREATE OR REPLACE FUNCTION create_org_rls_policies(table_name TEXT)
RETURNS VOID AS $$
BEGIN
  EXECUTE format(
    'CREATE POLICY %1$s_select ON %1$I FOR SELECT USING (org_id IN (SELECT public.user_org_ids()))',
    table_name
  );
  EXECUTE format(
    'CREATE POLICY %1$s_insert ON %1$I FOR INSERT WITH CHECK (org_id IN (SELECT public.user_org_ids()))',
    table_name
  );
  EXECUTE format(
    'CREATE POLICY %1$s_update ON %1$I FOR UPDATE USING (org_id IN (SELECT public.user_org_ids()))',
    table_name
  );
  EXECUTE format(
    'CREATE POLICY %1$s_delete ON %1$I FOR DELETE USING (org_id IN (
      SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role IN (''owner'', ''admin'')
    ))',
    table_name
  );
END;
$$ LANGUAGE plpgsql;

SELECT create_org_rls_policies('agents');
SELECT create_org_rls_policies('agent_channels');
SELECT create_org_rls_policies('knowledge_bases');
SELECT create_org_rls_policies('kb_documents');
SELECT create_org_rls_policies('kb_chunks');
SELECT create_org_rls_policies('contacts');
SELECT create_org_rls_policies('conversations');
SELECT create_org_rls_policies('messages');
SELECT create_org_rls_policies('appointments');
SELECT create_org_rls_policies('subscriptions');
SELECT create_org_rls_policies('usage_logs');
SELECT create_org_rls_policies('webhook_events');

-- Cleanup helper function
DROP FUNCTION create_org_rls_policies(TEXT);
