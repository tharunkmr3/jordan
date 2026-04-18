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
  /**
   * Inline structured output — set when the caller wants the model's
   * reply constrained to a JSON schema at generation time. Currently
   * honored only by OpenAI in the tool-calling path: OpenAI's
   * `response_format: json_schema` coexists cleanly with `tools`, so
   * the model either emits tool_calls (content = null) OR structured
   * JSON (content = valid against the schema). Avoids the extra
   * synthesis round-trip for OpenAI agents on the website channel.
   *
   * Anthropic and Gemini ignore this field and still go through the
   * post-hoc generateStructured path.
   *
   * Shape matches OpenAI's `response_format` parameter:
   *   { type: 'json_schema', json_schema: { name, strict, schema } }
   */
  responseFormat?: Record<string, unknown>
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
    case 'gemini':
      return generateWithToolsGemini(messages, tools, config)
    case 'openai':
    default:
      return generateWithToolsOpenAI(messages, tools, config)
  }
}

export function supportsTools(provider: string): boolean {
  return provider === 'openai' || provider === 'anthropic' || provider === 'gemini'
}

// ---------------------------------------------------------------------------
// Structured output
//
// Provider-agnostic entry point that returns a JSON string constrained to
// a caller-provided JSON Schema. Each provider uses its native mechanism:
//
//  - OpenAI:   response_format: { type: 'json_schema', strict: true }.
//              The strictest of the three — schema violations are rejected
//              by the server, not the model.
//  - Anthropic: forced tool use. We expose a single "respond_structured"
//              tool whose input_schema IS the reply schema, and set
//              tool_choice to force it. The tool's `input` arg is the
//              structured reply — we serialize it back to JSON and return.
//  - Gemini:   JSON mode (responseMimeType: 'application/json') with the
//              schema described in the prompt. Gemini's responseSchema
//              field doesn't handle our discriminated-union Block type
//              reliably, so we rely on 2.5-pro's prompt compliance + the
//              caller's runtime validator as the safety net.
//  - Sarvam:   falls through to OpenAI — Sarvam's OpenAI-compatible
//              endpoint doesn't implement response_format cleanly.
//
// The caller is responsible for runtime validation (parseStructuredReply
// in structured-output.ts) because (a) Gemini isn't server-enforced and
// (b) even "strict" OpenAI can return empty strings on edge cases.
// ---------------------------------------------------------------------------

export async function generateStructured(
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  config: ModelConfig,
): Promise<string> {
  switch (config.provider) {
    case 'anthropic':
      return generateStructuredAnthropic(messages, schema, config)
    case 'gemini':
      return generateStructuredGemini(messages, schema, config)
    case 'sarvam':
      // Sarvam's chat/completions endpoint advertises response_format
      // support but doesn't honor strict json_schema mode. Route through
      // OpenAI for this specific step so enterprise customers get the
      // same guarantee no matter which chat model they picked.
      return generateStructuredOpenAI(messages, schema, { ...config, provider: 'openai', model: 'gpt-5.4' })
    case 'openai':
    default:
      return generateStructuredOpenAI(messages, schema, config)
  }
}

async function generateStructuredOpenAI(
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  config: ModelConfig,
): Promise<string> {
  // The SDK's response_format type is a tagged union and the TypeScript
  // definition for `json_schema` mode was tightened across OpenAI SDK
  // releases. Cast once to keep compatibility without plastering `as any`
  // across the codebase — the runtime shape is well defined.
  type RF = NonNullable<Parameters<ReturnType<typeof getOpenAI>['chat']['completions']['create']>[0]['response_format']>
  const responseFormat: RF = {
    type: 'json_schema',
    json_schema: {
      name: 'structured_reply',
      strict: true,
      schema,
    },
  } as unknown as RF

  const response = await getOpenAI().chat.completions.create({
    model: config.model || 'gpt-5.4',
    messages: messages.map(toOpenAiMessage),
    response_format: responseFormat,
    // Lower temperature on structured output: we want the model to pick
    // the right blocks deterministically, not get creative with schema.
    // Still respect the agent's override if set.
    temperature: config.temperature ?? 0.3,
    ...(config.maxTokens ? { max_completion_tokens: config.maxTokens } : {}),
  })
  return response.choices[0]?.message?.content || '{"blocks":[]}'
}

async function generateStructuredAnthropic(
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  config: ModelConfig,
): Promise<string> {
  const anthropic = getAnthropic()
  const systemMsgRaw = messages.find((m) => m.role === 'system')?.content ?? ''
  const systemMsg = typeof systemMsgRaw === 'string' ? systemMsgRaw : contentPartsToText(systemMsgRaw)
  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => toAnthropicMessage(m))

  const modelName = config.model || 'claude-sonnet-4-6'
  const respondTool = {
    name: 'respond_structured',
    description: 'Emit the final reply as a structured Block array. This is the ONLY way to reply; do not write prose.',
    input_schema: schema,
  }
  const res = await anthropic.messages.create({
    model: modelName,
    max_tokens: config.maxTokens ?? 8192,
    system: systemMsg,
    messages: chatMessages as Parameters<typeof anthropic.messages.create>[0]['messages'],
    tools: [respondTool] as unknown as Parameters<typeof anthropic.messages.create>[0]['tools'],
    // Force this exact tool so we get structured output, not prose.
    tool_choice: { type: 'tool', name: 'respond_structured' } as unknown as Parameters<typeof anthropic.messages.create>[0]['tool_choice'],
    ...(anthropicAcceptsTemperature(modelName) ? { temperature: config.temperature ?? 0.3 } : {}),
  })

  const toolUse = res.content.find((b) => b.type === 'tool_use') as
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | undefined
  if (!toolUse) return '{"blocks":[]}'
  return JSON.stringify(toolUse.input ?? {})
}

async function generateStructuredGemini(
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  config: ModelConfig,
): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY is not set — add it to .env.local and restart the dev server')

  const rawModel = config.model
  const model = (!rawModel || rawModel === 'gemini-pro' || rawModel === 'gemini-2.5-flash')
    ? 'gemini-2.5-pro'
    : rawModel

  const sysRaw = messages.find((m) => m.role === 'system')?.content
  const baseSystem = sysRaw
    ? (typeof sysRaw === 'string' ? sysRaw : contentPartsToText(sysRaw))
    : ''
  // Gemini's responseSchema doesn't handle discriminated-union array items
  // reliably. Instead we pin the schema into the system prompt and rely on
  // 2.5-pro's prompt compliance — the caller validates output at runtime.
  const schemaRider = `\n\n--- Structured Reply Schema (MANDATORY) ---\nReturn ONLY a single JSON object that validates against this schema. Do NOT wrap it in code fences; do NOT emit prose around it.\n\n${JSON.stringify(schema)}\n--- End Schema ---`
  const systemInstruction = baseSystem + schemaRider

  const contents = toGeminiMessages(messages)

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          temperature: config.temperature ?? 0.3,
          responseMimeType: 'application/json',
          ...(config.maxTokens ? { maxOutputTokens: config.maxTokens } : {}),
        },
      }),
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Gemini API ${response.status}: ${body.slice(0, 400)}`)
  }
  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    error?: { message?: string }
  }
  if (data.error?.message) throw new Error(`Gemini API: ${data.error.message}`)
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  return text || '{"blocks":[]}'
}

async function generateWithToolsOpenAI(
  messages: ChatMessage[],
  tools: LlmToolDef[],
  config: ModelConfig
): Promise<GenerateWithToolsResult> {
  // Inline structured output. When config.responseFormat is set, OpenAI
  // enforces the JSON schema on any text content the model produces —
  // which means when the model decides to RESPOND (not call tools) on
  // the final agentic-loop iteration, its reply is already valid
  // structured JSON and we can skip the post-hoc synthesis round-trip.
  // Tool-calling and response_format coexist cleanly: if the model
  // picks tools, content is null and the schema doesn't matter.
  //
  // Cast through Record<string,unknown> because the SDK's response_format
  // type is a tagged union whose discriminants have shifted across
  // minor versions.
  type RF = NonNullable<Parameters<ReturnType<typeof getOpenAI>['chat']['completions']['create']>[0]['response_format']>
  const rf = config.responseFormat ? (config.responseFormat as unknown as RF) : undefined

  const response = await getOpenAI().chat.completions.create({
    model: config.model || 'gpt-5.4',
    messages: messages.map(toOpenAiMessage),
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    temperature: config.temperature ?? 0.7,
    ...(config.maxTokens ? { max_completion_tokens: config.maxTokens } : {}),
    ...(rf ? { response_format: rf } : {}),
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

/**
 * Gemini tool calling.
 *
 * Gemini's v1beta `generateContent` has native function-calling support
 * but a meaningfully different schema from OpenAI/Anthropic:
 *
 *  - Tools are declared as a single `tools: [{ functionDeclarations }]`
 *    wrapper rather than a flat list.
 *  - Calls arrive as `parts[i].functionCall = { name, args }` inside a
 *    model-role message; there is NO per-call `id`, so we synthesize
 *    one and thread it through the pipeline's `tool_call_id` field.
 *  - Results go back as `parts[i].functionResponse = { name, response }`
 *    inside a user-role message, and `response` MUST be an object
 *    (not a string, not an array, not null).
 *  - Consecutive same-role messages are rejected, so parallel tool
 *    calls must collapse into ONE user message with multiple
 *    functionResponse parts.
 *  - Parameter JSON Schema uses UPPERCASE type enums ("STRING",
 *    "OBJECT", …) and rejects `additionalProperties`, `$schema`,
 *    `$ref`, `default`, `examples` — Composio tool schemas include
 *    these, so we sanitize before sending.
 */
async function generateWithToolsGemini(
  messages: ChatMessage[],
  tools: LlmToolDef[],
  config: ModelConfig
): Promise<GenerateWithToolsResult> {
  const apiKey = process.env.GOOGLE_AI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY is not set — add it to .env.local and restart the dev server')

  const rawModel = config.model
  const model = (!rawModel || rawModel === 'gemini-pro' || rawModel === 'gemini-2.5-flash')
    ? 'gemini-2.5-pro'
    : rawModel

  const sysRaw = messages.find((m) => m.role === 'system')?.content
  const systemInstruction = sysRaw
    ? (typeof sysRaw === 'string' ? sysRaw : contentPartsToText(sysRaw))
    : null

  const contents = toGeminiMessages(messages)

  const functionDeclarations = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: sanitizeSchemaForGemini(
      t.function.parameters ?? { type: 'object', properties: {} }
    ),
  }))

  const body: Record<string, unknown> = {
    contents,
    systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
    generationConfig: {
      temperature: config.temperature ?? 0.7,
      ...(config.maxTokens ? { maxOutputTokens: config.maxTokens } : {}),
    },
  }
  if (functionDeclarations.length > 0) {
    body.tools = [{ functionDeclarations }]
    // `AUTO` is the Gemini default; set it explicitly so future upgrades
    // can't flip the baseline behaviour silently.
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(`Gemini API ${response.status}: ${errBody.slice(0, 400)}`)
  }
  const data = await response.json() as {
    candidates?: Array<{
      content?: {
        role?: string
        parts?: Array<{
          text?: string
          functionCall?: { name: string; args?: Record<string, unknown> }
        }>
      }
    }>
    error?: { message?: string }
  }
  if (data.error?.message) throw new Error(`Gemini API: ${data.error.message}`)

  const parts = data.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text ?? '')
    .join('')

  const toolCalls: ToolCallChoice[] = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({
      // Gemini doesn't return per-call IDs; synthesize a stable one per
      // call position so our tool-response messages can echo it back.
      // The id is opaque to Gemini — we only use it on our side to
      // correlate assistant.tool_calls[i] ↔ role:'tool'.tool_call_id.
      id: `gem-${Date.now()}-${i}`,
      type: 'function' as const,
      function: {
        name: p.functionCall!.name,
        arguments: JSON.stringify(p.functionCall!.args ?? {}),
      },
    }))

  return {
    text: text || null,
    toolCalls,
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

// ---------------------------------------------------------------------------
// Gemini message + schema adapters
// ---------------------------------------------------------------------------

/**
 * Every `part` in a Gemini message is one of these shapes. We never
 * send `inline_data` (image) parts today — image attachments get
 * flattened to their extracted text upstream.
 */
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

interface GeminiMessage {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/**
 * Translate the pipeline's ChatMessage[] into the user/model-role,
 * parts-based shape Gemini expects. Handles three twists:
 *
 *  1. Tool results lose their `id` in transit — Gemini keys
 *     functionResponse by name. We rebuild the id→name map from the
 *     assistant tool_calls we've seen and use it to label responses.
 *  2. Gemini rejects consecutive same-role messages. A round with
 *     parallel tool calls produces N role:'tool' messages in our
 *     format, which would become N consecutive user messages — we
 *     merge them into a single user message with N functionResponse
 *     parts.
 *  3. `functionResponse.response` must be an object. Tool results
 *     arrive as stringified JSON; we parse back to an object, or
 *     wrap primitives in `{ result: … }` so the shape stays valid.
 */
function toGeminiMessages(messages: ChatMessage[]): GeminiMessage[] {
  const idToName = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) idToName.set(tc.id, tc.function.name)
    }
  }

  const out: GeminiMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') continue  // handled via systemInstruction

    if (m.role === 'tool') {
      const toolName = idToName.get(m.tool_call_id ?? '') ?? 'unknown_tool'
      const text = typeof m.content === 'string' ? m.content : contentPartsToText(m.content)
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = { content: text } }
      // Gemini requires `response` to be an object — wrap primitives,
      // arrays, and null so the schema stays valid.
      const response: Record<string, unknown> =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { result: parsed }
      out.push({ role: 'user', parts: [{ functionResponse: { name: toolName, response } }] })
      continue
    }

    if (m.role === 'assistant') {
      const parts: GeminiPart[] = []
      const text = typeof m.content === 'string' ? m.content : contentPartsToText(m.content)
      if (text) parts.push({ text })
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(tc.function.arguments) as Record<string, unknown> } catch { /* leave empty */ }
          parts.push({ functionCall: { name: tc.function.name, args } })
        }
      }
      // An assistant turn with no parts at all would be rejected — skip
      // (rare: model returned purely whitespace and no tool calls).
      if (parts.length === 0) continue
      out.push({ role: 'model', parts })
      continue
    }

    // user
    const text = typeof m.content === 'string' ? m.content : contentPartsToText(m.content)
    out.push({ role: 'user', parts: [{ text }] })
  }

  // Collapse consecutive same-role messages so parallel tool results
  // end up as one user-role turn with many functionResponse parts.
  const merged: GeminiMessage[] = []
  for (const msg of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      last.parts.push(...msg.parts)
    } else {
      merged.push({ role: msg.role, parts: [...msg.parts] })
    }
  }
  return merged
}

/**
 * Strip JSON Schema fields Gemini rejects and normalize the schema to
 * the restricted subset its function_declarations endpoint accepts.
 *
 * Composio tool schemas are written against the full JSON Schema spec,
 * but Gemini's Schema type is a deliberate subset (to keep decoding
 * tractable). Keywords it doesn't recognize cause a 400 INVALID_ARGUMENT
 * like "Unknown name 'const' at tools[0].function_declarations[N]…".
 *
 * Transformations:
 *   - STRIP removes keywords Gemini 400s on outright.
 *   - `const: X` → `enum: [X]` (Gemini accepts enum, not const). Done as
 *     an in-place swap so the constraint's semantics survive.
 *   - `type` string values → UPPERCASE ("STRING", "OBJECT", …), which
 *     is how Gemini documents the Type enum.
 *   - Composition keywords (`oneOf`, `anyOf`, `allOf`, `not`) are stripped
 *     because Gemini's function-declaration schema subset rejects them;
 *     the sibling properties in the object usually still constrain
 *     enough for the model to pick a valid shape.
 *   - `if`/`then`/`else` conditional schemas: stripped (same reason).
 *
 * Kept (Gemini supports):
 *   - type, description, nullable, enum, format
 *   - properties, required (for objects)
 *   - items (for arrays)
 *   - minItems / maxItems / minLength / maxLength / minimum / maximum
 *   - pattern
 */
function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (schema === null || schema === undefined) return schema
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini)
  if (typeof schema !== 'object') return schema

  const STRIP = new Set([
    // Reference / metadata keywords
    'additionalProperties', '$schema', '$ref', '$defs',
    'default', 'examples', 'definitions', '$comment', '$id',
    // Composition — Gemini's Schema subset doesn't accept these inside
    // function declarations and 400s if present.
    'oneOf', 'anyOf', 'allOf', 'not',
    // Conditional schemas — same reason.
    'if', 'then', 'else',
    // Dependency keywords — rarely useful for tool args and not supported.
    'dependencies', 'dependentRequired', 'dependentSchemas',
    // Object sizing and key patterns — not in Gemini's subset.
    'patternProperties', 'propertyNames', 'minProperties', 'maxProperties',
    // Array uniqueness — Gemini doesn't enforce it.
    'uniqueItems', 'contains', 'minContains', 'maxContains',
    // Numeric divisibility — not in subset.
    'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum',
    // Content / encoding keywords — not in subset.
    'contentEncoding', 'contentMediaType', 'contentSchema',
    // Draft-2019+ discriminator / readOnly / writeOnly — ignored by Gemini.
    'readOnly', 'writeOnly', 'discriminator',
  ])

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (STRIP.has(k)) continue
    // `const: X` isn't supported; rewrite as a single-member enum so the
    // model still knows the field must equal X. Preserves semantics.
    if (k === 'const') {
      out.enum = Array.isArray(out.enum) ? [...(out.enum as unknown[]), v] : [v]
      continue
    }
    if (k === 'type' && typeof v === 'string') {
      out[k] = v.toUpperCase()
      continue
    }
    out[k] = sanitizeSchemaForGemini(v)
  }
  return out
}

async function* streamOpenAI(
  messages: ChatMessage[],
  config: ModelConfig
): AsyncGenerator<string> {
  // Same inline-structured-output path as generateWithToolsOpenAI — when
  // the caller set responseFormat, the streamed JSON is valid against
  // the schema by the end of the stream. OpenAI supports streaming JSON
  // objects chunk-by-chunk; we still yield raw deltas and let the caller
  // parse the accumulated result as JSON after the stream ends.
  type RF = NonNullable<Parameters<ReturnType<typeof getOpenAI>['chat']['completions']['create']>[0]['response_format']>
  const rf = config.responseFormat ? (config.responseFormat as unknown as RF) : undefined

  const stream = await getOpenAI().chat.completions.create({
    model: config.model || 'gpt-5.4',
    messages: messages.map(toOpenAiMessage),
    temperature: config.temperature ?? 0.7,
    ...(config.maxTokens ? { max_completion_tokens: config.maxTokens } : {}),
    ...(rf ? { response_format: rf } : {}),
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
  // has been retired; v1beta stable is gemini-2.5-pro / 2.5-flash, and
  // Pro is our picked default (better long-spec adherence).
  const rawModel = config.model
  // Auto-upgrade the retired `gemini-pro` alias AND existing
  // `gemini-2.5-flash` agent rows onto 2.5-pro. Pro is both our new
  // catalog default (better format-rule adherence) and the model we
  // test tool-calling against; a stale Flash row would otherwise
  // silently keep using the old, less-compliant model.
  const model = (!rawModel || rawModel === 'gemini-pro' || rawModel === 'gemini-2.5-flash')
    ? 'gemini-2.5-pro'
    : rawModel

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
  // Auto-upgrade the retired `gemini-pro` alias AND existing
  // `gemini-2.5-flash` agent rows onto 2.5-pro. Pro is both our new
  // catalog default (better format-rule adherence) and the model we
  // test tool-calling against; a stale Flash row would otherwise
  // silently keep using the old, less-compliant model.
  const model = (!rawModel || rawModel === 'gemini-pro' || rawModel === 'gemini-2.5-flash')
    ? 'gemini-2.5-pro'
    : rawModel

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
