// ============================================================================
// AgentSession factory — wires Sarvam STT/TTS + Sarvam-M LLM (via the
// OpenAI-compatible plugin) into a LiveKit voice pipeline for one call.
// ============================================================================
//
// - STT: SarvamSTT (non-streaming /speech-to-text) wrapped in
//   StreamAdapter + Silero VAD so the framework sees a streaming STT
//   interface while we call Saarika per-utterance.
// - LLM: @livekit/agents-plugin-openai pointed at Sarvam's
//   OpenAI-compatible /v1/chat/completions with model=sarvam-m.
// - TTS: SarvamTTS (non-streaming Bulbul v3 /text-to-speech).
//
// Barge-in (caller interrupting assistant) is handled by the framework
// via VAD + TTS cancellation — no extra work on our side.
// ============================================================================

import { stt as sttNs } from '@livekit/agents'
import * as openaiPlugin from '@livekit/agents-plugin-openai'
import * as silero from '@livekit/agents-plugin-silero'
import { SarvamSTT } from './sarvam/stt.js'
import { SarvamTTS } from './sarvam/tts.js'
import type { AgentConfig } from './supabase.js'

/**
 * Voice-mode prompt rider. The agent's business prompt is written for
 * rich chat/markdown; on the phone the output is spoken verbatim, so
 * bullets/lists/emoji turn into garbage and every extra word costs
 * both LLM and TTS time. Mirrors buildPrompt() in the Next.js
 * chat-pipeline for channel === 'phone'.
 */
const VOICE_MODE_RIDER = `\n\n--- Voice Call Mode ---
You are on a LIVE phone call. Your reply will be spoken aloud:

- ONE short sentence when possible. Never more than two.
- Under 25 words total.
- Natural, warm, conversational. Not a customer-service script.
- Mirror the caller's language exactly. If they speak Telugu, reply in clean Telugu.
- No markdown, bullets, headings, URLs, or emojis — these are read aloud literally.
- No openers like "Sure!" / "Of course!" — answer directly.
- No closers like "I hope that helps!" — the line stays open for the next turn.
- Ask ONE question at a time, never a stack.`

/**
 * Build the voice pipeline for this call. Returns the plugin instances
 * needed to start an AgentSession in `src/index.ts`. We return these as
 * loose values (not an AgentSession directly) because the LiveKit
 * Agents Node SDK expects the session to be constructed inside the
 * agent entry closure with access to the JobContext.
 */
export async function buildVoicePipeline(config: AgentConfig): Promise<{
  instructions: string
  stt: sttNs.STT
  llm: openaiPlugin.LLM
  tts: SarvamTTS
  vad: silero.VAD
  greeting: string
}> {
  const instructions = config.system_prompt + VOICE_MODE_RIDER

  // Silero VAD keeps the STT loop from firing on every breath. VAD.load
  // pulls the ONNX model the first time and reuses it — cheap on
  // subsequent calls in the same worker process.
  const vad = await silero.VAD.load()

  // Wrap the one-shot SarvamSTT in the framework's StreamAdapter so
  // the pipeline sees a streaming STT. VAD owns utterance boundaries.
  const saarika = new SarvamSTT({ language: config.language })
  const stt = new sttNs.StreamAdapter(saarika, vad)

  // Sarvam-M speaks OpenAI-compatible /v1/chat/completions, so the
  // OpenAI plugin works as-is when we override baseURL + apiKey.
  const llm = new openaiPlugin.LLM({
    apiKey: requireEnv('SARVAM_API_KEY'),
    baseURL: 'https://api.sarvam.ai/v1',
    model: 'sarvam-m',
    // Low-ish temp for phone — we want short, direct replies.
    temperature: 0.6,
  })

  const tts = new SarvamTTS({
    speaker: config.voice_id,
    fallbackLanguage: config.language,
  })

  return {
    instructions,
    stt,
    llm,
    tts,
    vad,
    greeting: config.greeting_message,
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}
