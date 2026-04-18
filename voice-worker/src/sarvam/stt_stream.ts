// ============================================================================
// Sarvam Saarika — streaming STT via WebSocket.
// ============================================================================
//
// Endpoint: wss://api.sarvam.ai/speech-to-text/ws
// Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe/ws
//
// Protocol:
//   Client → Server: JSON messages with base64-encoded PCM16 audio chunks
//     { audio: { data: "<base64>", sample_rate: "16000", encoding: "pcm_s16le" } }
//     { type: "flush" } — force finalize pending transcripts
//   Server → Client:
//     { type: "data", data: { transcript, language_code, ... } } — final per utterance
//     { type: "events", data: { signal_type: "START_SPEECH" | "END_SPEECH" } }
//     { type: "error", data: { error, code } }
//
// Auth: Api-Subscription-Key header on connect.
// Sample rate: 8kHz or 16kHz. We use 16kHz; the base SpeechStream
// resamples input frames to this rate automatically.
// ============================================================================

import WebSocket from 'ws'
import type { AudioFrame } from '@livekit/rtc-node'
import { stt } from '@livekit/agents'
import type { LanguageCode, APIConnectOptions } from '@livekit/agents'
import type { SarvamSTT } from './stt.js'

const SAARIKA_WS_URL = 'wss://api.sarvam.ai/speech-to-text/ws'
const SAMPLE_RATE = 16_000

// How long a single audio message covers — 20ms chunks keep ping-pong
// latency low while avoiding one-message-per-frame overhead. 320 samples
// at 16kHz = 20ms; batch ~5 frames (100ms) to cut websocket overhead.
const CHUNK_SAMPLES = SAMPLE_RATE / 10 // 100ms

interface SarvamSpeechStreamOptions {
  stt: SarvamSTT
  apiKey: string
  langCode: string
  connOptions?: APIConnectOptions
}

export class SarvamSpeechStream extends stt.SpeechStream {
  label = 'sarvam.saarika.stream'
  private readonly apiKey: string
  private readonly langCode: string
  private ws: WebSocket | null = null
  private pendingSamples: number[] = []

  constructor(opts: SarvamSpeechStreamOptions) {
    // Pass sampleRate so the base class auto-resamples incoming frames
    // from whatever SIP sends (usually 8kHz PCMU) into 16kHz PCM16 for
    // Saarika.
    super(opts.stt, SAMPLE_RATE, opts.connOptions)
    this.apiKey = opts.apiKey
    this.langCode = opts.langCode
  }

  /**
   * Open the WebSocket, then concurrently drain audio frames into it
   * and parse server messages into SpeechEvents. Returns when both
   * sides complete (input ended + WS closed).
   */
  protected async run(): Promise<void> {
    const url = new URL(SAARIKA_WS_URL)
    url.searchParams.set('language-code', this.langCode)
    url.searchParams.set('model', 'saaras:v3')
    url.searchParams.set('sample_rate', String(SAMPLE_RATE))
    url.searchParams.set('vad_signals', 'true')
    url.searchParams.set('flush_signal', 'true')
    // Codec selection is via this query param, NOT the message-level
    // `encoding` field (that's a Pydantic enum that only accepts
    // 'audio/wav'). pcm_s16le lets us skip WAV-header framing per chunk.
    url.searchParams.set('input_audio_codec', 'pcm_s16le')

    console.log('[sarvam-stt-stream] connecting', { lang: this.langCode })
    this.ws = new WebSocket(url.toString(), {
      headers: { 'Api-Subscription-Key': this.apiKey },
    })

    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', () => resolve())
      this.ws!.once('error', reject)
    })
    console.log('[sarvam-stt-stream] connected')

    // Spin up both pumps in parallel — either exiting cleans up the
    // other via ws.close() in the finally.
    try {
      await Promise.all([this.pumpAudio(), this.pumpMessages()])
    } finally {
      this.ws?.close()
      this.ws = null
    }
  }

  /**
   * Drain framework input queue → base64 PCM16 chunks → WebSocket.
   * Batches ~100ms worth of audio per message to amortize WS overhead
   * without adding meaningful latency.
   */
  private async pumpAudio(): Promise<void> {
    for await (const item of this.input) {
      // The framework yields AudioFrame for normal audio, or a symbol
      // sentinel on flush/end — anything that isn't a frame triggers
      // a server-side flush so partial transcripts finalize.
      if (typeof item === 'symbol') {
        await this.flushPending()
        this.ws?.send(JSON.stringify({ type: 'flush' }))
        continue
      }

      const frame = item as AudioFrame
      const samples = frame.data as Int16Array
      // Buffer until we have a full chunk, then ship.
      for (let i = 0; i < samples.length; i++) this.pendingSamples.push(samples[i]!)
      while (this.pendingSamples.length >= CHUNK_SAMPLES) {
        const chunk = this.pendingSamples.splice(0, CHUNK_SAMPLES)
        this.sendAudioChunk(new Int16Array(chunk))
      }
    }
    // Final partial chunk on input end.
    await this.flushPending()
  }

  private async flushPending(): Promise<void> {
    if (this.pendingSamples.length === 0) return
    this.sendAudioChunk(new Int16Array(this.pendingSamples))
    this.pendingSamples = []
  }

  private sendAudioChunk(samples: Int16Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const b64 = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64')
    // `encoding` in the message body must be the Pydantic enum literal
    // 'audio/wav' — the ACTUAL codec is selected by the URL query param
    // `input_audio_codec=pcm_s16le` set on connect. Without this exact
    // string Sarvam throws a 422-ish enum validation error and closes
    // the socket mid-stream.
    this.ws.send(JSON.stringify({
      audio: {
        data: b64,
        sample_rate: String(SAMPLE_RATE),
        encoding: 'audio/wav',
      },
    }))
  }

  /**
   * Parse server messages. Saarika emits VAD boundary events + final
   * transcripts per utterance (no interim partials in the documented
   * protocol — emitted as FINAL_TRANSCRIPT events so the AgentSession
   * kicks off the LLM turn immediately when the transcript lands).
   */
  private async pumpMessages(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = this.ws!

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            type?: string
            data?: {
              transcript?: string
              language_code?: string
              language_probability?: number
              signal_type?: 'START_SPEECH' | 'END_SPEECH'
              error?: string
              code?: string
              metrics?: { audio_duration?: number; processing_latency?: number }
            }
          }

          if (msg.type === 'events') {
            const sig = msg.data?.signal_type
            if (sig === 'START_SPEECH') {
              this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH })
            } else if (sig === 'END_SPEECH') {
              this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH })
            }
            return
          }

          if (msg.type === 'data') {
            const text = (msg.data?.transcript ?? '').trim()
            if (!text) return
            const lang = msg.data?.language_code ?? this.langCode
            console.log('[sarvam-stt-stream] transcript', {
              len: text.length,
              lang,
              latencyMs: Math.round((msg.data?.metrics?.processing_latency ?? 0) * 1000),
            })
            this.queue.put({
              type: stt.SpeechEventType.FINAL_TRANSCRIPT,
              alternatives: [{
                text,
                language: lang as LanguageCode,
                startTime: 0,
                endTime: 0,
                confidence: msg.data?.language_probability ?? 1,
              }],
            })
            return
          }

          if (msg.type === 'error') {
            console.error('[sarvam-stt-stream] server error', msg.data)
            // Keep running — Saarika sometimes emits non-fatal errors
            // mid-stream. Fatal errors trigger the close handler.
          }
        } catch (err) {
          console.error('[sarvam-stt-stream] parse failed', err)
        }
      })

      ws.on('close', (code, reason) => {
        console.log('[sarvam-stt-stream] closed', { code, reason: reason?.toString() })
        resolve()
      })
      ws.on('error', (err) => {
        console.error('[sarvam-stt-stream] ws error', err)
        reject(err)
      })
    })
  }
}
