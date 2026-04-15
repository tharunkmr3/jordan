// ============================================================================
// Jordon AI Platform — Twilio Voice Webhook
// Handles incoming calls: greeting → listen → AI response → loop
// Uses ElevenLabs TTS when configured, falls back to Twilio Polly
// ============================================================================

import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processChatMessage } from '@/lib/ai/chat-pipeline'
import { generateAndHostAudio } from '@/lib/tts/elevenlabs'

function twiml(xml: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`, {
    headers: { 'Content-Type': 'text/xml' },
  })
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Generate a TwiML speech element — <Play> for ElevenLabs, <Say> for Polly fallback
 */
async function speak(text: string, voiceProvider: string | null, voiceId: string | null, pollyVoice: string): Promise<string> {
  if (voiceProvider === 'elevenlabs' && voiceId) {
    try {
      const audioUrl = await generateAndHostAudio(text, voiceId)
      return `<Play>${escapeXml(audioUrl)}</Play>`
    } catch (err) {
      console.error('[twilio-voice] ElevenLabs failed, falling back to Polly:', err)
    }
  }
  return `<Say voice="${pollyVoice}">${escapeXml(text)}</Say>`
}

// ---------------------------------------------------------------------------
// POST — Handle incoming call or speech result
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const formData = await request.formData()
  const agentId = request.nextUrl.searchParams.get('agentId')
  const callSid = formData.get('CallSid') as string
  const from = formData.get('From') as string
  const speechResult = formData.get('SpeechResult') as string | null

  if (!agentId) {
    return twiml('<Say voice="Polly.Aditi">Sorry, this number is not configured. Goodbye.</Say><Hangup/>')
  }

  const supabase = createAdminClient()

  // Load agent with voice config
  const { data: agent } = await supabase
    .from('agents')
    .select('id, name, greeting_message, language, org_id, voice_provider, voice_id')
    .eq('id', agentId)
    .eq('status', 'active')
    .single()

  if (!agent) {
    return twiml('<Say voice="Polly.Aditi">Sorry, this agent is not available right now. Goodbye.</Say><Hangup/>')
  }

  // Polly voice fallback by language
  const pollyMap: Record<string, string> = {
    en: 'Polly.Joanna', hi: 'Polly.Aditi', ta: 'Polly.Aditi',
    te: 'Polly.Aditi', kn: 'Polly.Aditi', bn: 'Polly.Aditi',
  }
  const pollyVoice = pollyMap[agent.language] || 'Polly.Joanna'
  const langMap: Record<string, string> = {
    en: 'en-US', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN',
    kn: 'kn-IN', bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN',
  }
  const speechLang = langMap[agent.language] || 'en-US'

  // First call — no speech result yet, greet and listen
  if (!speechResult) {
    const greeting = agent.greeting_message || `Hi, you've reached ${agent.name}. How can I help you?`
    const greetingSpeech = await speak(greeting, agent.voice_provider, agent.voice_id, pollyVoice)
    const listenPrompt = await speak("I'm listening.", agent.voice_provider, agent.voice_id, pollyVoice)

    return twiml(
      greetingSpeech +
      `<Gather input="speech" action="/api/webhooks/twilio-voice?agentId=${agentId}" method="POST" speechTimeout="auto" language="${speechLang}" speechModel="phone_call">` +
      listenPrompt +
      `</Gather>` +
      `<Say voice="${pollyVoice}">I didn't hear anything. Goodbye.</Say><Hangup/>`
    )
  }

  // Got speech — process through AI pipeline
  try {
    const result = await processChatMessage({
      agentId: agent.id,
      message: speechResult,
      conversationId: callSid,
      channel: 'phone',
      contactInfo: {
        phone: from,
        channelUserId: from,
      },
    })

    // Generate TTS for the AI response
    const responseSpeech = await speak(result.response, agent.voice_provider, agent.voice_id, pollyVoice)
    const followUp = await speak("Is there anything else I can help with?", agent.voice_provider, agent.voice_id, pollyVoice)

    return twiml(
      responseSpeech +
      `<Gather input="speech" action="/api/webhooks/twilio-voice?agentId=${agentId}" method="POST" speechTimeout="auto" language="${speechLang}" speechModel="phone_call">` +
      followUp +
      `</Gather>` +
      `<Say voice="${pollyVoice}">Thank you for calling. Goodbye.</Say><Hangup/>`
    )
  } catch (err) {
    console.error('[twilio-voice] Pipeline error:', err)
    const errorSpeech = await speak(
      "I'm sorry, I'm having trouble right now. Please try again later. Goodbye.",
      agent.voice_provider, agent.voice_id, pollyVoice
    )
    return twiml(errorSpeech + '<Hangup/>')
  }
}
