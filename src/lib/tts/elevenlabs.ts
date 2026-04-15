// ============================================================================
// ElevenLabs TTS — Generate audio and host on Supabase Storage
// Returns a public URL that Twilio can <Play>
// ============================================================================

import crypto from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const BUCKET = 'voice-cache'

/**
 * Generate speech audio via ElevenLabs and return a publicly accessible URL.
 * Uses content hashing for deduplication — same text+voice returns cached URL.
 */
export async function generateAndHostAudio(
  text: string,
  voiceId: string
): Promise<string> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY not configured')
  }

  const supabase = createAdminClient()

  // Hash for deduplication
  const hash = crypto.createHash('sha256').update(`${voiceId}:${text}`).digest('hex').slice(0, 16)
  const filename = `${hash}-${voiceId}.mp3`

  // Check if already cached
  const { data: existing } = supabase.storage.from(BUCKET).getPublicUrl(filename)
  if (existing?.publicUrl) {
    // Verify the file actually exists by doing a HEAD check
    const headRes = await fetch(existing.publicUrl, { method: 'HEAD' })
    if (headRes.ok) {
      return existing.publicUrl
    }
  }

  // Generate audio via ElevenLabs — flash v2.5 is 2x faster than turbo_v2
  const ttsRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  )

  if (!ttsRes.ok) {
    const err = await ttsRes.text()
    console.error('[elevenlabs] TTS API error:', err)
    throw new Error(`ElevenLabs TTS failed: ${ttsRes.status}`)
  }

  const audioBuffer = await ttsRes.arrayBuffer()

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(filename, Buffer.from(audioBuffer), {
      contentType: 'audio/mpeg',
      upsert: true,
    })

  if (uploadError) {
    console.error('[elevenlabs] Storage upload error:', uploadError)
    throw new Error(`Failed to upload audio: ${uploadError.message}`)
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filename)
  return urlData.publicUrl
}
