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
import { buildKbAgenticTools, type KbAgenticTools } from '@/lib/builtin-tools/kb-tools'
import { normalizeModelMarkdown } from './normalize-markdown'
import {
  STRUCTURED_REPLY_SCHEMA,
  STRUCTURED_REPLY_PROMPT_RIDER,
  parseStructuredReply,
  blocksToMarkdown,
  type StructuredReply,
} from './structured-output'
import { generateStructured } from './models'
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
  /**
   * IDs of kb_documents the user explicitly pinned to this turn via
   * @-mention in the composer. Their chunks are loaded separately from
   * the usual semantic-retrieval path and prepended to the KB context
   * with a "the user referenced this document explicitly" marker so
   * the model treats them as high-priority context.
   */
  kbReferenceIds?: string[]
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
import {
  queryMemories,
  extractFromTurn,
  formatMemoryContext,
  type MemoryHit,
  type MemoryOwner,
} from './memory'

let queryKnowledgeBase:
  | ((agentId: string, query: string, topK?: number) => Promise<KbSource[]>)
  | null = null
let listKbDocuments: ((agentId: string) => Promise<string[]>) | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kb = require('./knowledge-base')
  queryKnowledgeBase = kb.queryKnowledgeBase
  listKbDocuments = kb.listKbDocuments
} catch {
  // Knowledge base module not available yet
}

/**
 * Resolve the memory owner for this turn. Memory only applies to internal
 * agents (agent.settings.is_customer_facing === false) chatting with an
 * authenticated team member — customer-facing surfaces never read or
 * write the memory store.
 *
 * Internal-agent contacts are created with channel_user_id = "test-{authUserId}"
 * by /api/chat (see the teamUser branch there). Parse that back out to
 * identify the owner. Anything that doesn't match the test- prefix (e.g.
 * a WhatsApp contact routed to an internal agent by mistake) returns null
 * and memory is skipped for this turn.
 */
/**
 * Load the full chunked content of explicitly @-mentioned KB documents for
 * this turn. Distinct from the semantic-retrieval path because the user is
 * saying "look at THIS file" — retrieval scores don't matter, we want all
 * the chunks. Returns a rendered context string ready to paste into the
 * system prompt, plus the source chips for message metadata.
 *
 * Scopes to the agent's org to prevent a malicious client from pinning a
 * document it shouldn't have access to.
 */
async function loadPinnedKbContext(
  supabase: SupabaseAdmin,
  orgId: string,
  docIds: string[] | undefined,
): Promise<{ contextStr: string; sources: ReturnType<typeof buildMessageSources> }> {
  if (!docIds || docIds.length === 0) return { contextStr: '', sources: [] }

  // Fetch document names for header annotations and chunk content in a
  // single round-trip via the inner join.
  type Row = {
    id: string
    content: string
    document_id: string
    kb_id: string
    kb_documents: { id: string; name: string } | { id: string; name: string }[] | null
  }

  const { data, error } = await supabase
    .from('kb_chunks')
    .select('id, content, document_id, kb_id, kb_documents!inner(id, name)')
    .in('document_id', docIds)
    .eq('org_id', orgId)
    .order('document_id')

  if (error || !data) return { contextStr: '', sources: [] }

  // Group chunks by document so each file is rendered as a single block.
  const byDoc = new Map<string, { name: string; kbId: string; content: string[] }>()
  for (const r of data as Row[]) {
    const doc = Array.isArray(r.kb_documents) ? r.kb_documents[0] : r.kb_documents
    const name = doc?.name ?? 'Unnamed document'
    const entry = byDoc.get(r.document_id) ?? { name, kbId: r.kb_id, content: [] }
    entry.content.push(r.content)
    byDoc.set(r.document_id, entry)
  }

  // Guardrail — cap total chars so a reference to a giant file can't blow
  // the context window. 80k chars ≈ 20k tokens; plenty for a sanity cap.
  const MAX_CHARS = 80_000
  let total = 0
  const blocks: string[] = []
  const sources: ReturnType<typeof buildMessageSources> = []
  for (const [docId, entry] of byDoc) {
    const joined = entry.content.join('\n\n')
    const slice = joined.length + total > MAX_CHARS ? joined.slice(0, Math.max(0, MAX_CHARS - total)) : joined
    if (!slice) break
    blocks.push(`[Pinned by user: ${entry.name}]\n${slice}`)
    total += slice.length
    sources.push({
      chunk_id: docId, // no single chunk — use doc id so the chip is stable
      document_id: docId,
      document_name: entry.name,
      kb_id: entry.kbId,
      snippet: slice.length > 220 ? slice.slice(0, 220).trim() + '…' : slice,
      similarity: 1, // sorted to front, user-explicit
    })
    if (total >= MAX_CHARS) break
  }

  return { contextStr: blocks.join('\n\n'), sources }
}

function resolveMemoryOwner(agent: Agent, contact: Contact): MemoryOwner | null {
  const settings = agent.settings as { is_customer_facing?: boolean } | null | undefined
  if (settings?.is_customer_facing !== false) return null
  const cid = contact.channel_user_id
  if (!cid || !cid.startsWith('test-')) return null
  const userId = cid.slice('test-'.length)
  // Auth UUIDs are 36 chars. Quick shape check rules out malformed ids.
  if (userId.length < 32) return null
  return { userId, orgId: agent.org_id }
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

  // Memory owner — null for customer-facing agents or anonymous contacts.
  // Memory retrieval and extraction are gated on this being non-null.
  const memoryOwner = resolveMemoryOwner(agent, contact)

  // 3. Save user message, load history, query KB, list KB docs, fetch
  // memories, and load any user-pinned KB docs in parallel. Memory
  // retrieval is a pgvector lookup like KB search, so adding it to the
  // fan-out is free. Pinned docs run alongside the semantic retrieval —
  // they're the "user said: look at THIS file" path.
  const [, history, kbContext, kbDocumentNames, memoryHits, pinned] = await Promise.all([
    saveMessage(supabase, {
      conversation_id: conversation.id,
      org_id: agent.org_id,
      role: 'user',
      content: input.message,
      channel: input.channel,
      // Persist attachments + kb references on the user message so history
      // replay and the inbox bubble renderer can reconstruct the chips.
      metadata: buildUserMessageMetadata(input),
    }),
    loadHistory(supabase, conversation.id, 20),
    queryKnowledgeBase
      ? queryKnowledgeBase(input.agentId, input.message, 8).catch(() => [] as KbSource[])
      : Promise.resolve([] as KbSource[]),
    listKbDocuments
      ? listKbDocuments(input.agentId).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
    memoryOwner
      ? queryMemories(memoryOwner, input.message, 5).catch(() => [] as MemoryHit[])
      : Promise.resolve([] as MemoryHit[]),
    loadPinnedKbContext(supabase, agent.org_id, input.kbReferenceIds).catch(() => ({ contextStr: '', sources: [] as ReturnType<typeof buildMessageSources> })),
  ])

  // 4. Build prompt
  // Pinned docs come first in kbContextStr (marked as explicitly referenced)
  // so the model gives them priority over semantic-retrieval hits. Sources
  // list interleaves pinned entries at the front of the chip strip too.
  const retrievedContextStr = kbContext.length > 0
    ? kbContext.map((s) => `[Source: ${s.documentName}]\n${s.content}`).join('\n\n')
    : ''
  const kbContextStr = [pinned.contextStr, retrievedContextStr].filter(Boolean).join('\n\n')
  const kbSources = [...pinned.sources, ...buildMessageSources(kbContext)]
  const memoryContext = formatMemoryContext(memoryHits)

  // Resolve effective model first so buildPrompt can inject a small
  // identity hint — without it, models refuse to reveal which LLM is
  // powering the conversation.
  const effectiveProvider = input.modelOverride?.provider ?? agent.model_provider
  const effectiveModelName = input.modelOverride?.name ?? agent.model_name

  const messages = await buildPrompt(
    agent, history, input.message, kbContextStr, kbDocumentNames, memoryContext, input.channel, input.attachments,
    { provider: effectiveProvider, name: effectiveModelName },
  )
  const modelConfig: ModelConfig = {
    provider: effectiveProvider,
    model: effectiveModelName,
    temperature: agent.temperature,
    maxTokens: agent.max_tokens,
  }

  // 5a. Load tools — three bundles that all merge into one tool list:
  //   - Composio integrations (agent-configured OAuth apps)
  //   - Built-in tools (web_search, deep_research) toggled in settings
  //   - KB agentic tools (search_kb, fetch_document) — auto-enabled
  //     whenever the agent has any ready documents. Agentic retrieval
  //     lets the model recover when one-shot retrieval missed the
  //     right chunks (see buildKbAgenticTools for rationale).
  const composioBundle = supportsTools(effectiveProvider)
    ? await buildAgentTools(supabase, agent.id)
    : null
  const builtinsBundle = supportsTools(effectiveProvider)
    ? buildBuiltinTools(agent.settings as Record<string, unknown> | null | undefined)
    : null
  const kbAgenticBundle = supportsTools(effectiveProvider)
    ? await buildKbAgenticTools(supabase, agent.id)
    : null
  const mergedTools: LlmTool[] = [
    ...(composioBundle?.tools ?? []),
    ...(builtinsBundle?.tools ?? []),
    ...(kbAgenticBundle?.tools ?? []),
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
        kbAgenticBundle,
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

  // Collect citation sources from every surface that produced content:
  //  - kbSources: chunks from the automatic first-turn retrieval
  //  - kbAgenticBundle: chunks the agent pulled via search_kb / fetch_document
  //  - builtinsBundle: URLs visited via web_search / deep_research
  // KB sources come first (usually the user's own data, highest
  // authority); web sources after. Dedupe across kbSources and the
  // agentic set so a chunk retrieved both automatically and by tool
  // call only produces one chip.
  const agenticKbSources = kbAgenticBundle?.getCapturedSources() ?? []
  const webSources = builtinsBundle?.getCapturedSources() ?? []
  const kbSourcesByDoc = new Set(kbSources.map((s) => s.document_id))
  const mergedKbSources = [
    ...kbSources,
    ...agenticKbSources.filter((s) => !('document_id' in s) || !kbSourcesByDoc.has((s as { document_id: string }).document_id)),
  ]
  const messageSources = [...mergedKbSources, ...webSources]
  // Guard against models that return empty strings — empty content
  // would render as a blank bubble with no explanation. Surface a
  // visible notice instead.
  if (!response || !response.trim()) {
    response = '⚠️ Model returned an empty response. Check server logs.'
  }

  // Structured output synthesis — on the website channel, convert the
  // freeform draft into a typed Block[] array the UI renders block-by-block.
  // See synthesizeStructured() for the two-stage strategy (fast JSON parse
  // path + API-based synthesis fallback).
  let structured: StructuredReply | null = null
  if (wantsStructuredOutput(input.channel)) {
    structured = await synthesizeStructured(messages, response, modelConfig)
    if (structured) {
      // Use the canonical Markdown derived from blocks as the `content`
      // column. Keeps history exports, KB indexing, and non-structured
      // client fallbacks consistent with what the UI renders.
      response = blocksToMarkdown(structured.blocks)
    } else {
      // Synthesis failed — fall through to the legacy normalizer so the
      // prose at least gets its `**Label:**` pseudo-headings fixed up.
      response = normalizeModelMarkdown(response)
    }
  } else {
    // Non-website (phone/whatsapp/fb): prose is the canonical form.
    response = normalizeModelMarkdown(response)
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
      ...(messageSources.length > 0 ? { sources: messageSources } : {}),
      ...(structured ? { structured } : {}),
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

  // 8. Memory extraction — fire and forget. Gated on being an internal
  // agent with an identified owner; customer-facing agents short-circuit.
  if (memoryOwner) {
    extractFromTurn({
      owner: memoryOwner,
      lastUserMessage: input.message,
      lastAssistantMessage: response,
      sourceMessageId: savedMsg?.id ?? null,
    }).catch(err => console.error('[chat-pipeline] Memory extraction failed:', err))
  }

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
): AsyncGenerator<{ type: 'token' | 'meta' | 'thought' | 'structured'; data: string }> {
  const supabase = createAdminClient()

  const agent = await loadAgent(supabase, input.agentId)
  const contact = await findOrCreateContact(supabase, agent.org_id, input)
  const conversation = await findOrCreateConversation(supabase, agent, contact, input)

  const memoryOwner = resolveMemoryOwner(agent, contact)

  const [, history, kbContext, kbDocumentNames, memoryHits, pinned] = await Promise.all([
    saveMessage(supabase, {
      conversation_id: conversation.id,
      org_id: agent.org_id,
      role: 'user',
      content: input.message,
      channel: input.channel,
      metadata: buildUserMessageMetadata(input),
    }),
    loadHistory(supabase, conversation.id, 20),
    queryKnowledgeBase
      ? queryKnowledgeBase(input.agentId, input.message, 8).catch(() => [] as KbSource[])
      : Promise.resolve([] as KbSource[]),
    listKbDocuments
      ? listKbDocuments(input.agentId).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
    memoryOwner
      ? queryMemories(memoryOwner, input.message, 5).catch(() => [] as MemoryHit[])
      : Promise.resolve([] as MemoryHit[]),
    loadPinnedKbContext(supabase, agent.org_id, input.kbReferenceIds).catch(() => ({ contextStr: '', sources: [] as ReturnType<typeof buildMessageSources> })),
  ])

  // Pinned docs lead the KB context (user said "look at THIS"); retrieved
  // chunks follow. Source chips are interleaved the same way.
  const retrievedContextStr = kbContext.length > 0
    ? kbContext.map((s) => `[Source: ${s.documentName}]\n${s.content}`).join('\n\n')
    : ''
  const kbContextStr = [pinned.contextStr, retrievedContextStr].filter(Boolean).join('\n\n')
  const kbSources = [...pinned.sources, ...buildMessageSources(kbContext)]
  const memoryContext = formatMemoryContext(memoryHits)

  // Per-turn override applies here too (internal chat composer sends
  // a modelOverride for the currently-selected model). Resolved first
  // so the model-identity hint can make it into buildPrompt.
  const effectiveProvider = input.modelOverride?.provider ?? agent.model_provider
  const effectiveModelName = input.modelOverride?.name ?? agent.model_name

  const messages = await buildPrompt(
    agent, history, input.message, kbContextStr, kbDocumentNames, memoryContext, input.channel, input.attachments,
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
  const kbAgenticBundle = supportsTools(effectiveProvider)
    ? await buildKbAgenticTools(supabase, agent.id)
    : null
  const mergedTools: LlmTool[] = [
    ...(composioBundle?.tools ?? []),
    ...(builtinsBundle?.tools ?? []),
    ...(kbAgenticBundle?.tools ?? []),
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
    kbAgenticEnabled: kbAgenticBundle?.tools.map(t => t.function.name) ?? [],
    agentSettingsBuiltin: (agent.settings as { builtin_tools?: Record<string, boolean> } | null)?.builtin_tools ?? null,
    tavilyConfigured: Boolean(process.env.TAVILY_API_KEY),
    voyageConfigured: Boolean(process.env.VOYAGE_API_KEY),
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
        kbAgenticBundle,
        modelConfig,
        { conversationId: conversation.id },
      )) {
        if (ev.kind === 'final_text') {
          // Authoritative full text for DB save. Client already has
          // the streamed version from token_delta events.
          fullResponse = ev.text
        } else if (ev.kind === 'token_delta') {
          // Forward incremental model text to the client in the same
          // 'token' shape the no-tools path uses, so the client renders
          // word-by-word without caring which path produced it.
          yield { type: 'token', data: ev.text }
        } else {
          // thinking / tool_call / tool_done → chain-of-thought timeline
          yield { type: 'thought', data: JSON.stringify(ev) }
        }
      }
    } catch (error) {
      console.error('[chat-pipeline] Tool loop error:', error)
      fullResponse = formatPipelineError(error, agent.fallback_message)
      yield { type: 'token', data: fullResponse }
    }
    if (!fullResponse || !fullResponse.trim()) {
      fullResponse = '⚠️ Model returned an empty response. Check server logs.'
    }

    // Merge citation sources from every surface that produced content
    // during this turn: first-turn KB retrieval, agentic KB tool calls
    // (search_kb / fetch_document), and web search. Dedup KB chunks by
    // document_id so a file retrieved both automatically and by tool
    // collapses to a single chip.
    const agenticKbSources = kbAgenticBundle?.getCapturedSources() ?? []
    const webSources = builtinsBundle?.getCapturedSources() ?? []
    const kbSourcesByDoc = new Set(kbSources.map((s) => s.document_id))
    const mergedKbSources = [
      ...kbSources,
      ...agenticKbSources.filter((s) => !('document_id' in s) || !kbSourcesByDoc.has((s as { document_id: string }).document_id)),
    ]
    const messageSources = [...mergedKbSources, ...webSources]

    // Structured synthesis: after tokens finish streaming, convert the
    // freeform prose into a typed Block[]. Yield a 'structured' event so
    // the client can swap from streamed-markdown rendering to the
    // deterministic block renderer (same UX pattern as Linear AI / Notion
    // AI — partial prose while generating, perfect structure on finish).
    let structured: StructuredReply | null = null
    if (wantsStructuredOutput(input.channel)) {
      structured = await synthesizeStructured(messages, fullResponse, modelConfig)
      if (structured) {
        fullResponse = blocksToMarkdown(structured.blocks)
        yield { type: 'structured', data: JSON.stringify(structured) }
      } else {
        fullResponse = normalizeModelMarkdown(fullResponse)
      }
    } else {
      fullResponse = normalizeModelMarkdown(fullResponse)
    }

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
        ...(structured ? { structured } : {}),
      },
    }).then((res) => {
      // Once the message has an id, fire off memory extraction for
      // internal-agent turns. Kept inside .then() so sourceMessageId is
      // accurate — running earlier would lose the FK link.
      if (memoryOwner) {
        extractFromTurn({
          owner: memoryOwner,
          lastUserMessage: input.message,
          lastAssistantMessage: fullResponse,
          sourceMessageId: res.data?.id ?? null,
        }).catch(err => console.error('[chat-pipeline] Memory extraction failed:', err))
      }
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

  // No-tools path: only KB chunks can contribute sources (built-in
  // web_search / deep_research only run through the tool loop above).
  const messageSources = kbSources

  // Structured synthesis on the website channel — same pattern as the
  // tool path. Client sees tokens stream in, then the 'structured' event
  // triggers a swap to the block renderer for the final rendering.
  let structured: StructuredReply | null = null
  if (wantsStructuredOutput(input.channel)) {
    structured = await synthesizeStructured(messages, fullResponse, modelConfig)
    if (structured) {
      fullResponse = blocksToMarkdown(structured.blocks)
      yield { type: 'structured', data: JSON.stringify(structured) }
    } else {
      fullResponse = normalizeModelMarkdown(fullResponse)
    }
  } else {
    fullResponse = normalizeModelMarkdown(fullResponse)
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
      ...(messageSources.length > 0 ? { sources: messageSources } : {}),
      ...(structured ? { structured } : {}),
    },
  }).then((res) => {
    if (memoryOwner) {
      extractFromTurn({
        owner: memoryOwner,
        lastUserMessage: input.message,
        lastAssistantMessage: fullResponse,
        sourceMessageId: res.data?.id ?? null,
      }).catch(err => console.error('[chat-pipeline] Memory extraction failed:', err))
    }
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

/**
 * Assemble the `metadata` JSON for a user message insert. Returns undefined
 * when there's nothing to persist so we don't write empty-object rows.
 * Lives here (not inline in the pipeline bodies) so both streaming and
 * non-streaming paths stay in sync on what they persist.
 */
function buildUserMessageMetadata(input: PipelineInput): Record<string, unknown> | undefined {
  const hasAttachments = Boolean(input.attachments && input.attachments.length > 0)
  const hasKbRefs = Boolean(input.kbReferenceIds && input.kbReferenceIds.length > 0)
  if (!hasAttachments && !hasKbRefs) return undefined
  return {
    ...(hasAttachments ? { attachments: input.attachments } : {}),
    ...(hasKbRefs ? { kb_reference_ids: input.kbReferenceIds } : {}),
  }
}

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
  kbDocumentNames: string[],
  memoryContext: string,
  channel: ChannelType | undefined,
  attachments: UploadedAttachment[] | undefined,
  modelIdentity?: { provider: string; name: string },
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = []
  let systemPrompt = agent.system_prompt || 'You are a helpful assistant.'

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

  // Memories come before the KB block so durable user facts can inform
  // how KB content is interpreted (e.g. "user prefers Hindi" lets the
  // agent read English KB content and reply in Hindi). Only populated
  // for internal agents — customer-facing agents pass "" here.
  if (memoryContext) {
    systemPrompt += `\n\n--- What you remember about this user ---\n${memoryContext}\n--- End memories ---\n\nThese are durable facts from prior conversations. Use them to personalize your reply, but don't announce them unprompted unless clearly relevant.`
  }

  if (kbContext) {
    systemPrompt += `\n\n--- Reference Material ---\n${kbContext}\n--- End Reference ---\n\nAnswer the user's question using the material above when relevant. If it doesn't help, use your general knowledge.`
  }

  // Ground-truth inventory of the agent's files. Without this the model
  // treats "retrieved chunks" as equivalent to "everything I have access
  // to" and will tell the user "I only see these four files" when the
  // KB actually holds eight. With the list present, the agent can answer
  // "do you have my resume?" truthfully, and can reason about whether a
  // question is answerable from retrieved content vs. a file whose
  // chunks simply didn't surface for this query.
  if (kbDocumentNames.length > 0) {
    const fileList = kbDocumentNames.map((n) => `- ${n}`).join('\n')
    systemPrompt += `\n\n--- Available Files ---\n${fileList}\n\nThe reference material above (if any) contains the most relevant passages for the current query only — it does not represent every file you have access to. If the user asks about a specific file by name, you can confirm it's available from this list even if its content wasn't included in the reference material. Don't claim a file is missing unless it's not in the list.`
  }

  // Persona / implementation-leak guard. The reference-material blocks
  // above tell the model WHAT it has; this rule tells it HOW to TALK
  // about that material when replying. Without the rule, models mirror
  // whatever label we gave the block ("Knowledge Base", "reference
  // material", "your files") and leak it into replies ("based on your
  // knowledge base, your phone number is…"). The rule is short and
  // imperative so it survives long-prompt attention drift.
  if (kbContext || kbDocumentNames.length > 0) {
    systemPrompt += `\n\n--- Voice ---\nAnswer naturally, as if the information came from your own memory. Don't mention "knowledge base", "reference material", "retrieved passages", "your files", "tools", "documents", "the system", or any other implementation-level vocabulary in your reply. Just answer the question.`
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
    // inbox — all surfaces that render structured replies.
    //
    // On this channel the reply shape is enforced by the provider API
    // (response_format on OpenAI, forced tool on Anthropic, JSON mode on
    // Gemini). The rider is just semantic guidance for block selection;
    // the schema is the real contract.
    systemPrompt += STRUCTURED_REPLY_PROMPT_RIDER
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

// ---------------------------------------------------------------------------
// Structured reply synthesis
//
// On the website channel, the assistant's reply MUST be a typed Block[]
// array — the UI renders each block deterministically, so format drift
// stops being a runtime failure mode. This helper owns the "how do we
// get blocks" step regardless of which provider or whether tools ran.
//
// Two-stage strategy:
//
//  1) Fast path. If `draft` is already valid JSON against the schema
//     (happens when the model natively used response_format), parse
//     and return — no extra API call, no extra latency.
//
//  2) Synthesis path. Otherwise, make one more call through
//     generateStructured(): send the full conversation + the freeform
//     draft + an instruction to "reformat as JSON". This is what makes
//     structured output reliable across providers whose first call
//     emitted prose (Anthropic-with-tools, Gemini, older OpenAI).
//
// When synthesis fails (network error, malformed JSON even after strict
// mode), returns null. The caller then falls back to the freeform draft
// as plain markdown — the chat never breaks, it just loses the block
// renderer's visual hierarchy for that one reply.
// ---------------------------------------------------------------------------

async function synthesizeStructured(
  conversation: ChatMessage[],
  draft: string | null,
  modelConfig: ModelConfig,
): Promise<StructuredReply | null> {
  // Fast path: the draft is already valid structured JSON.
  if (draft) {
    const direct = parseStructuredReply(draft)
    if (direct) return direct
  }

  const synthMessages: ChatMessage[] = draft
    ? [
        ...conversation,
        { role: 'assistant', content: draft },
        {
          role: 'user',
          content: 'Reformat your previous reply into a single JSON object matching the required schema. Preserve ALL information verbatim — do not paraphrase, do not add content, do not drop content. Headings become heading blocks, list items become bullets, tables become table blocks. Return ONLY the JSON object, no prose, no code fences.',
        },
      ]
    : conversation

  try {
    const jsonString = await generateStructured(synthMessages, STRUCTURED_REPLY_SCHEMA as Record<string, unknown>, modelConfig)
    return parseStructuredReply(jsonString)
  } catch (err) {
    console.error('[chat-pipeline] Structured synthesis failed:', err)
    return null
  }
}

/**
 * Website channel = structured output surface. Phone and messengers get
 * prose (a TTS engine can't read a block-kit card, WhatsApp strips widgets).
 */
function wantsStructuredOutput(channel: ChannelType | undefined): boolean {
  return channel === 'website' || channel == null
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
  kbAgentic: KbAgenticTools | null,
  meta: { conversationId: string },
): Promise<{ call: typeof call; content: string }> {
  const name = call.function.name
  const argsJson = call.function.arguments || '{}'
  // Route priority: built-ins → KB agentic → Composio. No collisions
  // possible (built-ins use snake_case names, KB tools are search_kb /
  // fetch_document, Composio slugs are UPPERCASE_SNAKE) but we check
  // in order anyway so future naming accidents stay deterministic.
  if (builtins && builtins.tools.some(t => t.function.name === name)) {
    try {
      const args = JSON.parse(argsJson) as Record<string, unknown>
      const content = await builtins.execute(name, args)
      return { call, content }
    } catch (err) {
      return { call, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }
    }
  }
  if (kbAgentic && kbAgentic.tools.some(t => t.function.name === name)) {
    try {
      const args = JSON.parse(argsJson) as Record<string, unknown>
      const content = await kbAgentic.execute(name, args)
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
  kbAgentic: KbAgenticTools | null,
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
      round.toolCalls.map((call) => dispatchToolCall(supabase, call, ctx, builtins, kbAgentic, meta))
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
  | { kind: 'token_delta'; text: string }
  | { kind: 'final_text'; text: string }

async function* runAgenticLoopStream(
  supabase: SupabaseAdmin,
  initialMessages: ChatMessage[],
  tools: Parameters<typeof generateWithTools>[1],
  ctx: AgentToolContext | null,
  builtins: BuiltinToolsBundle | null,
  kbAgentic: KbAgenticTools | null,
  modelConfig: ModelConfig,
  meta: { conversationId: string }
): AsyncGenerator<ThoughtEvent> {
  const working: ChatMessage[] = [...initialMessages]

  // Tool-discovery phase: loop with tools available, executing any
  // tool calls the model requests. When the model returns no tool
  // calls, we break and stream the final answer. The text from this
  // phase (round.text) is discarded — the final answer is re-generated
  // as a stream below so the client can render it word-by-word.
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    yield {
      kind: 'thinking',
      id: `think-${i}`,
      trigger: i === 0 ? 'Analyzing request' : `Deciding next step (round ${i + 1})`,
      items: [],
    }

    const round = await generateWithTools(working, tools, modelConfig)

    if (round.toolCalls.length === 0) {
      // Model is done with tools. Proceed to streaming phase.
      break
    }

    working.push(round.assistantMessage)

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
      calls.map(({ call }) => dispatchToolCall(supabase, call, ctx, builtins, kbAgentic, meta))
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
  }

  // Streaming phase: final answer with no tools, so the model streams
  // tokens instead of bundling a text+tool_calls response. One extra
  // API call vs. the old path, but the whole point is word-by-word UX.
  let finalText = ''
  try {
    for await (const chunk of streamResponse(working, modelConfig)) {
      finalText += chunk
      yield { kind: 'token_delta', text: chunk }
    }
  } catch (err) {
    console.error('[chat-pipeline/tool-loop] Final stream error:', err)
  }

  if (!finalText.trim()) {
    finalText = 'I ran into an issue using my tools. Please try again.'
    yield { kind: 'token_delta', text: finalText }
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
