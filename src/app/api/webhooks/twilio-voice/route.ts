// ============================================================================
// Jordon AI Platform — Twilio Voice Webhook
// Handles incoming calls: greeting → listen → AI response → loop
// ============================================================================

import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processChatMessage } from '@/lib/ai/chat-pipeline'

function twiml(xml: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`, {
    headers: { 'Content-Type': 'text/xml' },
  })
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

  // Load agent
  const { data: agent } = await supabase
    .from('agents')
    .select('id, name, greeting_message, language, org_id')
    .eq('id', agentId)
    .eq('status', 'active')
    .single()

  if (!agent) {
    return twiml('<Say voice="Polly.Aditi">Sorry, this agent is not available right now. Goodbye.</Say><Hangup/>')
  }

  // Pick Twilio voice based on agent language
  const voiceMap: Record<string, string> = {
    en: 'Polly.Joanna', hi: 'Polly.Aditi', ta: 'Polly.Aditi',
    te: 'Polly.Aditi', kn: 'Polly.Aditi', bn: 'Polly.Aditi',
  }
  const voice = voiceMap[agent.language] || 'Polly.Joanna'
  const langMap: Record<string, string> = {
    en: 'en-US', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN',
    kn: 'kn-IN', bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN',
  }
  const speechLang = langMap[agent.language] || 'en-US'

  // First call — no speech result yet, greet and listen
  if (!speechResult) {
    const greeting = agent.greeting_message || `Hi, you've reached ${agent.name}. How can I help you?`
    return twiml(
      `<Say voice="${voice}">${escapeXml(greeting)}</Say>` +
      `<Gather input="speech" action="/api/webhooks/twilio-voice?agentId=${agentId}" method="POST" speechTimeout="auto" language="${speechLang}" speechModel="phone_call">` +
      `<Say voice="${voice}">I'm listening.</Say>` +
      `</Gather>` +
      `<Say voice="${voice}">I didn't hear anything. Goodbye.</Say><Hangup/>`
    )
  }

  // Got speech — process through AI pipeline
  try {
    const result = await processChatMessage({
      agentId: agent.id,
      message: speechResult,
      conversationId: callSid, // Use call SID as conversation identifier
      channel: 'phone',
      contactInfo: {
        phone: from,
        channelUserId: from,
      },
    })

    // Respond with AI answer and listen for next input
    return twiml(
      `<Say voice="${voice}">${escapeXml(result.response)}</Say>` +
      `<Gather input="speech" action="/api/webhooks/twilio-voice?agentId=${agentId}" method="POST" speechTimeout="auto" language="${speechLang}" speechModel="phone_call">` +
      `<Say voice="${voice}">Is there anything else I can help with?</Say>` +
      `</Gather>` +
      `<Say voice="${voice}">Thank you for calling. Goodbye.</Say><Hangup/>`
    )
  } catch (err) {
    console.error('[twilio-voice] Pipeline error:', err)
    return twiml(
      `<Say voice="${voice}">I'm sorry, I'm having trouble right now. Please try again later. Goodbye.</Say><Hangup/>`
    )
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
