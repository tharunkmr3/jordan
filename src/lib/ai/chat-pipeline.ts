// ============================================================================
// Jordon AI Platform — Chat Pipeline
// Core engine that processes all incoming messages across channels
// ============================================================================

import { createAdminClient } from '@/lib/supabase/admin'
import { generateResponse, streamResponse, type ChatMessage, type ModelConfig } from './models'
import type {
  Agent,
  ChannelType,
  Contact,
  Conversation,
  MessageInsert,
  UsageLogInsert,
} from '@/types/database'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineInput {
  agentId: string
  message: string
  conversationId?: string
  channel: ChannelType
  contactInfo?: {
    name?: string
    email?: string
    phone?: string
    channelUserId?: string
  }
}

export interface PipelineOutput {
  response: string
  conversationId: string
  messageId: string
  contactId: string
}

// ---------------------------------------------------------------------------
// Knowledge base — optional dependency
// ---------------------------------------------------------------------------

let queryKnowledgeBase:
  | ((agentId: string, query: string, topK?: number) => Promise<string[]>)
  | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kb = require('./knowledge-base')
  queryKnowledgeBase = kb.queryKnowledgeBase
} catch {
  // Knowledge base module not available yet
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function processChatMessage(
  input: PipelineInput
): Promise<PipelineOutput> {
  const supabase = createAdminClient()

  // 1. Load agent config
  const agent = await loadAgent(supabase, input.agentId)

  // 2. Find or create contact + conversation in parallel where possible
  const contact = await findOrCreateContact(supabase, agent.org_id, input)
  const conversation = await findOrCreateConversation(supabase, agent, contact, input)

  // 3. Save user message, load history, and query KB in parallel
  const [, history, kbContext] = await Promise.all([
    saveMessage(supabase, {
      conversation_id: conversation.id,
      org_id: agent.org_id,
      role: 'user',
      content: input.message,
      channel: input.channel,
    }),
    loadHistory(supabase, conversation.id, 20),
    queryKnowledgeBase
      ? queryKnowledgeBase(input.agentId, input.message, 5).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ])

  // 4. Build prompt
  const kbContextStr = kbContext.length > 0 ? kbContext.join('\n\n') : ''
  const messages = buildPrompt(agent, history, input.message, kbContextStr, input.channel)

  // 5. Call AI model
  const modelConfig: ModelConfig = {
    provider: agent.model_provider,
    model: agent.model_name,
    temperature: agent.temperature,
    maxTokens: agent.max_tokens,
  }

  let response: string
  try {
    response = await generateResponse(messages, modelConfig)
  } catch (error) {
    console.error('[chat-pipeline] Model API error:', error)
    response =
      agent.fallback_message ||
      "I'm sorry, I'm having trouble right now. Please try again in a moment."
  }

  // 6. Save assistant message
  const { data: savedMsg } = await saveMessage(supabase, {
    conversation_id: conversation.id,
    org_id: agent.org_id,
    role: 'assistant',
    content: response,
    channel: input.channel,
    metadata: {
      model_used: `${agent.model_provider}/${agent.model_name}`,
    },
  })

  // 7. Log usage — fire and forget (don't block the response)
  logUsage(supabase, {
    org_id: agent.org_id,
    agent_id: agent.id,
    event_type: 'message',
    quantity: 1,
    metadata: {
      conversation_id: conversation.id,
      channel: input.channel,
      model: `${agent.model_provider}/${agent.model_name}`,
    },
  }).catch(err => console.error('[chat-pipeline] Usage log failed:', err))

  return {
    response,
    conversationId: conversation.id,
    messageId: savedMsg?.id || '',
    contactId: contact.id,
  }
}

/**
 * Streaming pipeline — yields text chunks as they arrive from the LLM.
 * Saves the full response to DB after streaming completes.
 */
export async function* streamChatMessage(
  input: PipelineInput
): AsyncGenerator<{ type: 'token' | 'meta'; data: string }> {
  const supabase = createAdminClient()

  const agent = await loadAgent(supabase, input.agentId)
  const contact = await findOrCreateContact(supabase, agent.org_id, input)
  const conversation = await findOrCreateConversation(supabase, agent, contact, input)

  const [, history, kbContext] = await Promise.all([
    saveMessage(supabase, {
      conversation_id: conversation.id,
      org_id: agent.org_id,
      role: 'user',
      content: input.message,
      channel: input.channel,
    }),
    loadHistory(supabase, conversation.id, 20),
    queryKnowledgeBase
      ? queryKnowledgeBase(input.agentId, input.message, 5).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ])

  const kbContextStr = kbContext.length > 0 ? kbContext.join('\n\n') : ''
  const messages = buildPrompt(agent, history, input.message, kbContextStr, input.channel)

  const modelConfig: ModelConfig = {
    provider: agent.model_provider,
    model: agent.model_name,
    temperature: agent.temperature,
    maxTokens: agent.max_tokens,
  }

  // Yield conversation ID first so frontend can track it
  yield { type: 'meta', data: JSON.stringify({ conversationId: conversation.id, contactId: contact.id }) }

  // Stream LLM tokens
  let fullResponse = ''
  try {
    for await (const chunk of streamResponse(messages, modelConfig)) {
      fullResponse += chunk
      yield { type: 'token', data: chunk }
    }
  } catch (error) {
    console.error('[chat-pipeline] Stream error:', error)
    fullResponse = agent.fallback_message || "I'm sorry, I'm having trouble right now."
    yield { type: 'token', data: fullResponse }
  }

  // Save response and log usage (fire and forget)
  saveMessage(supabase, {
    conversation_id: conversation.id,
    org_id: agent.org_id,
    role: 'assistant',
    content: fullResponse,
    channel: input.channel,
    metadata: { model_used: `${agent.model_provider}/${agent.model_name}` },
  }).catch(err => console.error('[chat-pipeline] Save response failed:', err))

  logUsage(supabase, {
    org_id: agent.org_id,
    agent_id: agent.id,
    event_type: 'message',
    quantity: 1,
    metadata: { conversation_id: conversation.id, channel: input.channel, model: `${agent.model_provider}/${agent.model_name}` },
  }).catch(err => console.error('[chat-pipeline] Usage log failed:', err))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SupabaseAdmin = ReturnType<typeof createAdminClient>

async function loadAgent(supabase: SupabaseAdmin, agentId: string): Promise<Agent> {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .eq('status', 'active')
    .single()

  if (error || !data) {
    throw new Error(`Agent not found or inactive: ${agentId}`)
  }
  return data as Agent
}

async function findOrCreateContact(supabase: SupabaseAdmin, orgId: string, input: PipelineInput): Promise<Contact> {
  const info = input.contactInfo
  const fallbackName = info?.name || (input.channel === 'phone' ? info?.phone : undefined) || undefined

  // Helper: backfill name on an existing contact if we just learned one
  async function enrich(existing: Contact): Promise<Contact> {
    if (fallbackName && (!existing.name || existing.name === existing.phone || existing.name === 'Unknown')) {
      const { data: updated } = await supabase
        .from('contacts')
        .update({ name: fallbackName })
        .eq('id', existing.id)
        .select()
        .single()
      return (updated || existing) as Contact
    }
    return existing
  }

  if (info?.channelUserId) {
    const { data } = await supabase.from('contacts').select('*').eq('org_id', orgId).eq('channel_user_id', info.channelUserId).eq('channel', input.channel).single()
    if (data) return enrich(data as Contact)
  }
  if (info?.email) {
    const { data } = await supabase.from('contacts').select('*').eq('org_id', orgId).eq('email', info.email).single()
    if (data) return enrich(data as Contact)
  }
  if (info?.phone) {
    const { data } = await supabase.from('contacts').select('*').eq('org_id', orgId).eq('phone', info.phone).single()
    if (data) return enrich(data as Contact)
  }

  const { data, error } = await supabase
    .from('contacts')
    .insert({ org_id: orgId, name: fallbackName || null, email: info?.email || null, phone: info?.phone || null, channel: input.channel, channel_user_id: info?.channelUserId || null, metadata: {}, tags: [] })
    .select()
    .single()

  if (error || !data) throw new Error(`Failed to create contact: ${error?.message}`)
  return data as Contact
}

async function findOrCreateConversation(supabase: SupabaseAdmin, agent: Agent, contact: Contact, input: PipelineInput): Promise<Conversation> {
  if (input.conversationId) {
    const { data } = await supabase.from('conversations').select('*').eq('id', input.conversationId).single()
    if (data) return data as Conversation
  }

  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('org_id', agent.org_id)
    .eq('agent_id', agent.id)
    .eq('contact_id', contact.id)
    .eq('channel', input.channel)
    .in('status', ['active', 'waiting'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (existing) return existing as Conversation

  const { data, error } = await supabase
    .from('conversations')
    .insert({ org_id: agent.org_id, agent_id: agent.id, contact_id: contact.id, channel: input.channel, status: 'active', started_at: new Date().toISOString(), resolved_at: null, channel_conversation_id: null, assigned_to: null })
    .select()
    .single()

  if (error || !data) throw new Error(`Failed to create conversation: ${error?.message}`)
  return data as Conversation
}

async function saveMessage(supabase: SupabaseAdmin, msg: MessageInsert): Promise<{ data: { id: string } | null }> {
  const { data, error } = await supabase.from('messages').insert(msg).select('id').single()
  if (error) console.error('[chat-pipeline] Failed to save message:', error)
  return { data }
}

async function loadHistory(supabase: SupabaseAdmin, conversationId: string, limit: number): Promise<ChatMessage[]> {
  const { data } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit)

  if (!data) return []
  return data
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}

function buildPrompt(agent: Agent, history: ChatMessage[], currentMessage: string, kbContext: string, channel?: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  let systemPrompt = agent.system_prompt || 'You are a helpful assistant.'

  if (kbContext) {
    systemPrompt += `\n\n--- Relevant Knowledge Base Context ---\n${kbContext}\n--- End Context ---\n\nUse the above context to answer the user's question when relevant. If the context doesn't help, answer from your general knowledge.`
  }

  // For voice calls, instruct the AI to avoid markdown and keep responses short
  if (channel === 'phone') {
    systemPrompt += `\n\n--- Voice Call Mode ---\nYou are on a phone call. Respond conversationally in 1-3 short sentences. Do NOT use markdown, bullet points, asterisks, or headings — these will be read aloud literally. Speak naturally as if you were talking.`
  }

  messages.push({ role: 'system', content: systemPrompt })
  // Exclude the current user message from history (race with parallel save) — we'll append it explicitly
  const filteredHistory = history.filter(
    (m, idx) => !(idx === history.length - 1 && m.role === 'user' && m.content === currentMessage)
  )
  messages.push(...filteredHistory)
  // Always append the current user message to guarantee it's present
  messages.push({ role: 'user', content: currentMessage })
  return messages
}

async function logUsage(supabase: SupabaseAdmin, log: UsageLogInsert): Promise<void> {
  const { error } = await supabase.from('usage_logs').insert(log)
  if (error) console.error('[chat-pipeline] Failed to log usage:', error)
}
