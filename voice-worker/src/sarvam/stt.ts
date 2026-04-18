// ============================================================================
// Sarvam Saarika — streaming STT for LiveKit Agents.
// ============================================================================
//
// Saarika is Sarvam's ASR model tuned for Indian languages + Indian-
// accented English. Native streaming over WebSocket (lower latency
// than the chunked-HTTP endpoint). We subscribe to the caller's audio
// frames, forward them into the Saarika socket, and emit transcripts
// back into the LiveKit Agent pipeline.
//
// Endpoint reference:
//   wss://api.sarvam.ai/speech-to-text-streaming
//   Auth: api-subscription-key header on connect
//   Frame format: 16kHz PCM S16LE chunks, JSON control messages
//   Returns: partial + final transcripts with language_code
//
// Status: STUB — class structure + endpoint constants are in place, the
// WebSocket wiring lives in a follow-up commit so this turn's scaffold
// is a clean compile. The LiveKit Agents `stt.STT` interface expects:
//   - stream(): returns an STT.SpeechStream that emits events
//   - close(): releases the socket
// Implementation plan below in-line.
// ============================================================================

import { stt } from '@livekit/agents'

const SAARIKA_WSS_URL = 'wss://api.sarvam.ai/speech-to-text-streaming'

// Sarvam-supported Indic codes. Saarika takes a "target_language_code"
// like hi-IN on connect; for English + Indian accent use en-IN.
const AGENT_LANG_TO_SAARIKA: Record<string, string> = {
  en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN',
  bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', ml: 'ml-IN', pa: 'pa-IN', od: 'od-IN',
}

export interface SarvamSTTOptions {
  language: string
}

/**
 * LiveKit Agents STT adapter backed by Sarvam Saarika streaming.
 *
 * Wire plan for the follow-up pass:
 *   1. On `recognize()`, open a WebSocket to SAARIKA_WSS_URL with the
 *      api-subscription-key header and a `config` frame specifying
 *      target_language_code (from options.language) + enable_partials.
 *   2. Pipe inbound audio frames into the socket as base64 PCM16.
 *   3. For every response frame, emit an `INTERIM_TRANSCRIPT` (when
 *      partial) or `FINAL_TRANSCRIPT` (when final) into the LiveKit
 *      Agents event stream.
 *   4. Propagate language_code from the response so downstream TTS can
 *      pin to what the caller actually spoke.
 *   5. Close the socket on `close()` and reopen per recognition session
 *      (Saarika sockets are scoped to one utterance).
 */
export class SarvamSTT extends stt.STT {
  private readonly apiKey: string
  private readonly langCode: string

  constructor(opts: SarvamSTTOptions) {
    super({
      capabilities: {
        streaming: true,
        interimResults: true,
      },
    })
    const key = process.env.SARVAM_API_KEY
    if (!key) throw new Error('SARVAM_API_KEY not set for SarvamSTT')
    this.apiKey = key
    this.langCode = AGENT_LANG_TO_SAARIKA[opts.language.toLowerCase()] ?? 'en-IN'
  }

  /**
   * LiveKit Agents calls `_recognize` (protected) under the hood when
   * the session needs a one-shot recognition; `stream()` is preferred
   * for streaming. For now we throw on one-shot since Saarika's
   * sweet-spot is streaming — the upper-layer pipeline shouldn't land
   * here.
   */
  async _recognize(_frame: unknown): Promise<stt.SpeechEvent> {
    throw new Error('SarvamSTT: non-streaming recognize not wired yet — use stream()')
  }

  // Override stream() once the WebSocket protocol is wired.
  // `stt.STT#stream()` returns a SpeechStream; we'll return a
  // SarvamSpeechStream that owns the socket lifecycle.
}
