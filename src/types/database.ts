// ============================================================================
// Jordon AI Platform — Database Types
// Auto-aligned with 001_initial_schema.sql
// ============================================================================

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type PlanType = 'free' | 'starter' | 'growth' | 'enterprise';
export type OrgRole = 'owner' | 'admin' | 'agent' | 'viewer';
export type ModelProvider = 'sarvam' | 'openai' | 'anthropic' | 'gemini';
export type VoiceProvider = 'sarvam' | 'elevenlabs' | 'none';
export type AgentStatus = 'draft' | 'active' | 'paused';
export type ChannelType = 'whatsapp' | 'facebook' | 'website' | 'phone';
export type KbDocumentStatus = 'pending' | 'processing' | 'ready' | 'error';
export type ConversationStatus = 'active' | 'waiting' | 'resolved' | 'escalated';
export type MessageRole = 'user' | 'assistant' | 'system' | 'human_agent';
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled';
export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled' | 'trialing';
export type UsageEventType =
  | 'conversation'
  | 'message'
  | 'voice_minute'
  | 'tts_chars'
  | 'stt_seconds'
  | 'translation_chars';
export type WebhookSource = 'stripe' | 'whatsapp' | 'facebook' | 'twilio' | 'composio';
export type IntegrationStatus =
  | 'initiated'
  | 'pending'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'failed'
  | 'inactive';
export type ConnectSessionStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  website: string | null;
  industry: string | null;
  country: string;
  timezone: string;
  plan: PlanType;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrgMember {
  id: string;
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: string;
}

export interface Agent {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  system_prompt: string | null;
  model_provider: ModelProvider;
  model_name: string;
  voice_provider: VoiceProvider;
  voice_id: string | null;
  language: string;
  supported_languages: string[];
  temperature: number;
  max_tokens: number;
  greeting_message: string | null;
  fallback_message: string | null;
  escalation_enabled: boolean;
  escalation_email: string | null;
  status: AgentStatus;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AgentChannel {
  id: string;
  agent_id: string;
  org_id: string;
  channel_type: ChannelType;
  channel_config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeBase {
  id: string;
  org_id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbDocument {
  id: string;
  kb_id: string;
  org_id: string;
  name: string;
  file_url: string | null;
  file_type: string | null;
  content_text: string | null;
  status: KbDocumentStatus;
  char_count: number;
  file_size: number | null;
  // Native-format preview cache. Populated on first open of the file
  // viewer and invalidated when content_text is edited.
  preview_html: string | null;
  preview_pdf_path: string | null;
  preview_generated_at: string | null;
  preview_error: string | null;
  created_at: string;
}

export interface KbChunk {
  id: string;
  document_id: string;
  kb_id: string;
  org_id: string;
  content: string;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Contact {
  id: string;
  org_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  channel: ChannelType | null;
  channel_user_id: string | null;
  language: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  org_id: string;
  agent_id: string | null;
  contact_id: string | null;
  channel: ChannelType;
  channel_conversation_id: string | null;
  status: ConversationStatus;
  assigned_to: string | null;
  started_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  org_id: string;
  role: MessageRole;
  content: string;
  channel: ChannelType | null;
  metadata: MessageMetadata;
  created_at: string;
}

export interface Appointment {
  id: string;
  org_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  title: string;
  start_time: string;
  end_time: string;
  status: AppointmentStatus;
  meeting_link: string | null;
  notes: string | null;
  created_at: string;
}

export interface Subscription {
  id: string;
  org_id: string;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  plan: PlanType;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UsageLog {
  id: string;
  org_id: string;
  agent_id: string | null;
  event_type: UsageEventType;
  quantity: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface WebhookEvent {
  id: string;
  org_id: string | null;
  source: WebhookSource;
  event_type: string;
  payload: Record<string, unknown>;
  processed: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Integrations (Composio)
// ---------------------------------------------------------------------------

export interface ComposioAuthConfig {
  id: string;
  toolkit_slug: string;
  composio_auth_config_id: string;
  org_id: string | null;
  display_name: string | null;
  is_active: boolean;
  is_composio_managed: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ComposioToolkitCache {
  slug: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  categories: string[];
  auth_schemes: string[];
  no_auth: boolean;
  is_local: boolean;
  tools_count: number;
  tags: string[];
  raw: Record<string, unknown> | null;
  fetched_at: string;
}

export interface OrgIntegration {
  id: string;
  org_id: string;
  toolkit_slug: string;
  connected_account_id: string;
  auth_config_id: string;
  account_label: string | null;
  status: IntegrationStatus;
  status_detail: string | null;
  connected_by_user_id: string | null;
  metadata: Record<string, unknown>;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentIntegration {
  id: string;
  agent_id: string;
  org_integration_id: string;
  org_id: string;
  enabled_tools: string[];
  tool_configs: Record<string, Record<string, unknown>>;
  attached_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationConnectSession {
  id: string;
  org_id: string;
  initiated_by_user_id: string;
  agent_id: string | null;
  toolkit_slug: string;
  auth_config_id: string;
  composio_connection_request_id: string | null;
  redirect_url: string | null;
  csrf_token: string;
  status: ConnectSessionStatus;
  resulting_org_integration_id: string | null;
  error_message: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}

export interface IntegrationAuditLog {
  id: string;
  org_id: string;
  actor_user_id: string | null;
  actor_type: 'user' | 'system' | 'webhook';
  action: string;
  org_integration_id: string | null;
  agent_id: string | null;
  toolkit_slug: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface IntegrationToolCall {
  id: string;
  org_id: string;
  agent_id: string;
  conversation_id: string | null;
  message_id: string | null;
  org_integration_id: string | null;
  toolkit_slug: string;
  tool_slug: string;
  arguments: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  success: boolean;
  error_message: string | null;
  latency_ms: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Metadata shapes
// ---------------------------------------------------------------------------

/**
 * Compact representation of something the agent consulted while
 * composing its reply. Rendered as clickable citation chips below the
 * assistant bubble. Persisted on Message.metadata.sources.
 *
 * Two flavours:
 *  - 'kb'  — a chunk retrieved from the knowledge base; chip deep-links
 *            to the owning document in the KB viewer
 *  - 'web' — a URL returned by web_search / deep_research; chip opens
 *            the external page in a new tab
 *
 * `kind` is optional for backward-compat with messages saved before
 * this union existed: readers should default to 'kb' when absent.
 */
export type MessageSource = KbMessageSource | WebMessageSource;

export interface KbMessageSource {
  kind?: 'kb';  // optional: pre-union history may omit it, default to 'kb'
  /** kb_chunks.id — unique id of the retrieved passage */
  chunk_id: string;
  /** kb_documents.id — used by the UI to deep-link to the viewer */
  document_id: string;
  /** kb_documents.name — displayed on the chip */
  document_name: string;
  /** knowledge_bases.id — routing to the KB detail view */
  kb_id: string;
  /** first ~200 chars of the chunk, shown in the hover card */
  snippet: string;
  /** 0..1 combined similarity score at retrieval time */
  similarity: number;
}

export interface WebMessageSource {
  kind: 'web';
  /** Absolute URL the chip opens in a new tab */
  url: string;
  /** Page title returned by the search tool */
  title: string;
  /** Short excerpt for the hover card */
  snippet: string;
  /** Which tool produced this hit — 'web_search' or 'deep_research' */
  tool?: 'web_search' | 'deep_research';
}

export interface MessageMetadata {
  language_detected?: string;
  model_used?: string;
  confidence?: number;
  tokens_prompt?: number;
  tokens_completion?: number;
  tokens_total?: number;
  /** KB citations used as context for this assistant reply. */
  sources?: MessageSource[];
  /**
   * Structured reply payload — a typed block list the UI renders
   * deterministically. Populated on the website channel only (phone and
   * messengers get prose). When present, the inbox renderer prefers it
   * over `content` (markdown); content stays around as a fallback for
   * history export, search index, and clients that can't render blocks.
   *
   * Shape: { blocks: Block[] } — see lib/ai/structured-output.ts.
   * Typed as `unknown` here so this module doesn't import the AI layer.
   */
  structured?: { blocks: unknown[] };
  [key: string]: unknown;
}

export interface ChannelConfig {
  // WhatsApp
  phone_number_id?: string;
  waba_id?: string;
  // Facebook
  page_id?: string;
  page_access_token?: string;
  // Website
  widget_key?: string;
  allowed_origins?: string[];
  // Phone / Twilio
  twilio_phone_number?: string;
  twilio_sid?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Insert types (omit auto-generated fields)
// ---------------------------------------------------------------------------

export type OrganizationInsert = Omit<Organization, 'id' | 'created_at' | 'updated_at' | 'deleted_at'> & {
  id?: string;
};

export type ProfileInsert = Omit<Profile, 'created_at' | 'updated_at'>;

export type OrgMemberInsert = Omit<OrgMember, 'id' | 'created_at'> & {
  id?: string;
};

export type AgentInsert = Omit<Agent, 'id' | 'created_at' | 'updated_at' | 'deleted_at'> & {
  id?: string;
  temperature?: number;
  max_tokens?: number;
  supported_languages?: string[];
  settings?: Record<string, unknown>;
};

export type AgentChannelInsert = Omit<AgentChannel, 'id' | 'created_at' | 'updated_at'> & {
  id?: string;
};

export type KnowledgeBaseInsert = Omit<KnowledgeBase, 'id' | 'created_at' | 'updated_at'> & {
  id?: string;
};

export type KbDocumentInsert = Omit<KbDocument, 'id' | 'created_at'> & {
  id?: string;
  char_count?: number;
};

export type KbChunkInsert = Omit<KbChunk, 'id' | 'created_at'> & {
  id?: string;
};

export type ContactInsert = Omit<Contact, 'id' | 'created_at' | 'updated_at'> & {
  id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type ConversationInsert = Omit<Conversation, 'id' | 'created_at' | 'updated_at'> & {
  id?: string;
  started_at?: string;
};

export type MessageInsert = Omit<Message, 'id' | 'created_at' | 'metadata'> & {
  id?: string;
  metadata?: MessageMetadata;
};

export type AppointmentInsert = Omit<Appointment, 'id' | 'created_at'> & {
  id?: string;
};

export type SubscriptionInsert = Omit<Subscription, 'id' | 'created_at' | 'updated_at'> & {
  id?: string;
};

export type UsageLogInsert = Omit<UsageLog, 'id' | 'created_at'> & {
  id?: string;
  quantity?: number;
  metadata?: Record<string, unknown>;
};

export type WebhookEventInsert = Omit<WebhookEvent, 'id' | 'created_at'> & {
  id?: string;
};

// ---------------------------------------------------------------------------
// Update types (all fields optional except id)
// ---------------------------------------------------------------------------

export type OrganizationUpdate = Partial<Omit<Organization, 'id' | 'created_at'>> & { id: string };
export type ProfileUpdate = Partial<Omit<Profile, 'id' | 'created_at'>> & { id: string };
export type AgentUpdate = Partial<Omit<Agent, 'id' | 'org_id' | 'created_at'>> & { id: string };
export type AgentChannelUpdate = Partial<Omit<AgentChannel, 'id' | 'org_id' | 'created_at'>> & { id: string };
export type KnowledgeBaseUpdate = Partial<Omit<KnowledgeBase, 'id' | 'org_id' | 'created_at'>> & { id: string };
export type ContactUpdate = Partial<Omit<Contact, 'id' | 'org_id' | 'created_at'>> & { id: string };
export type ConversationUpdate = Partial<Omit<Conversation, 'id' | 'org_id' | 'created_at'>> & { id: string };
export type AppointmentUpdate = Partial<Omit<Appointment, 'id' | 'org_id' | 'created_at'>> & { id: string };
export type SubscriptionUpdate = Partial<Omit<Subscription, 'id' | 'org_id' | 'created_at'>> & { id: string };

// ---------------------------------------------------------------------------
// API response helpers
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  data: T | null;
  error: ApiError | null;
}

export interface ApiListResponse<T> {
  data: T[];
  count: number;
  error: ApiError | null;
}

export interface ApiError {
  message: string;
  code?: string;
  status?: number;
}

export interface PaginationParams {
  page?: number;
  per_page?: number;
  order_by?: string;
  order_dir?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Joined / enriched types for common queries
// ---------------------------------------------------------------------------

export interface ConversationWithDetails extends Conversation {
  agent?: Pick<Agent, 'id' | 'name' | 'avatar_url'>;
  contact?: Pick<Contact, 'id' | 'name' | 'email' | 'phone'>;
  assigned_member?: Pick<Profile, 'id' | 'full_name' | 'avatar_url'>;
  last_message?: Pick<Message, 'content' | 'role' | 'created_at'>;
  message_count?: number;
}

export interface AgentWithChannels extends Agent {
  channels: AgentChannel[];
  knowledge_bases: Pick<KnowledgeBase, 'id' | 'name'>[];
}

export interface OrgMemberWithProfile extends OrgMember {
  profile: Profile;
}

export interface KnowledgeBaseWithDocuments extends KnowledgeBase {
  documents: KbDocument[];
  total_chars: number;
  total_chunks: number;
}

// ---------------------------------------------------------------------------
// Supabase Database type (for supabase.from<T>() usage)
// ---------------------------------------------------------------------------

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: Organization;
        Insert: OrganizationInsert;
        Update: Partial<OrganizationInsert>;
      };
      profiles: {
        Row: Profile;
        Insert: ProfileInsert;
        Update: Partial<ProfileInsert>;
      };
      org_members: {
        Row: OrgMember;
        Insert: OrgMemberInsert;
        Update: Partial<OrgMemberInsert>;
      };
      agents: {
        Row: Agent;
        Insert: AgentInsert;
        Update: Partial<AgentInsert>;
      };
      agent_channels: {
        Row: AgentChannel;
        Insert: AgentChannelInsert;
        Update: Partial<AgentChannelInsert>;
      };
      knowledge_bases: {
        Row: KnowledgeBase;
        Insert: KnowledgeBaseInsert;
        Update: Partial<KnowledgeBaseInsert>;
      };
      kb_documents: {
        Row: KbDocument;
        Insert: KbDocumentInsert;
        Update: Partial<KbDocumentInsert>;
      };
      kb_chunks: {
        Row: KbChunk;
        Insert: KbChunkInsert;
        Update: Partial<KbChunkInsert>;
      };
      contacts: {
        Row: Contact;
        Insert: ContactInsert;
        Update: Partial<ContactInsert>;
      };
      conversations: {
        Row: Conversation;
        Insert: ConversationInsert;
        Update: Partial<ConversationInsert>;
      };
      messages: {
        Row: Message;
        Insert: MessageInsert;
        Update: Partial<MessageInsert>;
      };
      appointments: {
        Row: Appointment;
        Insert: AppointmentInsert;
        Update: Partial<AppointmentInsert>;
      };
      subscriptions: {
        Row: Subscription;
        Insert: SubscriptionInsert;
        Update: Partial<SubscriptionInsert>;
      };
      usage_logs: {
        Row: UsageLog;
        Insert: UsageLogInsert;
        Update: Partial<UsageLogInsert>;
      };
      webhook_events: {
        Row: WebhookEvent;
        Insert: WebhookEventInsert;
        Update: Partial<WebhookEventInsert>;
      };
    };
    Enums: {
      plan_type: PlanType;
      org_role: OrgRole;
      model_provider: ModelProvider;
      voice_provider: VoiceProvider;
      agent_status: AgentStatus;
      channel_type: ChannelType;
      kb_document_status: KbDocumentStatus;
      conversation_status: ConversationStatus;
      message_role: MessageRole;
      appointment_status: AppointmentStatus;
      subscription_status: SubscriptionStatus;
      usage_event_type: UsageEventType;
      webhook_source: WebhookSource;
    };
  };
}
