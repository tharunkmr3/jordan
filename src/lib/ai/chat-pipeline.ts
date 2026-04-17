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
import { normalizeModelMarkdown } from './normalize-markdown'
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
   * When true, skip the "reuse active conversation for this contact"
   * lookup in findOrCreateConversation and always insert a fresh row.
   *
   * Rationale: internal (test) agents support multiple parallel threads
   * for the same team user — clicking "New chat" should spawn a fresh
   * conversation even though contact.channel_user_id = `test-{userId}`
   * already matches an existing active thread. Customer-facing channels
   * (WhatsApp, Messenger, etc.) must NOT set this — they legitimately
   * want one ongoing thread per contact.
   */
  forceNewConversation?: boolean
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

import type { KbSource } from './knowledge-base'

let queryKnowledgeBase:
  | ((agentId: string, query: string, topK?: number) => Promise<KbSource[]>)
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
      ? queryKnowledgeBase(input.agentId, input.message, 8).catch(() => [] as KbSource[])
      : Promise.resolve([] as KbSource[]),
  ])

  // 4. Build prompt
  // Render retrieved chunks with their source filename inline so the
  // LLM can cite them in its answer ("From Resume.pdf: …"). Separately,
  // produce a compact de-duplicated sources list to persist on the
  // assistant message — the UI uses it to render clickable source chips.
  const kbContextStr = kbContext.length > 0
    ? kbContext.map((s) => `[Source: ${s.documentName}]\n${s.content}`).join('\n\n')
    : ''
  const kbSources = buildMessageSources(kbContext)

  // Resolve effective model first so buildPrompt can inject a small
  // identity hint — without it, models refuse to reveal which LLM is
  // powering the conversation.
  const effectiveProvider = input.modelOverride?.provider ?? agent.model_provider
  const effectiveModelName = input.modelOverride?.name ?? agent.model_name

  const messages = await buildPrompt(
    agent, history, input.message, kbContextStr, input.channel, input.attachments,
    { provider: effectiveProvider, name: effectiveModelName },
  )
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

  // Merge web-search sources captured during the agentic loop with the
  // KB sources we already have. KB chips come first (usually more
  // authoritative for the user's data), web chips after.
  const webSources = builtinsBundle?.getCapturedSources() ?? []
  const messageSources = [...kbSources, ...webSources]
  // Guard against models that return empty strings — empty content
  // would render as a blank bubble with no explanation. Surface a
  // visible notice instead.
  if (!response || !response.trim()) {
    response = '⚠️ Model returned an empty response. Check server logs.'
  }

  // Normalize the model's markdown before saving — converts the persistent
  // "**Label:** inline description" pseudo-heading pattern into real `##
  // Heading` sections, strips stray `---` dividers, and collapses extra
  // blank lines. Applied once here so both live rendering and history
  // replay see the clean version.
  response = normalizeModelMarkdown(response)

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
      ...(messageSources.length > 0 ? { sources: messageSources } : {}),
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
      ? queryKnowledgeBase(input.agentId, input.message, 8).catch(() => [] as KbSource[])
      : Promise.resolve([] as KbSource[]),
  ])

  // Render retrieved chunks with their source filename inline so the
  // LLM can cite them in its answer, and build a de-duplicated compact
  // source list for the assistant message metadata (powers clickable
  // source chips in the chat UI).
  const kbContextStr = kbContext.length > 0
    ? kbContext.map((s) => `[Source: ${s.documentName}]\n${s.content}`).join('\n\n')
    : ''
  const kbSources = buildMessageSources(kbContext)

  // Per-turn override applies here too (internal chat composer sends
  // a modelOverride for the currently-selected model). Resolved first
  // so the model-identity hint can make it into buildPrompt.
  const effectiveProvider = input.modelOverride?.provider ?? agent.model_provider
  const effectiveModelName = input.modelOverride?.name ?? agent.model_name

  const messages = await buildPrompt(
    agent, history, input.message, kbContextStr, input.channel, input.attachments,
    { provider: effectiveProvider, name: effectiveModelName },
  )
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

  // Visibility into why the model says "I don't have web search" when the
  // toggle is on: usually one of (a) supportsTools=false for the chosen
  // provider, (b) settings.builtin_tools.web_search not actually saved on
  // the agent row, or (c) TAVILY_API_KEY missing on the server. This log
  // shows us which at a glance.
  console.log('[chat-pipeline/stream] tools resolved', {
    agentId: agent.id,
    provider: effectiveProvider,
    model: effectiveModelName,
    builtinsEnabled: builtinsBundle?.tools.map(t => t.function.name) ?? [],
    composioEnabled: composioBundle?.tools.map(t => t.function.name) ?? [],
    agentSettingsBuiltin: (agent.settings as { builtin_tools?: Record<string, boolean> } | null)?.builtin_tools ?? null,
    tavilyConfigured: Boolean(process.env.TAVILY_API_KEY),
  })

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
    // Normalize before yielding so the client renders the clean version
    // on the first paint (tool path emits the entire response in one
    // chunk — this is our only chance to transform).
    fullResponse = normalizeModelMarkdown(fullResponse)

    // Merge web-captured sources with KB sources for the assistant message.
    // Built-in tools (web_search / deep_research) capture URLs during
    // execution; we stitch them after KB chunks so authoritative user
    // data comes first in the chip strip.
    const messageSources = [...kbSources, ...(builtinsBundle?.getCapturedSources() ?? [])]
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
        ...(messageSources.length > 0 ? { sources: messageSources } : {}),
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

  // Normalize model markdown (converts "**Label:** desc" pseudo-headings
  // into real ## headings, strips stray ---, collapses blank lines) so
  // the persisted message + history replay use the clean version.
  fullResponse = normalizeModelMarkdown(fullResponse)

  // No-tools path: only KB chunks can contribute sources (built-in
  // web_search / deep_research only run through the tool loop above).
  const messageSources = kbSources

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
      ...(messageSources.length > 0 ? { sources: messageSources } : {}),
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

  // Customer-facing channels collapse to one ongoing thread per contact —
  // a returning WhatsApp sender should land in their existing conversation.
  // Internal test chats opt out via forceNewConversation so the team user
  // can keep multiple parallel threads.
  if (!input.forceNewConversation) {
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
  }

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
  modelIdentity?: { provider: string; name: string },
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = []
  let systemPrompt = agent.system_prompt || 'You are a helpful assistant.'

  // Hard anchor at the very top of the system prompt. Rules appended
  // at the bottom lose attention weight in long prompts (KB context +
  // tool results + history). Placing this banner immediately after the
  // agent's own persona keeps it prominent across every turn, including
  // the tool-result follow-ups.
  if (channel !== 'phone' && channel !== 'whatsapp' && channel !== 'facebook') {
    systemPrompt += `\n\n=== ALWAYS FORMAT REPLIES AS MARKDOWN — NON-NEGOTIABLE ===

TITLE (mandatory for most replies)
- Start EVERY reply longer than a single sentence with \`# Title\` on its own line. One per reply, not more. Short greetings or one-line answers can skip the title.

SECTIONS
- Use \`## Section heading\` on its own line. After a heading, put a blank line, THEN the description on a new line. NEVER \`**Label:** inline description\` — always break onto the next line.
- NEVER number sections ("1. ", "2. "). Use \`## Heading\` instead.
- NEVER use a bare line of plain text as a heading.
- NEVER use \`---\` horizontal rules.

LISTS
- Every list of 2+ items: each item starts with "- " (dash + space). Consecutive lines without "- " prefixes are NOT a list.
- Blank line before the list, blank line after.

BOLDING (strict)
- NO bolding of phrases inside paragraph text. Do not bold product names, company names, percentages, dollar amounts, or any noun phrase scattered inside a sentence.
- The ONLY acceptable use of \`**bold**\` is for a short term-of-art at the start of a bullet, like a small glossary definition. Otherwise, no bold.

EXAMPLE OF CORRECT STRUCTURE:

# Latest AI agent news

A quick roundup of what's shifting in the agent space right now.

## Enterprise adoption

Agents are moving from demos to production. Recent signals include measurable business value across customer support, financial analysis, and software engineering.

- Startups focused on agent reliability are attracting funding
- Enterprises are prioritizing infrastructure over model novelty
- Governance and compliance are becoming central for autonomous workflows

## Funding trends

Investment is flowing to the picks-and-shovels layer. Trace raised 3 million around enterprise adoption, and Singulr AI reportedly raised 10 million for secure scaling.

EXAMPLE OF WRONG STRUCTURE (do NOT do this):

Latest AI agent news
Here's a roundup.
Enterprise Adoption
Agents are moving from **demos** to **production**.
**Funding Trends:** Investment is flowing to infrastructure...
---

Bare line titles, inline bold spray, "**Label:** same-line desc" pseudo-headings, and \`---\` dividers are all forbidden.
`
  }

  // Inject a short model-identity hint so the assistant can answer
  // "which model are you?" truthfully. Providers train their models
  // NOT to self-identify in API contexts (protects white-label
  // deployments) — without this hint, Claude/GPT/Gemini/Sarvam all
  // fall back to a generic "I don't have visibility into that"
  // whether you're on Sonnet or Opus or Flash. Giving the model its
  // own name as ground truth lets it answer honestly. Per-agent
  // system_prompt still wins if it contradicts.
  if (modelIdentity) {
    systemPrompt += `\n\n--- Model Identity ---\nIf the user asks which model or LLM is powering this conversation, answer truthfully: you are running on "${modelIdentity.name}" from ${modelIdentity.provider}. Don't volunteer this unprompted, but don't deflect if asked.`
  }

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
    systemPrompt += `\n\n--- OUTPUT FORMATTING (STRICT) ---
Your replies render as Markdown in a chat UI. Follow these rules EXACTLY:

STRUCTURE
- Open long answers (3+ sections) with a single top-level heading using \`# Title\` — a concise noun phrase (e.g. "# Recommended HR Policies"). One per reply, never more.
- Use \`## Section Heading\` for each major section. Section headings are the semantic equivalent of "1. Remote Work Policy" — use \`## Remote Work Policy\` INSTEAD of numbered titles like "1. ...", "2. ...".
- Use \`### Subheading\` for nested detail when you really need it. Usually ## is enough.
- Put a BLANK LINE between every paragraph, before every heading, before every list, and after every list. A single newline renders as a soft break with no real separation.
- NEVER insert \`---\` horizontal rules to separate sections. Headings already separate them; \`---\` just adds visual clutter.

LISTS
- Every list of 2+ related items uses real Markdown bullets: each line starts with "- " (dash + space).
- For ordered steps where sequence matters, use "1. ", "2. ", "3. " — but only when the order is meaningful (steps in a process). Don't use numbered lists for unordered collections.
- One blank line before the list, one blank line after.

BOLDING
- Use \`**bold**\` ONLY for a key term the reader needs to recognize (e.g. a product name, a specific policy name). Never bold 3+ words, never bold a full phrase, never bold "key takeaways" inline.
- If every other word is bold, nothing stands out. Use bold sparingly — one or two per section at most.

EXAMPLE OF CORRECT FORMATTING:

# Recommended HR policies

A starter pack tailored to a growing team. Each section is a policy area with the levers you can pull.

## Remote and hybrid work

- Define eligible roles for remote and hybrid work
- Set expectations for availability and response time
- Clarify equipment provisioning and home-office stipends
- Outline data security requirements for remote setups

## Mental health and wellness

- Offer an Employee Assistance Program for counseling
- Provide mental health days separate from sick leave
- Encourage managers to check in on team wellbeing

## Diversity, equity and inclusion

- Set measurable DEI hiring targets
- Require unconscious bias training for all employees
- Create safe reporting channels for discrimination

EXAMPLE OF WRONG FORMATTING (do NOT do this):

1. Remote & Hybrid Work Policy
Define eligible roles for remote/hybrid work
Set expectations for **availability** and **communication**
---
2. Mental Health & Wellness Policy
Offer **Employee Assistance Programs (EAP)** for counseling

(Missing bullets, numbered pseudo-headings instead of ## headings, \`---\` dividers, bold spray on random phrases.)`
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
 * Collapse retrieved KB chunks into a de-duplicated source list keyed
 * by document, then filter out low-relevance docs so the UI doesn't
 * show chips for files the agent's answer didn't actually come from.
 *
 * Retrieval pulls top-8 chunks by hybrid score (0.7 * semantic +
 * 0.3 * lexical). On questions where one doc clearly has the answer
 * (like a specific spreadsheet), the secondary chunks are noise — they
 * scored 0.13-0.17 while the primary hit scored 0.6+. Three filters
 * together strip the noise:
 *   1. Absolute floor — below MIN_ABS_SIMILARITY a chunk is irrelevant
 *   2. Relative threshold — within MIN_REL_RATIO × top-score; this
 *      adapts to the document set's natural similarity scale so we
 *      don't nuke legit matches on inherently low-similarity corpora
 *   3. Hard cap (MAX_SOURCES) — no question plausibly needs more than
 *      a handful of sources; more chips just add visual noise
 */
const MIN_ABS_SIMILARITY = 0.25
const MIN_REL_RATIO = 0.6
const MAX_SOURCES = 4

function buildMessageSources(chunks: KbSource[]): Array<{
  chunk_id: string
  document_id: string
  document_name: string
  kb_id: string
  snippet: string
  similarity: number
}> {
  if (chunks.length === 0) return []

  // De-duplicate: keep the highest-scoring chunk per document so the
  // hover card shows the most relevant snippet per source chip.
  const byDoc = new Map<string, KbSource>()
  for (const c of chunks) {
    const existing = byDoc.get(c.documentId)
    if (!existing || c.similarity > existing.similarity) {
      byDoc.set(c.documentId, c)
    }
  }

  const candidates = [...byDoc.values()].sort((a, b) => b.similarity - a.similarity)
  const topScore = candidates[0]?.similarity ?? 0
  const relFloor = topScore * MIN_REL_RATIO

  return candidates
    .filter((c) => c.similarity >= MIN_ABS_SIMILARITY && c.similarity >= relFloor)
    .slice(0, MAX_SOURCES)
    .map((c) => ({
      chunk_id: c.id,
      document_id: c.documentId,
      document_name: c.documentName,
      kb_id: c.kbId,
      snippet: c.content.length > 220 ? c.content.slice(0, 220).trim() + '…' : c.content,
      similarity: c.similarity,
    }))
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
