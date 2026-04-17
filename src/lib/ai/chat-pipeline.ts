// ============================================================================
// Jordon AI Platform — Chat Pipeline
// Core engine that processes all incoming messages across channels
// ============================================================================

import { createAdminClient } from '@/lib/supabase/admin'
import {
  generateResponse,
  generateWithTools,
  streamResponse,
  supportsTools,
  type ChatMessage,
  type ContentPart,
  type ModelConfig,
} from './models'
import {
  buildAgentTools,
  executeAgentToolCall,
  type AgentToolContext,
  type LlmTool,
} from '@/lib/composio/tools'
import { buildBuiltinTools, type BuiltinToolsBundle } from '@/lib/builtin-tools'
import type {
  Agent,
  ChannelType,
  Contact,
  Conversation,
  MessageInsert,
  UsageLogInsert,
} from '@/types/database'
import type { UploadedAttachment } from '@/lib/chat-attachments/constants'
import { signAttachmentUrls } from '@/lib/chat-attachments/signing'

const MAX_TOOL_ITERATIONS = 6   // cap agentic loops per request

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineInput {
  agentId: string
  message: string
  conversationId?: string
  channel: ChannelType
  /**
   * True when the message originates from the in-app Test Chat panel
   * in agent settings. Flags the conversation as is_test=true so the
   * inbox can optionally hide it.
   */
  isTest?: boolean
  /**
   * Per-turn model override (internal-agent chat UI allows the user
   * to switch models from the composer). Must be a name present in
   * MODEL_CATALOG; server resolves provider. When omitted the pipeline
   * falls back to the agent's configured model_name / model_provider.
   */
  modelOverride?: {
    name: string
    provider: 'openai' | 'anthropic' | 'sarvam' | 'gemini'
  }
  contactInfo?: {
    name?: string
    email?: string
    phone?: string
    channelUserId?: string
  }
  /**
   * Attachments the user sent with this turn. Pre-processed on the
   * upload route — docs arrive with extractedText, audio with
   * transcript. Images get signed URLs inline at prompt-build time
   * and are sent as vision content parts.
   */
  attachments?: UploadedAttachment[]
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
      // Persist attachments on the user message so history replay and
      // the inbox bubble renderer can reconstruct the chips / previews.
      metadata: input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : undefined,
    }),
    loadHistory(supabase, conversation.id, 20),
    queryKnowledgeBase
      ? queryKnowledgeBase(input.agentId, input.message, 5).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ])

  // 4. Build prompt
  const kbContextStr = kbContext.length > 0 ? kbContext.join('\n\n') : ''
  const messages = await buildPrompt(agent, history, input.message, kbContextStr, input.channel, input.attachments)

  // 5. Call AI model. Per-turn override wins over the agent's configured
  // model — the internal-chat composer uses this to let users switch
  // models without editing agent settings.
  const effectiveProvider = input.modelOverride?.provider ?? agent.model_provider
  const effectiveModelName = input.modelOverride?.name ?? agent.model_name
  const modelConfig: ModelConfig = {
    provider: effectiveProvider,
    model: effectiveModelName,
    temperature: agent.temperature,
    maxTokens: agent.max_tokens,
  }

  // 5a. Load tools — Composio integrations + built-in tools (web search,
  // deep research) from agent.settings.builtin_tools. Merge into one
  // list; executor dispatches by tool name.
  const composioBundle = supportsTools(effectiveProvider)
    ? await buildAgentTools(supabase, agent.id)
    : null
  const builtinsBundle = supportsTools(effectiveProvider)
    ? buildBuiltinTools(agent.settings as Record<string, unknown> | null | undefined)
    : null
  const mergedTools: LlmTool[] = [
    ...(composioBundle?.tools ?? []),
    ...(builtinsBundle?.tools ?? []),
  ]

  let response: string
  try {
    if (mergedTools.length > 0) {
      response = await runAgenticLoop(
        supabase,
        messages,
        mergedTools,
        composioBundle?.ctx ?? null,
        builtinsBundle,
        modelConfig,
        { conversationId: conversation.id }
      )
    } else {
      response = await generateResponse(messages, modelConfig)
    }
  } catch (error) {
    console.error('[chat-pipeline] Model API error:', error)
    response = formatPipelineError(error, agent.fallback_message)
  }
  // Guard against models that return empty strings — empty content
  // would render as a blank bubble with no explanation. Surface a
  // visible notice instead.
  if (!response || !response.trim()) {
    response = '⚠️ Model returned an empty response. Check server logs.'
  }

  // 6. Save assistant message
  const { data: savedMsg } = await saveMessage(supabase, {
    conversation_id: conversation.id,
    org_id: agent.org_id,
    role: 'assistant',
    content: response,
    channel: input.channel,
    metadata: {
      // Record the model that actually handled this turn (override-aware)
      // so history shows "this reply came from Opus, that one from Sonnet".
      model_used: `${effectiveProvider}/${effectiveModelName}`,
      model_overridden: Boolean(input.modelOverride),
      tools_available: mergedTools.length,
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
): AsyncGenerator<{ type: 'token' | 'meta' | 'thought'; data: string }> {
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
      // Persist attachments on the user message so history replay and
      // the inbox bubble renderer can reconstruct the chips / previews.
      metadata: input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : undefined,
    }),
    loadHistory(supabase, conversation.id, 20),
    queryKnowledgeBase
      ? queryKnowledgeBase(input.agentId, input.message, 5).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ])

  const kbContextStr = kbContext.length > 0 ? kbContext.join('\n\n') : ''
  const messages = await buildPrompt(agent, history, input.message, kbContextStr, input.channel, input.attachments)

  // Per-turn override applies here too (internal chat composer sends
  // a modelOverride for the currently-selected model).
  const effectiveProvider = input.modelOverride?.provider ?? agent.model_provider
  const effectiveModelName = input.modelOverride?.name ?? agent.model_name
  const modelConfig: ModelConfig = {
    provider: effectiveProvider,
    model: effectiveModelName,
    temperature: agent.temperature,
    maxTokens: agent.max_tokens,
  }

  // Yield conversation ID first so frontend can track it
  yield { type: 'meta', data: JSON.stringify({ conversationId: conversation.id, contactId: contact.id }) }

  // Tool-calling path: the agentic loop can't be streamed natively (we need
  // to see the full tool_calls array before executing). If the agent has
  // tools enabled, run the non-streaming agentic loop then yield the final
  // text as a single chunk. UX: slightly slower first token, but tools work.
  const composioBundle = supportsTools(effectiveProvider)
    ? await buildAgentTools(supabase, agent.id)
    : null
  const builtinsBundle = supportsTools(effectiveProvider)
    ? buildBuiltinTools(agent.settings as Record<string, unknown> | null | undefined)
    : null
  const mergedTools: LlmTool[] = [
    ...(composioBundle?.tools ?? []),
    ...(builtinsBundle?.tools ?? []),
  ]

  let fullResponse = ''
  if (mergedTools.length > 0) {
    try {
      for await (const ev of runAgenticLoopStream(
        supabase,
        messages,
        mergedTools,
        composioBundle?.ctx ?? null,
        builtinsBundle,
        modelConfig,
        { conversationId: conversation.id },
      )) {
        if (ev.kind === 'final_text') {
          fullResponse = ev.text
        } else {
          // Forward every non-final event to the client as a 'thought'
          // frame so the UI can render a chain-of-thought timeline.
          yield { type: 'thought', data: JSON.stringify(ev) }
        }
      }
    } catch (error) {
      console.error('[chat-pipeline] Tool loop error:', error)
      fullResponse = formatPipelineError(error, agent.fallback_message)
    }
    if (!fullResponse || !fullResponse.trim()) {
      fullResponse = '⚠️ Model returned an empty response. Check server logs.'
    }
    yield { type: 'token', data: fullResponse }

    // Save + usage, then return (skip the streaming block below)
    saveMessage(supabase, {
      conversation_id: conversation.id,
      org_id: agent.org_id,
      role: 'assistant',
      content: fullResponse,
      channel: input.channel,
      metadata: {
        model_used: `${effectiveProvider}/${effectiveModelName}`,
        model_overridden: Boolean(input.modelOverride),
        tools_available: mergedTools.length,
      },
    }).catch(err => console.error('[chat-pipeline] Save response failed:', err))

    logUsage(supabase, {
      org_id: agent.org_id,
      agent_id: agent.id,
      event_type: 'message',
      quantity: 1,
      metadata: { conversation_id: conversation.id, channel: input.channel, model: `${effectiveProvider}/${effectiveModelName}` },
    }).catch(err => console.error('[chat-pipeline] Usage log failed:', err))

    return
  }

  // Stream LLM tokens (no tools)
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
    metadata: {
      model_used: `${effectiveProvider}/${effectiveModelName}`,
      model_overridden: Boolean(input.modelOverride),
    },
  }).catch(err => console.error('[chat-pipeline] Save response failed:', err))

  logUsage(supabase, {
    org_id: agent.org_id,
    agent_id: agent.id,
    event_type: 'message',
    quantity: 1,
    metadata: { conversation_id: conversation.id, channel: input.channel, model: `${effectiveProvider}/${effectiveModelName}` },
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
    .insert({ org_id: agent.org_id, agent_id: agent.id, contact_id: contact.id, channel: input.channel, status: 'active', started_at: new Date().toISOString(), resolved_at: null, channel_conversation_id: null, assigned_to: null, is_test: input.isTest ?? false })
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

async function buildPrompt(
  agent: Agent,
  history: ChatMessage[],
  currentMessage: string,
  kbContext: string,
  channel: ChannelType | undefined,
  attachments: UploadedAttachment[] | undefined,
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = []
  let systemPrompt = agent.system_prompt || 'You are a helpful assistant.'

  if (kbContext) {
    systemPrompt += `\n\n--- Relevant Knowledge Base Context ---\n${kbContext}\n--- End Context ---\n\nUse the above context to answer the user's question when relevant. If the context doesn't help, answer from your general knowledge.`
  }

  // Channel-aware output rules. Three tiers depending on what the
  // receiving surface can actually render:
  //
  //  - phone:         voice — plain spoken prose, no markdown, no widgets.
  //  - whatsapp / fb: text messengers — light markdown, no widgets
  //                   (a `ui` block would land as a raw JSON code fence).
  //  - website:       our chat widget + test chat + internal agents —
  //                   full markdown + generative UI widgets available.
  if (channel === 'phone') {
    systemPrompt += `\n\n--- Voice Call Mode ---\nYou are on a phone call. Respond conversationally in 1-3 short sentences. Do NOT use markdown, bullet points, asterisks, or headings — these will be read aloud literally. Speak naturally as if you were talking.`
  } else if (channel === 'whatsapp' || channel === 'facebook') {
    systemPrompt += `\n\n--- Messenger Mode ---\nYou are replying inside ${channel === 'whatsapp' ? 'WhatsApp' : 'Facebook Messenger'}. Respond in plain text. Light markdown is OK (*bold*, _italic_, simple lists) but do NOT emit headings, tables, or fenced code blocks — especially not "ui" blocks, they render as raw JSON on this channel. Keep replies concise.`
  } else {
    // website channel covers the customer chat widget, the agent
    // settings Test Chat panel, and internal-agent chats in the
    // inbox — all surfaces that can render our generative UI.
    systemPrompt += `\n\n--- Generative UI ---\nWhen you need structured input from the user, or a structured response would read better than prose (e.g. a disambiguation list, a confirmation before a destructive action, or tabular data), you MAY embed a single fenced code block tagged "ui" containing JSON of one of these shapes:
- form: {"type":"form","title":"...","fields":[{"name":"","label":"","type":"text|email|url|number|textarea|select|boolean","required":true,"options":[{"value":"","label":""}]}],"submit":{"label":"Submit","action":"optional_hint"}}
- confirm: {"type":"confirm","message":"...","confirm":{"label":"Yes","variant":"default|destructive"},"cancel":{"label":"Cancel"}}
- choice: {"type":"choice","title":"...","options":[{"value":"","label":"","description":""}]}
- card: {"type":"card","title":"...","subtitle":"","fields":[{"label":"","value":""}],"action":{"label":"","value":"","variant":"default|secondary|destructive"}}
- table: {"type":"table","title":"...","columns":[{"key":"","label":""}],"rows":[{"col_key":"cell"}]}

Prose is still the default. Only emit a widget when structured input or structured output is clearly better than text. Never wrap multiple widgets in one block.`
  }

  messages.push({ role: 'system', content: systemPrompt })
  // Exclude the current user message from history (race with parallel save) — we'll append it explicitly
  const filteredHistory = history.filter(
    (m, idx) => !(idx === history.length - 1 && m.role === 'user' && m.content === currentMessage)
  )
  messages.push(...filteredHistory)

  // Append the current user message. Attachments are folded in:
  // - Documents: extractedText is prepended as quoted context.
  // - Audio: transcript is prepended as quoted context.
  // - Images: converted to signed URLs and passed as vision content parts.
  //
  // If there are no images, the message stays a plain string (faster,
  // and avoids bumping models that don't support multimodal content).
  const userMsg = await buildUserMessage(currentMessage, attachments ?? [])
  messages.push(userMsg)
  return messages
}

/**
 * Build the current-turn user message. Combines the typed text with
 * any pre-extracted attachment bodies, and inlines images as vision
 * content parts via signed URLs.
 */
async function buildUserMessage(
  text: string,
  attachments: UploadedAttachment[],
): Promise<ChatMessage> {
  if (attachments.length === 0) {
    return { role: 'user', content: text }
  }

  // Build a prose prefix for every non-image attachment — extracted
  // text for docs, transcript for audio, filename as a fallback.
  const contextBlocks: string[] = []
  const images: UploadedAttachment[] = []

  for (const a of attachments) {
    if (a.kind === 'image') {
      images.push(a)
      continue
    }
    if (a.kind === 'audio' && a.transcript) {
      contextBlocks.push(`[Attached audio: ${a.name}]\nTranscript:\n${a.transcript}`)
      continue
    }
    if (a.extractedText) {
      contextBlocks.push(`[Attached ${a.kind.toUpperCase()}: ${a.name}]\n${a.extractedText}`)
      continue
    }
    contextBlocks.push(`[Attached ${a.kind}: ${a.name} — (no extracted content)]`)
  }

  const fullText = [
    contextBlocks.join('\n\n---\n\n'),
    contextBlocks.length > 0 ? '\n\n---\n\n' : '',
    text,
  ].filter(Boolean).join('').trim()

  if (images.length === 0) {
    return { role: 'user', content: fullText }
  }

  // Sign each image URL for LLM-side fetch. An hour is plenty for a
  // single turn; history replays generate fresh URLs if needed.
  const urls = await signAttachmentUrls(images.map(i => i.path))
  const imageParts: ContentPart[] = []
  for (let i = 0; i < images.length; i++) {
    const url = urls[i]
    if (!url) continue
    imageParts.push({ type: 'image_url', image_url: { url } })
  }

  const parts: ContentPart[] = []
  if (fullText.length > 0) parts.push({ type: 'text', text: fullText })
  parts.push(...imageParts)
  return { role: 'user', content: parts }
}

/**
 * Turn a thrown pipeline error into a user-visible chat message.
 *
 * Philosophy: never silently swallow. A silent failure looks like a
 * bug-free chat that happens to say "I'm not sure about that" on
 * every turn — way harder to debug than a visible "⚠️ Error: ..."
 * bubble. Team members testing an agent need to see what broke.
 *
 * Known-error-shape branches show a friendlier message (context
 * limit, auth failure, rate limit) and the full details still go
 * to the server log. Anything else falls through to the raw
 * message with a ⚠️ prefix.
 */
function formatPipelineError(error: unknown, fallbackMessage: string | null): string {
  const rawMessage = error instanceof Error ? error.message : String(error)

  // Context window overflow — thrown by OpenAI/Anthropic when
  // history + tools + prompt exceed the model's max tokens.
  if (/maximum context length|context_length_exceeded|prompt is too long/i.test(rawMessage)) {
    return `⚠️ Conversation is too long for this model's context window. Clear the chat or shorten the system prompt.\n\n${rawMessage}`
  }
  // Auth / key issues.
  if (/api[_\- ]?key|authentication|could not resolve auth|unauthorized|401/i.test(rawMessage)) {
    return `⚠️ AI provider auth failed. Check the API key env var on the server.\n\n${rawMessage}`
  }
  // Rate limiting.
  if (/rate limit|429|quota|insufficient_quota/i.test(rawMessage)) {
    return `⚠️ AI provider rate limit / quota hit. Try again in a moment or swap model provider.\n\n${rawMessage}`
  }
  // Anything else — show the raw text. Include the agent's
  // configured fallback as a trailing context hint when it's set
  // and different from the generic default.
  const hint = fallbackMessage ? `\n\n(Agent fallback: "${fallbackMessage}")` : ''
  return `⚠️ Error: ${rawMessage}${hint}`
}

async function logUsage(supabase: SupabaseAdmin, log: UsageLogInsert): Promise<void> {
  const { error } = await supabase.from('usage_logs').insert(log)
  if (error) console.error('[chat-pipeline] Failed to log usage:', error)
}

/**
 * Multi-turn tool-calling loop: keep calling the model as long as it emits
 * tool_calls, executing each against Composio and feeding results back.
 * Bounded by MAX_TOOL_ITERATIONS to prevent runaway loops.
 */
/**
 * Route a single tool call to the right executor:
 *  - built-in name (web_search / deep_research) → builtins.execute
 *  - anything else → Composio via executeAgentToolCall
 * Returns a { call, content } pair so the caller can feed a well-shaped
 * role:'tool' message back to the LLM.
 */
async function dispatchToolCall(
  supabase: SupabaseAdmin,
  call: { id: string; type: 'function'; function: { name: string; arguments: string } },
  ctx: AgentToolContext | null,
  builtins: BuiltinToolsBundle | null,
  meta: { conversationId: string },
): Promise<{ call: typeof call; content: string }> {
  const name = call.function.name
  // Built-ins take priority — they can't collide with Composio tool
  // slugs (which are UPPERCASE_SNAKE), but belt-and-suspenders.
  if (builtins && builtins.tools.some(t => t.function.name === name)) {
    try {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
      const content = await builtins.execute(name, args)
      return { call, content }
    } catch (err) {
      return { call, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }
    }
  }
  if (!ctx) {
    return { call, content: JSON.stringify({ error: `Unknown tool: ${name}` }) }
  }
  const r = await executeAgentToolCall(supabase, ctx, call, { conversationId: meta.conversationId })
  return { call, content: r.content }
}

async function runAgenticLoop(
  supabase: SupabaseAdmin,
  initialMessages: ChatMessage[],
  tools: Parameters<typeof generateWithTools>[1],
  ctx: AgentToolContext | null,
  builtins: BuiltinToolsBundle | null,
  modelConfig: ModelConfig,
  meta: { conversationId: string }
): Promise<string> {
  const working: ChatMessage[] = [...initialMessages]
  let finalText = ''

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const round = await generateWithTools(working, tools, modelConfig)

    // Track the assistant's response (including any tool_calls) so the next
    // turn has context.
    working.push(round.assistantMessage)

    if (round.toolCalls.length === 0) {
      finalText = round.text ?? ''
      break
    }

    // Execute tool calls in parallel — each one is independent. Dispatch
    // based on name: built-in tools run directly, everything else goes
    // through the Composio executor.
    const results = await Promise.all(
      round.toolCalls.map((call) => dispatchToolCall(supabase, call, ctx, builtins, meta))
    )

    for (const { call, content } of results) {
      working.push({
        role: 'tool',
        tool_call_id: call.id,
        content,
      })
    }

    // If this was the last iteration and model still wanted tools, use
    // whatever text it gave and break.
    if (i === MAX_TOOL_ITERATIONS - 1) {
      finalText = round.text ?? ''
    }
  }

  // If the model never produced a final text (e.g. last round only had
  // tool_calls), do one more call with no tools to get a summary.
  if (!finalText) {
    try {
      const finalRound = await generateWithTools(working, [], modelConfig)
      finalText = finalRound.text ?? 'I ran into an issue using my tools. Please try again.'
    } catch {
      finalText = 'I ran into an issue using my tools. Please try again.'
    }
  }

  return finalText
}

/**
 * Streaming sibling of runAgenticLoop. Yields progress events while the
 * agent is working so the UI can render a chain-of-thought timeline
 * ("Analyzing your request", "Calling GOOGLECALENDAR_EVENTS_LIST", etc.)
 * instead of staring at an empty bubble for 5–15 seconds.
 *
 * The caller is expected to consume all events; the final text lives in
 * the last 'final' event's data field.
 */
export type ThoughtEvent =
  | { kind: 'thinking'; id: string; trigger: string; items: string[] }
  | { kind: 'tool_call'; id: string; tool: string; args: Record<string, unknown>; status: 'running' }
  | { kind: 'tool_done'; id: string; tool: string; resultPreview: string }
  | { kind: 'final_text'; text: string }

async function* runAgenticLoopStream(
  supabase: SupabaseAdmin,
  initialMessages: ChatMessage[],
  tools: Parameters<typeof generateWithTools>[1],
  ctx: AgentToolContext | null,
  builtins: BuiltinToolsBundle | null,
  modelConfig: ModelConfig,
  meta: { conversationId: string }
): AsyncGenerator<ThoughtEvent> {
  const working: ChatMessage[] = [...initialMessages]
  let finalText = ''

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    yield {
      kind: 'thinking',
      id: `think-${i}`,
      trigger: i === 0 ? 'Analyzing request' : `Deciding next step (round ${i + 1})`,
      items: [],
    }

    const round = await generateWithTools(working, tools, modelConfig)
    working.push(round.assistantMessage)

    if (round.toolCalls.length === 0) {
      finalText = round.text ?? ''
      break
    }

    // Emit a tool_call event per call + execute them in parallel.
    const calls = round.toolCalls.map((call) => {
      let parsedArgs: Record<string, unknown> = {}
      try { parsedArgs = JSON.parse(call.function.arguments) as Record<string, unknown> } catch { /* ignore */ }
      return { call, parsedArgs }
    })
    for (const { call, parsedArgs } of calls) {
      yield { kind: 'tool_call', id: call.id, tool: call.function.name, args: parsedArgs, status: 'running' }
    }

    const results = await Promise.all(
      calls.map(({ call }) => dispatchToolCall(supabase, call, ctx, builtins, meta))
    )

    for (const { call, content } of results) {
      // Compress the result for the preview — the full content goes to
      // the model as tool context, but the UI only needs a one-liner.
      const preview = summarizeToolResult(content)
      yield { kind: 'tool_done', id: call.id, tool: call.function.name, resultPreview: preview }

      working.push({
        role: 'tool',
        tool_call_id: call.id,
        content,
      })
    }

    if (i === MAX_TOOL_ITERATIONS - 1) {
      finalText = round.text ?? ''
    }
  }

  if (!finalText) {
    try {
      const finalRound = await generateWithTools(working, [], modelConfig)
      finalText = finalRound.text ?? 'I ran into an issue using my tools. Please try again.'
    } catch {
      finalText = 'I ran into an issue using my tools. Please try again.'
    }
  }

  yield { kind: 'final_text', text: finalText }
}

/**
 * One-liner preview of a tool result — trimmed, collapsed whitespace,
 * and truncated so the chain-of-thought step stays compact.
 */
function summarizeToolResult(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= 120) return collapsed
  return collapsed.slice(0, 117) + '…'
}
