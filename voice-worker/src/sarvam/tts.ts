// ============================================================================
// Sarvam Bulbul v3 — non-streaming TTS for LiveKit Agents.
// ============================================================================
//
// Fetches a full PCM16 audio buffer from Sarvam's /text-to-speech
// endpoint, chunks it into AudioFrames via LiveKit's AudioByteStream
// helper, and pushes them onto the Agents queue. Streaming TTS
// (wss://) is a follow-up optimisation — end-to-end latency is
// dominated by LLM + the fetch roundtrip, so streaming the audio
// buffer itself is a marginal win here.
//
// Endpoint:  POST https://api.sarvam.ai/text-to-speech
// Auth:      api-subscription-key header
// Returns:   { audios: [base64 linear16 PCM] }
// Model:     bulbul:v3 (enable_preprocessing is v2-only — don't send it)
// ============================================================================

import type { APIConnectOptions } from '@livekit/agents'
import { AudioByteStream, shortuuid, tts } from '@livekit/agents'

const TTS_URL = 'https://api.sarvam.ai/text-to-speech'
const SAMPLE_RATE = 24_000
const CHANNELS = 1

const AGENT_LANG_TO_SARVAM: Record<string, string> = {
  en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN',
  bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', ml: 'ml-IN', pa: 'pa-IN', od: 'od-IN',
}

export interface SarvamTTSOptions {
  /** Bulbul v3 speaker id — priya / neha / pooja / aditya / etc. */
  speaker: string
  /** ISO-639-1 agent language; used when script detection can't pin. */
  fallbackLanguage: string
}

export class SarvamTTS extends tts.TTS {
  label = 'sarvam.bulbul-v3'
  private readonly apiKey: string
  private readonly speaker: string
  private readonly fallbackLang: string

  constructor(opts: SarvamTTSOptions) {
    super(SAMPLE_RATE, CHANNELS, { streaming: false })
    const key = process.env.SARVAM_API_KEY
    if (!key) throw new Error('SARVAM_API_KEY not set for SarvamTTS')
    this.apiKey = key
    this.speaker = opts.speaker || 'priya'
    this.fallbackLang = AGENT_LANG_TO_SARVAM[opts.fallbackLanguage.toLowerCase()] ?? 'en-IN'
  }

  get model() { return 'bulbul:v3' }
  get provider() { return 'sarvam' }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new SarvamChunkedStream({
      text,
      tts: this,
      apiKey: this.apiKey,
      speaker: this.speaker,
      fallbackLang: this.fallbackLang,
      connOptions,
      abortSignal,
    })
  }

  stream(): tts.SynthesizeStream {
    throw new Error('SarvamTTS: streaming path not wired — use synthesize()')
  }
}

interface SarvamChunkedStreamArgs {
  text: string
  tts: SarvamTTS
  apiKey: string
  speaker: string
  fallbackLang: string
  connOptions?: APIConnectOptions
  abortSignal?: AbortSignal
}

class SarvamChunkedStream extends tts.ChunkedStream {
  label = 'sarvam.bulbul-v3.chunked'
  private readonly apiKey: string
  private readonly speaker: string
  private readonly fallbackLang: string

  constructor(args: SarvamChunkedStreamArgs) {
    super(args.text, args.tts, args.connOptions, args.abortSignal)
    this.apiKey = args.apiKey
    this.speaker = args.speaker
    this.fallbackLang = args.fallbackLang
  }

  protected async run(): Promise<void> {
    try {
      // Bulbul v3 caps input at 2500 chars; truncate defensively so a
      // runaway LLM reply doesn't 4xx the whole call.
      const text = this.inputText.slice(0, 2500)
      const lang = detectSarvamLanguage(text, this.fallbackLang)

      const t0 = Date.now()
      const res = await fetch(TTS_URL, {
        method: 'POST',
        signal: this.abortSignal,
        headers: {
          'api-subscription-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          target_language_code: lang,
          speaker: this.speaker,
          model: 'bulbul:v3',
          speech_sample_rate: SAMPLE_RATE,
          output_audio_codec: 'linear16',
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Sarvam TTS ${res.status}: ${body.slice(0, 300)}`)
      }
      const json = (await res.json()) as { audios?: string[] }
      const base64 = json.audios?.[0]
      if (!base64) throw new Error('Sarvam TTS returned no audio')

      const pcm = Buffer.from(base64, 'base64')
      console.log('[sarvam-tts] synth', {
        speaker: this.speaker, lang, textLen: text.length,
        audioBytes: pcm.byteLength, ms: Date.now() - t0,
      })

      // Chunk the PCM into AudioFrames sized for the LiveKit pipeline.
      // AudioByteStream handles framing; we just feed bytes in order.
      const requestId = shortuuid()
      const segmentId = shortuuid()
      const byteStream = new AudioByteStream(SAMPLE_RATE, CHANNELS)
      const pcmBytes = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
      const frames = byteStream.write(pcmBytes)

      // Emit all but the last frame as non-final, then the last as
      // final — the framework uses this boundary to know when the
      // segment ends and the pipeline can move on.
      let last: typeof frames[number] | undefined
      for (const frame of frames) {
        if (last) this.queue.put({ requestId, segmentId, frame: last, final: false })
        last = frame
      }
      if (last) this.queue.put({ requestId, segmentId, frame: last, final: true })

      this.queue.close()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      console.error('[sarvam-tts] failed:', err)
      throw err
    } finally {
      this.queue.close()
    }
  }
}

/**
 * Local-only script detector — no remote /text-lid call here because
 * we're inside the hot path of a live call. Same thresholds as the
 * Next.js app's detector: ≥3 Indic codepoints AND ≥30% of letters
 * must be Indic before flipping from the fallback.
 */
function detectSarvamLanguage(text: string, fallback: string): string {
  const ranges: Array<{ lang: string; lo: number; hi: number }> = [
    { lang: 'hi-IN', lo: 0x0900, hi: 0x097F },
    { lang: 'bn-IN', lo: 0x0980, hi: 0x09FF },
    { lang: 'pa-IN', lo: 0x0A00, hi: 0x0A7F },
    { lang: 'gu-IN', lo: 0x0A80, hi: 0x0AFF },
    { lang: 'od-IN', lo: 0x0B00, hi: 0x0B7F },
    { lang: 'ta-IN', lo: 0x0B80, hi: 0x0BFF },
    { lang: 'te-IN', lo: 0x0C00, hi: 0x0C7F },
    { lang: 'kn-IN', lo: 0x0C80, hi: 0x0CFF },
    { lang: 'ml-IN', lo: 0x0D00, hi: 0x0D7F },
  ]
  const counts: Record<string, number> = {}
  let indic = 0, letters = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c > 0x20 && !(c >= 0x21 && c <= 0x2F) && !(c >= 0x3A && c <= 0x40)) letters++
    for (const r of ranges) if (c >= r.lo && c <= r.hi) {
      counts[r.lang] = (counts[r.lang] ?? 0) + 1
      indic++
      break
    }
  }
  let best: string | null = null
  let bestN = 0
  for (const [l, n] of Object.entries(counts)) if (n > bestN) { best = l; bestN = n }
  const ratio = letters > 0 ? indic / letters : 0
  return bestN >= 3 && ratio >= 0.3 && best ? best : fallback
}
