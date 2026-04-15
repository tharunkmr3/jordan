// ============================================================================
// Jordon AI Platform — Multi-Model Router
// Abstracts different AI providers behind a unified interface
// ============================================================================

import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelConfig {
  provider: string
  model?: string
  temperature?: number
  maxTokens?: number
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
    messages,
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 1024,
  })
  return response.choices[0]?.message?.content || ''
}

async function* streamOpenAI(
  messages: ChatMessage[],
  config: ModelConfig
): AsyncGenerator<string> {
  const stream = await getOpenAI().chat.completions.create({
    model: config.model || 'gpt-4o-mini',
    messages,
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
    model: config.model || 'claude-3-5-sonnet-20241022',
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
    model: config.model || 'claude-3-5-sonnet-20241022',
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
