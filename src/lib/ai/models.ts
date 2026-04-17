// ============================================================================
// Jordon AI Platform — Multi-Model Router
// Abstracts different AI providers behind a unified interface
// ============================================================================

import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

/**
 * A content part in a multimodal user message. Vision providers
 * (OpenAI, Anthropic) accept an array of these instead of a string
 * when the message includes images alongside text.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** String for plain text messages, or parts array for multimodal user messages. */
  content: string | ContentPart[]
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

// Singleton clients — avoid re-creating on every call. The SDKs throw a
// generic "Could not resolve authentication method" if apiKey ends up
// undefined, which then gets swallowed by the pipeline's catch and
// surfaces to the UI as the agent's fallback_message. Validate eagerly
// so errors are obvious in the server log instead.
let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set — add it to .env.local and restart the dev server')
    _openai = new OpenAI({ apiKey })
  }
  return _openai
}

let _anthropic: Anthropic | null = null
function getAnthropic() {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — add it to .env.local and restart the dev server')
    _anthropic = new Anthropic({ apiKey })
  }
  return _anthropic
}

/**
 * Whether an Anthropic model still accepts the `temperature` parameter.
 *
 * Claude Opus 4.7 and other extended-thinking-family models from the 4.7
 * generation dropped `temperature` support (the API rejects the request
 * with `temperature is deprecated for this model`). We detect by model
 * name prefix and omit the param for those; everything else keeps the
 * standard 0.7 default so bump-a-knob tuning still works.
 */
function anthropicAcceptsTemperature(model: string): boolean {
  // Opus 4.7 — confirmed rejection from prod logs.
  if (model.startsWith('claude-opus-4-7')) return false
  return true
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
    case 'sarvam':
      yield* streamSarvam(messages, config)
      break
    case 'gemini':
      yield* streamGemini(messages, config)
      break
    default: {
      // Unknown provider — fall through to non-streaming so the caller
      // still gets a response.
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
    model: config.model || 'gpt-5.4',
    messages: messages.map(toOpenAiMessage),
    temperature: config.temperature ?? 0.7,
    // GPT-5+ rejects the legacy `max_tokens` param; use the new
    // `max_completion_tokens`. Only cap when the agent has explicitly
    // set a value — otherwise let the model choose its natural length
    // within the context window.
    ...(config.maxTokens ? { max_completion_tokens: config.maxTokens } : {}),
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
    model: config.model || 'gpt-5.4',
    messages: messages.map(toOpenAiMessage),
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    temperature: config.temperature ?? 0.7,
    ...(config.maxTokens ? { max_completion_tokens: config.maxTokens } : {}),
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
  const systemMsgRaw = messages.find((m) => m.role === 'system')?.content ?? ''
  const systemMsg = typeof systemMsgRaw === 'string' ? systemMsgRaw : contentPartsToText(systemMsgRaw)

  const anthTools = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: (t.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
  }))

  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => toAnthropicMessage(m))

  const modelName = config.model || 'claude-sonnet-4-6'
  const res = await anthropic.messages.create({
    model: modelName,
    // Anthropic's API REQUIRES max_tokens (unlike OpenAI/Gemini/Sarvam
    // where it's optional). Default to 8192 — the current Sonnet/Opus
    // generation supports up to that natively — so we don't artificially
    // truncate thorough answers. Agent.max_tokens still overrides.
    max_tokens: config.maxTokens ?? 8192,
    system: systemMsg,
    messages: chatMessages as Parameters<typeof anthropic.messages.create>[0]['messages'],
    ...(anthropicAcceptsTemperature(modelName) ? { temperature: config.temperature ?? 0.7 } : {}),
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
    // Tool results are always plain text.
    return {
      role: 'tool',
      content: typeof m.content === 'string' ? m.content : contentPartsToText(m.content),
      tool_call_id: m.tool_call_id ?? '',
    }
  }
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: typeof m.content === 'string' ? m.content : contentPartsToText(m.content),
      tool_calls: m.tool_calls as ChatCompletionMessageParam extends infer X
        ? X extends { tool_calls?: infer Y } ? Y : never
        : never,
    } as ChatCompletionMessageParam
  }
  if (m.role === 'system') {
    return { role: 'system', content: typeof m.content === 'string' ? m.content : contentPartsToText(m.content) }
  }
  // User messages can be multimodal — OpenAI's shape is
  // { role: 'user', content: [ {type:'text',text}, {type:'image_url',image_url:{url}} ] }.
  // Our ContentPart is already in that shape; cast through unknown
  // because OpenAI's content type is a wider tagged union.
  if (Array.isArray(m.content)) {
    return { role: 'user', content: m.content as unknown as ChatCompletionMessageParam['content'] } as ChatCompletionMessageParam
  }
  return { role: 'user', content: m.content }
}

function contentPartsToText(parts: ContentPart[]): string {
  return parts
    .map(p => p.type === 'text' ? p.text : `[image]`)
    .join('\n')
}

type AnthropicMsg = {
  role: 'user' | 'assistant'
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image'; source: { type: 'url'; url: string } }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        | { type: 'tool_result'; tool_use_id: string; content: string }
      >
}

function toAnthropicMessage(m: ChatMessage): AnthropicMsg {
  if (m.role === 'tool') {
    const content = typeof m.content === 'string' ? m.content : contentPartsToText(m.content)
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content }],
    }
  }
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    const blocks: AnthropicMsg['content'] = []
    const textContent = typeof m.content === 'string' ? m.content : contentPartsToText(m.content)
    if (textContent) blocks.push({ type: 'text', text: textContent })
    for (const c of m.tool_calls) {
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(c.function.arguments) as Record<string, unknown> } catch { /* ignore */ }
      blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input })
    }
    return { role: 'assistant', content: blocks }
  }
  // Multimodal user messages: translate OpenAI-shaped parts
  // (text + image_url) into Anthropic's text + image/source.url blocks.
  if (Array.isArray(m.content)) {
    const blocks: AnthropicMsg['content'] = m.content.map(p => {
      if (p.type === 'image_url') {
        return { type: 'image', source: { type: 'url', url: p.image_url.url } }
      }
      return { type: 'text', text: p.text }
    })
    return { role: m.role as 'user' | 'assistant', content: blocks }
  }
  return { role: m.role as 'user' | 'assistant', content: m.content }
}

async function* streamOpenAI(
  messages: ChatMessage[],
  config: ModelConfig
): AsyncGenerator<string> {
  const stream = await getOpenAI().chat.completions.create({
    model: config.model || 'gpt-5.4',
    messages: messages.map(toOpenAiMessage),
    temperature: config.temperature ?? 0.7,
    ...(config.maxTokens ? { max_completion_tokens: config.maxTokens } : {}),
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
  const systemMsgRaw = messages.find((m) => m.role === 'system')?.content ?? ''
  const systemMsg = typeof systemMsgRaw === 'string' ? systemMsgRaw : contentPartsToText(systemMsgRaw)
  // Route through toAnthropicMessage so image parts get converted to
  // the { type: 'image', source: { type: 'url', url } } shape.
  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map(toAnthropicMessage)

  const modelName = config.model || 'claude-sonnet-4-6'
  const response = await anthropic.messages.create({
    model: modelName,
    // Anthropic requires max_tokens. Default 8192 so thorough answers
    // aren't artificially truncated; agent.max_tokens overrides.
    max_tokens: config.maxTokens ?? 8192,
    system: systemMsg,
    messages: chatMessages as Parameters<typeof anthropic.messages.create>[0]['messages'],
    ...(anthropicAcceptsTemperature(modelName) ? { temperature: config.temperature ?? 0.7 } : {}),
  })
  return response.content[0].type === 'text' ? response.content[0].text : ''
}

async function* streamAnthropic(
  messages: ChatMessage[],
  config: ModelConfig
): AsyncGenerator<string> {
  const anthropic = getAnthropic()
  const systemMsgRaw = messages.find((m) => m.role === 'system')?.content ?? ''
  const systemMsg = typeof systemMsgRaw === 'string' ? systemMsgRaw : contentPartsToText(systemMsgRaw)
  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map(toAnthropicMessage)

  const modelName = config.model || 'claude-sonnet-4-6'
  const stream = anthropic.messages.stream({
    model: modelName,
    // Anthropic requires max_tokens. Default 8192 so thorough answers
    // aren't artificially truncated; agent.max_tokens overrides.
    max_tokens: config.maxTokens ?? 8192,
    system: systemMsg,
    messages: chatMessages as Parameters<typeof anthropic.messages.stream>[0]['messages'],
    ...(anthropicAcceptsTemperature(modelName) ? { temperature: config.temperature ?? 0.7 } : {}),
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
  const apiKey = process.env.SARVAM_API_KEY
  if (!apiKey) throw new Error('SARVAM_API_KEY is not set — add it to .env.local and restart the dev server')

  // Sarvam's OpenAI-compatible API only accepts string content. Multimodal
  // ContentPart[] (image_url parts from attachments) gets flattened to the
  // text portion only — images are silently dropped for text-only models.
  const flattened = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : contentPartsToText(m.content),
  }))

  const response = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'sarvam-m',
      messages: flattened,
      temperature: config.temperature ?? 0.7,
      // Only pass max_tokens when the agent has explicitly configured
      // one. Sarvam treats omission as "use the model's natural ceiling,"
      // which is what we want — the model's own stopping behaviour
      // (including room after <think> for the visible answer) is better
      // than any floor we'd hard-code.
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Sarvam API ${response.status}: ${body.slice(0, 300)}`)
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
  if (data.error?.message) throw new Error(`Sarvam API: ${data.error.message}`)
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
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY is not set — add it to .env.local and restart the dev server')

  // Default to a stable, current model. `gemini-pro` (legacy v1 alias)
  // has been retired; v1beta stable is gemini-2.5-flash / 2.5-pro.
  // Map existing agents.model_name rows that still hold the legacy alias
  // onto 2.5-flash so they don't 404 until a human edits the agent.
  const rawModel = config.model
  const model = (!rawModel || rawModel === 'gemini-pro') ? 'gemini-2.5-flash' : rawModel

  // Flatten ContentPart[] → plain text. Gemini's generateContent DOES
  // support image parts (inline_data with base64), but our pipeline ships
  // signed HTTPS URLs which Gemini won't fetch — and implementing the
  // b64 fetch-and-forward here is out of scope for this hotfix. Drop the
  // images for now; the extracted text from attachments is already folded
  // into the user message by buildUserMessage upstream.
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : contentPartsToText(m.content) }],
    }))
  const sysRaw = messages.find((m) => m.role === 'system')?.content
  const systemInstruction = sysRaw
    ? (typeof sysRaw === 'string' ? sysRaw : contentPartsToText(sysRaw))
    : null

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
          // Only cap when the agent has explicitly set a limit; otherwise
          // let Gemini use its natural max output size.
          ...(config.maxTokens ? { maxOutputTokens: config.maxTokens } : {}),
        },
      }),
    }
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Gemini API ${response.status}: ${body.slice(0, 300)}`)
  }
  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    error?: { message?: string }
  }
  if (data.error?.message) throw new Error(`Gemini API: ${data.error.message}`)
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
  return text
}

/**
 * Stream tokens from Sarvam via its OpenAI-compatible chat/completions
 * endpoint with `stream: true`. Frame format is standard SSE: each event
 * is `data: {json}` and a terminating `data: [DONE]`. We yield whatever
 * text the delta carries, one chunk per frame.
 */
async function* streamSarvam(
  messages: ChatMessage[],
  config: ModelConfig,
): AsyncGenerator<string> {
  const apiKey = process.env.SARVAM_API_KEY
  if (!apiKey) throw new Error('SARVAM_API_KEY is not set — add it to .env.local and restart the dev server')

  const flattened = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : contentPartsToText(m.content),
  }))

  const response = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'sarvam-m',
      messages: flattened,
      temperature: config.temperature ?? 0.7,
      // Only pass max_tokens when the agent has explicitly set one.
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
      stream: true,
    }),
  })
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '')
    throw new Error(`Sarvam API ${response.status}: ${body.slice(0, 300)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE frames are separated by blank lines (\n\n). Split on newline,
    // keep the last partial in the buffer, parse complete `data:` lines.
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch { /* malformed — skip */ }
    }
  }
}

/**
 * Stream tokens from Gemini via `streamGenerateContent`. Google emits
 * a JSON stream where each element is a full `GenerateContentResponse`
 * object (NOT standard SSE) — the body is a concatenation of JSON objects
 * separated by newlines when `?alt=sse` is set. We use `?alt=sse` so the
 * frames arrive as standard `data: {json}` events.
 */
async function* streamGemini(
  messages: ChatMessage[],
  config: ModelConfig,
): AsyncGenerator<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY is not set — add it to .env.local and restart the dev server')

  const rawModel = config.model
  const model = (!rawModel || rawModel === 'gemini-pro') ? 'gemini-2.5-flash' : rawModel

  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : contentPartsToText(m.content) }],
    }))
  const sysRaw = messages.find((m) => m.role === 'system')?.content
  const systemInstruction = sysRaw
    ? (typeof sysRaw === 'string' ? sysRaw : contentPartsToText(sysRaw))
    : null

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        generationConfig: {
          temperature: config.temperature ?? 0.7,
          // Only cap when the agent has explicitly set a limit; otherwise
          // let Gemini use its natural max output size.
          ...(config.maxTokens ? { maxOutputTokens: config.maxTokens } : {}),
        },
      }),
    },
  )
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '')
    throw new Error(`Gemini API ${response.status}: ${body.slice(0, 300)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        const chunk = JSON.parse(payload) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        }
        const parts = chunk.candidates?.[0]?.content?.parts
        if (parts) {
          for (const p of parts) {
            if (p.text) yield p.text
          }
        }
      } catch { /* malformed — skip */ }
    }
  }
}
