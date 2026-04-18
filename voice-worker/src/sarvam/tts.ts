// ============================================================================
// Sarvam Bulbul v3 — streaming TTS adapter for LiveKit Agents.
// ============================================================================
//
// Bulbul v3 exposes a streaming endpoint at
// https://api.sarvam.ai/text-to-speech/stream that returns audio
// chunks (mp3 or mulaw) as it synthesises, letting us pump audio into
// the LiveKit room faster than waiting for a full MP3 like the old
// webhook path did.
//
// Language detection: Bulbul requires target_language_code — no native
// auto-detect. We reuse the same remote /text-lid path the Next.js
// app uses (see src/lib/lang/detect.ts), with the Unicode-script
// heuristic as fallback and the agent's configured language as the
// final fallback for pure Latin text.
//
// Status: STUB — interface + endpoint shape in place; streaming HTTP
// wiring comes in the next commit.
// ============================================================================

import { tts } from '@livekit/agents'

const BULBUL_STREAM_URL = 'https://api.sarvam.ai/text-to-speech/stream'

// Same map the TTS uses in the Next app so agent.language lines up.
const AGENT_LANG_TO_SARVAM: Record<string, string> = {
  en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN',
  bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', ml: 'ml-IN', pa: 'pa-IN', od: 'od-IN',
}

export interface SarvamTTSOptions {
  speaker: string
  fallbackLanguage: string
}

/**
 * LiveKit Agents TTS adapter backed by Sarvam Bulbul v3 streaming.
 *
 * Wire plan for the follow-up pass:
 *   1. `synthesize(text)` POSTs to BULBUL_STREAM_URL with
 *      api-subscription-key + body { text, target_language_code,
 *      speaker, model: "bulbul:v3", output_audio_codec: "mulaw",
 *      speech_sample_rate: 8000 } — mulaw/8kHz matches Twilio SIP
 *      media frames so LiveKit SIP publishes it without transcoding.
 *   2. Read the response as a byte stream, split into chunks, and
 *      yield `tts.AudioChunk`s.
 *   3. Detect the target_language_code via /text-lid first (same
 *      three-layer ladder as the Next app).
 *   4. Propagate interruptions: when LiveKit Agents cancels the
 *      synthesis mid-call (barge-in), abort the fetch so Sarvam
 *      doesn't keep spending tokens on audio no one will hear.
 */
export class SarvamTTS extends tts.TTS {
  private readonly apiKey: string
  private readonly speaker: string
  private readonly fallbackLang: string

  constructor(opts: SarvamTTSOptions) {
    super({
      capabilities: { streaming: true },
      // Bulbul v3 default stream is 24kHz PCM. We request mulaw/8k via
      // the body to match Twilio SIP media without transcoding.
      sampleRate: 8000,
      numChannels: 1,
    })
    const key = process.env.SARVAM_API_KEY
    if (!key) throw new Error('SARVAM_API_KEY not set for SarvamTTS')
    this.apiKey = key
    this.speaker = opts.speaker || 'priya'
    this.fallbackLang = AGENT_LANG_TO_SARVAM[opts.fallbackLanguage.toLowerCase()] ?? 'en-IN'
  }

  // synthesize() implementation lands in the next commit.
}
