-- ============================================================================
-- Jordon AI Platform — Composio Integrations
-- Multi-tenant integrations with per-org account pool, per-agent attachments,
-- per-tool grants, full audit trail, and Composio lifecycle tracking.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extend enums
-- ---------------------------------------------------------------------------

ALTER TYPE webhook_source ADD VALUE IF NOT EXISTS 'composio';

-- ---------------------------------------------------------------------------
-- Role helper (if not present): resolves the highest role for a user across
-- their orgs. Used by a few RLS predicates.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.user_has_role_in_org(_org_id UUID, _roles org_role[])
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = _org_id
      AND user_id = auth.uid()
      AND role = ANY(_roles)
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 1. composio_auth_configs — platform default + per-org override
-- ============================================================================

CREATE TABLE composio_auth_configs (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  toolkit_slug              TEXT NOT NULL,
  composio_auth_config_id   TEXT NOT NULL,
  org_id                    UUID REFERENCES organizations(id) ON DELETE CASCADE,   -- NULL = platform default
  display_name              TEXT,
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  is_composio_managed       BOOLEAN NOT NULL DEFAULT true,
  metadata                  JSONB DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One platform-default per toolkit AND one override per (toolkit, org)
CREATE UNIQUE INDEX uq_auth_configs_default ON composio_auth_configs (toolkit_slug) WHERE org_id IS NULL;
CREATE UNIQUE INDEX uq_auth_configs_org ON composio_auth_configs (toolkit_slug, org_id) WHERE org_id IS NOT NULL;
CREATE INDEX idx_auth_configs_active ON composio_auth_configs (toolkit_slug) WHERE is_active;

-- ============================================================================
-- 2. composio_toolkits_cache — nightly snapshot of Composio's toolkit catalog
-- ============================================================================

CREATE TABLE composio_toolkits_cache (
  slug                TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  logo_url            TEXT,
  categories          TEXT[] DEFAULT '{}',
  auth_schemes        TEXT[] DEFAULT '{}',   -- e.g. ['OAUTH2', 'API_KEY']
  no_auth             BOOLEAN NOT NULL DEFAULT false,
  is_local            BOOLEAN NOT NULL DEFAULT false,
  tools_count         INT NOT NULL DEFAULT 0,
  tags                TEXT[] DEFAULT '{}',
  raw                 JSONB,                  -- full payload for forward compat
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_toolkits_cache_fetched ON composio_toolkits_cache (fetched_at);
CREATE INDEX idx_toolkits_cache_categories ON composio_toolkits_cache USING GIN (categories);

-- ============================================================================
-- 3. org_integrations — org-level pool of connected accounts
-- ============================================================================

CREATE TYPE integration_status AS ENUM (
  'initiated',  -- connection request created but user hasn't completed OAuth
  'pending',    -- OAuth started on Composio side
  'active',     -- fully connected and usable
  'expired',    -- token expired, needs refresh
  'revoked',    -- user revoked on provider side
  'failed',     -- error state
  'inactive'    -- manually disabled
);

CREATE TABLE org_integrations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  toolkit_slug            TEXT NOT NULL,
  connected_account_id    TEXT NOT NULL UNIQUE,   -- Composio's ID (source of truth)
  auth_config_id          TEXT NOT NULL,
  account_label           TEXT,                    -- display label e.g. "alice@work.com"
  status                  integration_status NOT NULL DEFAULT 'initiated',
  status_detail           TEXT,
  connected_by_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata                JSONB DEFAULT '{}',
  last_synced_at          TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_org_integrations_org_toolkit ON org_integrations (org_id, toolkit_slug);
CREATE INDEX idx_org_integrations_status ON org_integrations (status);
CREATE INDEX idx_org_integrations_account ON org_integrations (connected_account_id);

-- ============================================================================
-- 4. agent_integrations — per-agent attachment + per-tool grants
-- ============================================================================

CREATE TABLE agent_integrations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  org_integration_id    UUID NOT NULL REFERENCES org_integrations(id) ON DELETE CASCADE,
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,   -- denormalized for RLS perf
  enabled_tools         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- array of tool slugs e.g. ["GMAIL_SEND_EMAIL"]
  tool_configs          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- per-tool config map
  attached_by_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, org_integration_id)
);

CREATE INDEX idx_agent_integrations_agent ON agent_integrations (agent_id);
CREATE INDEX idx_agent_integrations_org_int ON agent_integrations (org_integration_id);
CREATE INDEX idx_agent_integrations_org ON agent_integrations (org_id);

-- ============================================================================
-- 5. integration_connect_sessions — short-lived OAuth flow state (CSRF, origin)
-- ============================================================================

CREATE TYPE connect_session_status AS ENUM ('pending', 'completed', 'failed', 'expired', 'cancelled');

CREATE TABLE integration_connect_sessions (
  id                               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  initiated_by_user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id                         UUID REFERENCES agents(id) ON DELETE CASCADE,    -- optional: attach result to this agent
  toolkit_slug                     TEXT NOT NULL,
  auth_config_id                   TEXT NOT NULL,
  composio_connection_request_id   TEXT,
  redirect_url                     TEXT,
  csrf_token                       TEXT NOT NULL UNIQUE,
  status                           connect_session_status NOT NULL DEFAULT 'pending',
  resulting_org_integration_id     UUID REFERENCES org_integrations(id) ON DELETE SET NULL,
  error_message                    TEXT,
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                       TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
  completed_at                     TIMESTAMPTZ
);

CREATE INDEX idx_connect_sessions_org ON integration_connect_sessions (org_id);
CREATE INDEX idx_connect_sessions_cleanup ON integration_connect_sessions (expires_at) WHERE status = 'pending';

-- ============================================================================
-- 6. integration_audit_log — who did what at the integration level
-- ============================================================================

CREATE TABLE integration_audit_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_type          TEXT NOT NULL DEFAULT 'user',  -- 'user', 'system', 'webhook'
  action              TEXT NOT NULL,                 -- connect_initiated, connect_completed, disconnect, attach, detach, tools_updated, status_changed, auth_config_created
  org_integration_id  UUID REFERENCES org_integrations(id) ON DELETE SET NULL,
  agent_id            UUID REFERENCES agents(id) ON DELETE SET NULL,
  toolkit_slug        TEXT,
  details             JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_org_time ON integration_audit_log (org_id, created_at DESC);
CREATE INDEX idx_audit_org_integration ON integration_audit_log (org_integration_id) WHERE org_integration_id IS NOT NULL;

-- ============================================================================
-- 7. integration_tool_calls — every LLM tool invocation
-- ============================================================================

CREATE TABLE integration_tool_calls (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id     UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id          UUID REFERENCES messages(id) ON DELETE SET NULL,
  org_integration_id  UUID REFERENCES org_integrations(id) ON DELETE SET NULL,
  toolkit_slug        TEXT NOT NULL,
  tool_slug           TEXT NOT NULL,
  arguments           JSONB,
  result              JSONB,
  success             BOOLEAN NOT NULL,
  error_message       TEXT,
  latency_ms          INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tool_calls_agent_time ON integration_tool_calls (agent_id, created_at DESC);
CREATE INDEX idx_tool_calls_conv ON integration_tool_calls (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_tool_calls_cleanup ON integration_tool_calls (created_at);

-- ============================================================================
-- updated_at triggers
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auth_configs_updated_at BEFORE UPDATE ON composio_auth_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_org_integrations_updated_at BEFORE UPDATE ON org_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_agent_integrations_updated_at BEFORE UPDATE ON agent_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE composio_auth_configs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE composio_toolkits_cache          ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_integrations                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_integrations               ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connect_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_audit_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_tool_calls           ENABLE ROW LEVEL SECURITY;

-- ---- composio_auth_configs ----
-- Platform defaults (org_id IS NULL) readable by any authenticated user
-- Org-specific rows readable by members; only admins+ can mutate
CREATE POLICY auth_configs_select ON composio_auth_configs
  FOR SELECT USING (
    org_id IS NULL
    OR org_id IN (SELECT public.user_org_ids())
  );

CREATE POLICY auth_configs_insert ON composio_auth_configs
  FOR INSERT WITH CHECK (
    org_id IS NOT NULL
    AND public.user_has_role_in_org(org_id, ARRAY['owner','admin']::org_role[])
  );

CREATE POLICY auth_configs_update ON composio_auth_configs
  FOR UPDATE USING (
    org_id IS NOT NULL
    AND public.user_has_role_in_org(org_id, ARRAY['owner','admin']::org_role[])
  );

CREATE POLICY auth_configs_delete ON composio_auth_configs
  FOR DELETE USING (
    org_id IS NOT NULL
    AND public.user_has_role_in_org(org_id, ARRAY['owner','admin']::org_role[])
  );

-- ---- composio_toolkits_cache ----
-- Read-only for authenticated users; writes only via service role
CREATE POLICY toolkits_cache_select ON composio_toolkits_cache
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ---- org_integrations ----
CREATE POLICY org_integrations_select ON org_integrations
  FOR SELECT USING (org_id IN (SELECT public.user_org_ids()));

-- Writes are performed by the service role (API layer after role checks).
-- No INSERT/UPDATE/DELETE policies granted to authenticated users — API enforces.

-- ---- agent_integrations ----
CREATE POLICY agent_integrations_select ON agent_integrations
  FOR SELECT USING (org_id IN (SELECT public.user_org_ids()));

-- Writes via service role after API-layer role checks.

-- ---- integration_connect_sessions ----
-- Only initiator can read their own session while pending
CREATE POLICY connect_sessions_select ON integration_connect_sessions
  FOR SELECT USING (
    initiated_by_user_id = auth.uid()
    AND org_id IN (SELECT public.user_org_ids())
  );

-- ---- integration_audit_log ----
-- Members can read their org's audit log; admins see all, others their own actions
CREATE POLICY audit_log_select ON integration_audit_log
  FOR SELECT USING (
    org_id IN (SELECT public.user_org_ids())
    AND (
      public.user_has_role_in_org(org_id, ARRAY['owner','admin']::org_role[])
      OR actor_user_id = auth.uid()
    )
  );

-- ---- integration_tool_calls ----
CREATE POLICY tool_calls_select ON integration_tool_calls
  FOR SELECT USING (org_id IN (SELECT public.user_org_ids()));
