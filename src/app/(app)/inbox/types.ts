import type {
  ConversationStatus,
  ChannelType,
  MessageRole,
  Contact,
  Message,
} from '@/types/database'

// ---------------------------------------------------------------------------
// Shared types for the inbox module. Both customer-facing and internal
// chat views consume these; pulled out so the per-mode view files don't
// have to duplicate the shape when importing.
// ---------------------------------------------------------------------------

export interface ConversationItem {
  id: string
  org_id: string
  agent_id: string | null
  contact_id: string | null
  channel: ChannelType
  status: ConversationStatus
  assigned_to: string | null
  started_at: string
  resolved_at: string | null
  created_at: string
  updated_at: string
  contact:
    | Pick<Contact, 'id' | 'name' | 'email' | 'phone' | 'channel' | 'language' | 'metadata' | 'tags'>
    | null
  agent: { id: string; name: string; avatar_url: string | null } | null
  last_message: { content: string; role: MessageRole; created_at: string } | null
  message_count: number
}

export interface ConversationDetail extends ConversationItem {
  messages: Message[]
  conversation_count: number
}

export interface FilteredAgent {
  id: string
  name: string
  avatar_url: string | null
  settings?: Record<string, unknown> | null
}

export type { ConversationStatus, ChannelType, MessageRole, Contact, Message }
