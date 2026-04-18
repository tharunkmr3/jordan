// ============================================================================
// AgentSession factory — wires Sarvam STT/LLM/TTS into a LiveKit voice
// pipeline for one call.
// ============================================================================
//
// Returns a ready-to-start AgentSession that subscribes to the caller's
// audio, runs Sarvam Saarika for streaming STT, routes the transcript
// through Sarvam-M with the agent's system prompt, synthesises replies
// via Sarvam Bulbul v3, and publishes audio back to the room — all
// streaming where possible so first-token-out is measured in hundreds
// of milliseconds, not seconds.
//
// Interruption (barge-in) is handled by LiveKit Agents for free: when
// the caller starts speaking while TTS is playing, the VAD cuts the
// synthesis and restarts the STT loop. Huge UX win over our previous
// Twilio webhook dance.
// ============================================================================

import {
  Agent,
  AgentSession,
} from '@livekit/agents'
import { VoiceActivityDetection } from '@livekit/agents-plugin-silero'
import { SarvamSTT } from './sarvam/stt.js'
import { SarvamLLM } from './sarvam/llm.js'
import { SarvamTTS } from './sarvam/tts.js'
import type { AgentConfig } from './supabase.js'

/**
 * The voice-mode prompt rider. Even with the agent's business prompt
 * present, voice callers need stricter conversational guidance — TTS
 * reads verbatim, so markdown and lists ruin the audio, and every
 * extra word costs real latency. This mirrors the buildPrompt() rules
 * in the Next.js chat-pipeline for channel === 'phone'.
 */
const VOICE_MODE_RIDER = `\n\n--- Voice Call Mode ---
You are on a LIVE phone call. Your reply will be spoken aloud:

- ONE short sentence when possible. Never more than two.
- Under 25 words total.
- Natural, warm, conversational. Not a customer-service script.
- Mirror the caller's language exactly. Clean output only — no code-switching unless the caller does.
- No markdown, bullets, headings, URLs, or emojis.
- No openers like "Sure!" / "Of course!" — answer directly.
- No closers like "I hope that helps!" — the line stays open for the next turn.
- Ask ONE question at a time, never a stack.`

/**
 * Build the full voice pipeline for this call. Returns the session and
 * a prepared agent object — the caller invokes `session.start()` once
 * they've connected to the room, and `session.say()` for the greeting.
 */
export function buildAgentSession(config: AgentConfig): {
  agent: Agent
  session: AgentSession
  say: (text: string, opts?: { allowInterruptions?: boolean }) => Promise<void>
  start: (opts: { agent: Agent; room: unknown }) => Promise<void>
} {
  const instructions = config.system_prompt + VOICE_MODE_RIDER

  const agent = new Agent({
    instructions,
  })

  // VAD keeps the pipeline from running the LLM on every breath —
  // Silero's Node port is deterministic and runs CPU-only, plenty fast.
  const vad = new VoiceActivityDetection()

  const session = new AgentSession({
    vad,
    stt: new SarvamSTT({ language: config.language }),
    llm: new SarvamLLM({
      model: 'sarvam-m',
      maxTokens: config.max_tokens ?? 220,
    }),
    tts: new SarvamTTS({
      speaker: config.voice_id,
      // Language is auto-detected per-utterance inside the TTS class
      // using Sarvam /text-lid — same pattern as the Twilio fallback
      // path. The agent-level language only kicks in for pure
      // Latin-script replies where the detector falls back.
      fallbackLanguage: config.language,
    }),
  })

  return {
    agent,
    session,
    say: (text, opts) => session.say(text, opts ?? {}),
    start: (opts) => session.start(opts as Parameters<typeof session.start>[0]),
  }
}
