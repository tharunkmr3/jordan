// ============================================================================
// Sarvam Saarika — non-streaming STT for LiveKit Agents.
// ============================================================================
//
// Uses Saarika's synchronous HTTP /speech-to-text endpoint. Wrap this
// instance with @livekit/agents' StreamAdapter + a VAD to get the
// streaming interface the voice pipeline expects — LiveKit buffers
// audio between speech-start/end events, calls our `_recognize`, we
// POST a WAV to Saarika, and return the transcript.
//
// The real streaming endpoint (wss://api.sarvam.ai/speech-to-text-
// streaming) is a follow-up — buffered-utterance latency is already
// fine for MVP since our LLM+TTS stages are the bigger waits.
// ============================================================================

import type { AudioFrame } from '@livekit/rtc-node'
import { stt } from '@livekit/agents'
import type { AudioBuffer, LanguageCode } from '@livekit/agents'

const SAARIKA_URL = 'https://api.sarvam.ai/speech-to-text'
const SAARIKA_MODEL = 'saarika:v2'

// agents.language (ISO-639-1) → Sarvam BCP-47. `unknown` lets Saarika
// auto-detect, which matters for multilingual callers.
const AGENT_LANG_TO_SAARIKA: Record<string, string> = {
  en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN',
  bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', ml: 'ml-IN', pa: 'pa-IN', od: 'od-IN',
}

export interface SarvamSTTOptions {
  /** ISO-639-1 hint ("te", "hi", etc). Maps to Saarika BCP-47. */
  language: string
}

export class SarvamSTT extends stt.STT {
  label = 'sarvam.saarika'
  private readonly apiKey: string
  private readonly langCode: string

  constructor(opts: SarvamSTTOptions) {
    super({ streaming: false, interimResults: false })
    const key = process.env.SARVAM_API_KEY
    if (!key) throw new Error('SARVAM_API_KEY not set for SarvamSTT')
    this.apiKey = key
    this.langCode = AGENT_LANG_TO_SAARIKA[opts.language.toLowerCase()] ?? 'unknown'
  }

  get model() { return SAARIKA_MODEL }
  get provider() { return 'sarvam' }

  /**
   * Synchronous utterance recognition. Called by the StreamAdapter
   * wrapper once VAD has carved the caller's speech into a complete
   * utterance buffer.
   */
  protected async _recognize(frame: AudioBuffer): Promise<stt.SpeechEvent> {
    const wav = audioBufferToWav(frame)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utt.wav')
    form.append('model', SAARIKA_MODEL)
    form.append('language_code', this.langCode)

    const res = await fetch(SAARIKA_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey },
      body: form,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[sarvam-stt] failed', { status: res.status, body: body.slice(0, 300) })
      // Empty transcript lets AgentSession continue gracefully —
      // throwing would kill the whole voice session mid-call.
      return {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [{ text: '', language: 'en-IN' as LanguageCode, startTime: 0, endTime: 0, confidence: 0 }],
      }
    }
    const json = (await res.json()) as { transcript?: string; language_code?: string }
    const text = (json.transcript ?? '').trim()
    console.log('[sarvam-stt] ok', { len: text.length, lang: json.language_code })
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{
        text,
        language: (json.language_code ?? this.langCode) as LanguageCode,
        startTime: 0,
        endTime: 0,
        confidence: 1,
      }],
    }
  }

  /**
   * StreamAdapter plugs in the real streaming behaviour — this
   * `stream()` should never be called directly. We throw so incorrect
   * pipeline wiring surfaces loud instead of failing silently.
   */
  stream(): stt.SpeechStream {
    throw new Error('SarvamSTT must be wrapped with StreamAdapter + VAD; do not call stream() directly.')
  }
}

/**
 * Encode one or more LiveKit AudioFrames (mono PCM16) as a WAV byte
 * buffer — what Saarika expects as file contents. Handles a single
 * frame or an array transparently.
 */
function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const frames: AudioFrame[] = Array.isArray(buffer) ? buffer : [buffer]
  const sampleRate = frames[0]?.sampleRate ?? 16000

  // Flatten sample data into one Int16Array across all frames.
  let totalSamples = 0
  for (const f of frames) totalSamples += (f.data as Int16Array).length
  const samples = new Int16Array(totalSamples)
  let off = 0
  for (const f of frames) {
    const d = f.data as Int16Array
    samples.set(d, off)
    off += d.length
  }
  const byteLen = samples.length * 2

  // Minimal PCM16 mono WAV header.
  const out = new Uint8Array(44 + byteLen)
  const view = new DataView(out.buffer)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + byteLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)       // PCM
  view.setUint16(22, 1, true)       // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, byteLen, true)
  new Int16Array(out.buffer, 44).set(samples)
  return out
}
