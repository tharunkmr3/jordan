// ============================================================================
// Sarvam-M — OpenAI-compatible LLM adapter for LiveKit Agents.
// ============================================================================
//
// Sarvam exposes an OpenAI-compatible /v1/chat/completions endpoint,
// so we reuse the stock OpenAI LLM plugin shape but point it at
// api.sarvam.ai/v1 with Sarvam's bearer auth. Stream mode emits token
// chunks — LiveKit Agents forwards each chunk into the TTS while the
// LLM is still generating, driving true first-syllable-in-milliseconds.
//
// Status: STUB — class shape matches what LiveKit Agents' `llm.LLM`
// subclass expects. The actual chat/stream wiring follows in the next
// pass alongside STT + TTS.
// ============================================================================

import { llm } from '@livekit/agents'

const SARVAM_API_BASE = 'https://api.sarvam.ai/v1'

export interface SarvamLLMOptions {
  model?: string
  maxTokens?: number
  temperature?: number
}

/**
 * LiveKit Agents LLM adapter backed by Sarvam-M via its
 * OpenAI-compatible endpoint.
 *
 * Wire plan for the follow-up pass:
 *   1. Implement `chat(ctx)` to POST to
 *      `${SARVAM_API_BASE}/chat/completions` with
 *      Authorization: Bearer <SARVAM_API_KEY>,
 *      body { model, messages: ctx.messages, stream: true, max_tokens,
 *      temperature }.
 *   2. Parse the SSE stream; yield `llm.ChatChunk` entries.
 *   3. Wrap in `llm.LLMStream` so Agents treats us like any other
 *      provider.
 *   4. Translate `ctx.messages` (internal ChatContext) to Sarvam's
 *      OpenAI shape — system / user / assistant / tool roles map 1:1.
 */
export class SarvamLLM extends llm.LLM {
  private readonly apiKey: string
  private readonly model: string
  private readonly maxTokens: number
  private readonly temperature: number

  constructor(opts: SarvamLLMOptions = {}) {
    super()
    const key = process.env.SARVAM_API_KEY
    if (!key) throw new Error('SARVAM_API_KEY not set for SarvamLLM')
    this.apiKey = key
    this.model = opts.model ?? 'sarvam-m'
    this.maxTokens = opts.maxTokens ?? 220
    this.temperature = opts.temperature ?? 0.6
  }

  // chat() implementation lands in the next commit. For now the class
  // compiles and documents exactly which Sarvam endpoint + params we
  // intend to wire.
}

// Helpful constants kept here so both the adapter and any future
// config-aware tuning can reference the same source of truth.
export const SARVAM_LLM_DEFAULTS = {
  BASE_URL: SARVAM_API_BASE,
  MODEL: 'sarvam-m',
  MAX_TOKENS_PHONE: 220,
  TEMPERATURE_PHONE: 0.6,
}
