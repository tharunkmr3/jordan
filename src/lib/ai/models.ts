// ============================================================================
// Jordon AI Platform — Multi-Model Router
// Abstracts different AI providers behind a unified interface
// ============================================================================

import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** For tool messages: the tool_call_id this result answers. */
  tool_call_id?: string
  /** For assistant messages that called tools: the list of calls. */
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export interface ModelConfig {
  provider: string
  model?: string
  temperature?: number
  maxTokens?: number
}

/**
 * OpenAI-compatible tool schema — matches what Composio returns.
 */
export interface LlmToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface ToolCallChoice {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface GenerateWithToolsResult {
  /** Final assistant text, if the model chose to respond instead of (or after) calling tools. */
  text: string | null
  /** Tool calls the model wants to make, if any. */
  toolCalls: ToolCallChoice[]
  /** The assistant message as returned — to feed back into next turn along with tool results. */
  assistantMessage: ChatMessage
}

// Singleton clients — avoid re-creating on every call
let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

let _anthropic: Anthropic | null = null
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _anthropic
}

/**
 * Route a chat completion request to the appropriate AI provider.
 */
export async function generateResponse(
  messages: ChatMessage[],
  config: ModelConfig
): Promise<string> {
  switch (config.provider) {
    case 'openai':
      return callOpenAI(messages, config)
    case 'anthropic':
      return callAnthropic(messages, config)
    case 'sarvam':
      return callSarvam(messages, config)
    case 'gemini':
      return callGemini(messages, config)
    default:
      return callOpenAI(messages, config)
  }
}

/**
 * Stream a response — returns an async generator of text chunks.
 * Falls back to non-streaming for providers that don't support it.
 */
export async function* streamResponse(
  messages: ChatMessage[],
  config: ModelConfig
): AsyncGenerator<string> {
  switch (config.provider) {
    case 'openai':
      yield* streamOpenAI(messages, config)
      break
    case 'anthropic':
      yield* streamAnthropic(messages, config)
      break
    default: {
      // Fallback: generate full response and yield at once
      const response = await generateResponse(messages, config)
      yield response
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function callOpenAI(
  messages: ChatMessage[],
  config: ModelConfig
): Promise<string> {
  const response = await getOpenAI().chat.completions.create({
    model: config.model || 'gpt-4o-mini',
    messages: messages.map(toOpenAiMessage),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 1024,
  })
  return response.choices[0]?.message?.content || ''
}

/**
 * Run a single chat-completion round with tools. The caller executes any
 * returned tool calls and then calls again with tool-result messages
 * appended. Currently implemented for OpenAI and Anthropic.
 */
export async function generateWithTools(
  messages: ChatMessage[],
  tools: LlmToolDef[],
  config: ModelConfig
): Promise<GenerateWithToolsResult> {
  switch (config.provider) {
    case 'anthropic':
      return generateWithToolsAnthropic(messages, tools, config)
    case 'openai':
    default:
      return generateWithToolsOpenAI(messages, tools, config)
  }
}

export function supportsTools(provider: string): boolean {
  return provider === 'openai' || provider === 'anthropic'
}

async function generateWithToolsOpenAI(
  messages: ChatMessage[],
  tools: LlmToolDef[],
  config: ModelConfig
): Promise<GenerateWithToolsResult> {
  const response = await getOpenAI().chat.completions.create({
    model: config.model || 'gpt-4o-mini',
    messages: messages.map(toOpenAiMessage),
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 1024,
  })
  const choice = response.choices[0]?.message
  const rawCalls = (choice?.tool_calls ?? []) as Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  const toolCalls: ToolCallChoice[] = rawCalls
    .filter((c) => c.type === 'function')
    .map((c) => ({ id: c.id, type: 'function', function: c.function }))

  return {
    text: choice?.content ?? null,
    toolCalls,
    assistantMessage: {
      role: 'assistant',
      content: choice?.content ?? '',
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
  }
}

/**
 * Anthropic tool calling uses a different schema. We translate:
 *  - Input tools: OpenAI {type, function: {name, description, parameters}}
 *      → Anthropic { name, description, input_schema }
 *  - Output tool_use blocks → ToolCallChoice shape with stringified args
 */
async function generateWithToolsAnthropic(
  messages: ChatMessage[],
  tools: LlmToolDef[],
  config: ModelConfig
): Promise<GenerateWithToolsResult> {
  const anthropic = getAnthropic()
  const systemMsg = messages.find((m) => m.role === 'system')?.content ?? ''

  const anthTools = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
  }))

  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => toAnthropicMessage(m))

  const res = await anthropic.messages.create({
    model: config.model || 'claude-sonnet-4-20250514',
    max_tokens: config.maxTokens ?? 1024,
    system: systemMsg,
    messages: chatMessages as Parameters<typeof anthropic.messages.create>[0]['messages'],
    temperature: config.temperature ?? 0.7,
    tools: anthTools.length > 0 ? (anthTools as unknown as Parameters<typeof anthropic.messages.create>[0]['tools']) : undefined,
  })

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')

  const toolUses = res.content.filter((b) => b.type === 'tool_use') as unknown as Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>

  const toolCalls: ToolCallChoice[] = toolUses.map((b) => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
  }))

  return {
    text: text || null,
    toolCalls,
    // Stash the full raw assistant content so callers can feed it back unchanged.
    assistantMessage: {
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// Message format adapters
// ---------------------------------------------------------------------------

// OpenAI's SDK uses union types with strict discriminants; we build the
// right shape per-role and cast at the API boundary.
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

function toOpenAiMessage(m: ChatMessage): ChatCompletionMessageParam {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.tool_call_id ?? '',
    }
  }
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.tool_calls as ChatCompletionMessageParam extends infer X
        ? X extends { tool_calls?: infer Y } ? Y : never
        : never,
    } as ChatCompletionMessageParam
  }
  if (m.role === 'system') {
    return { role: 'system', content: m.content }
  }
  return { role: 'user', content: m.content }
}

type AnthropicMsg = {
  role: 'user' | 'assistant'
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        | { type: 'tool_result'; tool_use_id: string; content: string }
      >
}

function toAnthropicMessage(m: ChatMessage): AnthropicMsg {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content }],
    }
  }
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    const blocks: AnthropicMsg['content'] = []
    if (m.content) blocks.push({ type: 'text', text: m.content })
    for (const c of m.tool_calls) {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(c.function.arguments) as Record<string, unknown> } catch { /* ignore */ }
      blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input })
    }
    return { role: 'assistant', content: blocks }
  }
  return { role: m.role as 'user' | 'assistant', content: m.content }
}

async function* streamOpenAI(
  messages: ChatMessage[],
  config: ModelConfig
): AsyncGenerator<string> {
  const stream = await getOpenAI().chat.completions.create({
    model: config.model || 'gpt-4o-mini',
    messages: messages.map(toOpenAiMessage),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 1024,
    stream: true,
  })
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content
    if (text) yield text
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function callAnthropic(
  messages: ChatMessage[],
  config: ModelConfig
): Promise<string> {
  const anthropic = getAnthropic()
  const systemMsg = messages.find((m) => m.role === 'system')?.content || ''
  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const response = await anthropic.messages.create({
    model: config.model || 'claude-sonnet-4-20250514',
    max_tokens: config.maxTokens ?? 1024,
    system: systemMsg,
    messages: chatMessages,
    temperature: config.temperature ?? 0.7,
  })
  return response.content[0].type === 'text' ? response.content[0].text : ''
}

async function* streamAnthropic(
  messages: ChatMessage[],
  config: ModelConfig
): AsyncGenerator<string> {
  const anthropic = getAnthropic()
  const systemMsg = messages.find((m) => m.role === 'system')?.content || ''
  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const stream = anthropic.messages.stream({
    model: config.model || 'claude-sonnet-4-20250514',
    max_tokens: config.maxTokens ?? 1024,
    system: systemMsg,
    messages: chatMessages,
    temperature: config.temperature ?? 0.7,
  })
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text
    }
  }
}

// ---------------------------------------------------------------------------
// Sarvam (OpenAI-compatible API)
// ---------------------------------------------------------------------------

async function callSarvam(
  messages: ChatMessage[],
  config: ModelConfig
): Promise<string> {
  const response = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.model || 'sarvam-m',
      messages,
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 1024,
    }),
  })
  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

// ---------------------------------------------------------------------------
// Google Gemini (REST API)
// ---------------------------------------------------------------------------

async function callGemini(
  messages: ChatMessage[],
  config: ModelConfig
): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY
  const model = config.model || 'gemini-pro'
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
  const systemInstruction = messages.find((m) => m.role === 'system')?.content

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        generationConfig: {
          temperature: config.temperature ?? 0.7,
          maxOutputTokens: config.maxTokens ?? 1024,
        },
      }),
    }
  )
  const data = await response.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
}
