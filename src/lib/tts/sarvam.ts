// ============================================================================
// Sarvam TTS — Bulbul v3 for Indian language voice output.
// Generates audio, uploads to Supabase Storage, returns a public URL that
// Twilio <Play> can fetch. Mirrors the shape of elevenlabs.ts so the voice
// webhook can treat providers uniformly.
// ============================================================================

import crypto from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'

const SARVAM_API_KEY = process.env.SARVAM_API_KEY
const BUCKET = 'voice-cache'

/**
 * Eleven target languages Sarvam supports, in the canonical BCP-47 form the
 * API expects. Centralised so the call site + the detector + the UI all
 * share the same type.
 */
export type SarvamLanguageCode =
  | 'en-IN' | 'hi-IN' | 'ta-IN' | 'te-IN' | 'kn-IN'
  | 'ml-IN' | 'mr-IN' | 'bn-IN' | 'gu-IN' | 'pa-IN' | 'od-IN'

/**
 * Generate speech via Sarvam Bulbul v3 and host the MP3 on Supabase Storage.
 * Dedupes by content hash so identical (text, speaker, language) payloads
 * re-use the cached URL.
 *
 * Bulbul v3 produces telephony-grade 22050 Hz MP3 that Twilio plays back
 * without transcoding — the hard requirement here is that the URL is
 * publicly reachable, which the Supabase storage public bucket handles.
 */
export async function generateAndHostSarvamAudio(
  text: string,
  speaker: string,
  languageCode: SarvamLanguageCode,
): Promise<string> {
  if (!SARVAM_API_KEY) throw new Error('SARVAM_API_KEY not configured')

  const supabase = createAdminClient()

  // Cache key includes speaker + language — a re-render of the same text
  // in a different voice must not collide.
  const hash = crypto
    .createHash('sha256')
    .update(`sarvam:${speaker}:${languageCode}:${text}`)
    .digest('hex')
    .slice(0, 16)
  const filename = `${hash}-sarvam-${speaker}.mp3`

  const { data: existing } = supabase.storage.from(BUCKET).getPublicUrl(filename)
  if (existing?.publicUrl) {
    const head = await fetch(existing.publicUrl, { method: 'HEAD' })
    if (head.ok) return existing.publicUrl
  }

  // Bulbul v3 caps input at 2500 chars; truncate defensively so a long
  // reply doesn't 400 the whole TTS call.
  const truncatedText = text.length > 2500 ? text.slice(0, 2500) : text

  // enable_preprocessing is a v2-only flag — passing it to v3 throws a 400.
  // Keep the payload to v3-supported fields only.
  const payload = {
    text: truncatedText,
    target_language_code: languageCode,
    speaker,
    model: 'bulbul:v3',
    // 22050 Hz MP3 is the sweet spot — good fidelity for telephony and
    // small enough that caching doesn't blow up storage.
    speech_sample_rate: 22050,
    output_audio_codec: 'mp3',
  }

  const ttsRes = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'api-subscription-key': SARVAM_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!ttsRes.ok) {
    const err = await ttsRes.text().catch(() => '')
    console.error('[sarvam] TTS API error', {
      status: ttsRes.status,
      body: err.slice(0, 600),
      speaker,
      language: languageCode,
      textLength: truncatedText.length,
    })
    throw new Error(`Sarvam TTS failed: ${ttsRes.status}`)
  }

  // Sarvam returns JSON: { audios: [base64-mp3-string], request_id }. We
  // only use the first chunk — the API auto-splits long inputs but for
  // our short agent responses a single chunk is the norm.
  const body = (await ttsRes.json()) as { audios?: string[] }
  const base64 = body.audios?.[0]
  if (!base64) throw new Error('Sarvam TTS returned no audio')

  const audioBuffer = Buffer.from(base64, 'base64')

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(filename, audioBuffer, { contentType: 'audio/mpeg', upsert: true })

  if (uploadErr) {
    console.error('[sarvam] Storage upload error:', uploadErr)
    throw new Error(`Failed to upload Sarvam audio: ${uploadErr.message}`)
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filename)
  return urlData.publicUrl
}

// ---------------------------------------------------------------------------
// Voice catalog
// ---------------------------------------------------------------------------

/**
 * Curated Sarvam Bulbul v3 voices exposed in the agent-settings UI. The full
 * v3 catalog has 30+ voices; we surface a shorter set that covers warm,
 * professional, clear registers. `anushka` is first because it's the most
 * reliable "customer support" voice — neutral, friendly, clear — and is
 * selected as the default when the agent first picks Sarvam.
 */
export const SARVAM_VOICES: Array<{ id: string; label: string; note: string }> = [
  { id: 'anushka',  label: 'Anushka',  note: 'Customer support (default)' },
  { id: 'manisha',  label: 'Manisha',  note: 'Warm, friendly' },
  { id: 'vidya',    label: 'Vidya',    note: 'Calm, narrator' },
  { id: 'arya',     label: 'Arya',     note: 'Clear, professional' },
  { id: 'abhilash', label: 'Abhilash', note: 'Neutral, male' },
  { id: 'karun',    label: 'Karun',    note: 'Warm, male' },
  { id: 'hitesh',   label: 'Hitesh',   note: 'Confident, male' },
]

/** Default speaker when the user switches an agent to Sarvam. */
export const SARVAM_DEFAULT_VOICE = 'anushka'
