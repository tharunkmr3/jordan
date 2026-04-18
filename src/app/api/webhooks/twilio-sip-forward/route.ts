// ============================================================================
// Twilio SIP-forward webhook
// ============================================================================
//
// Returns a minimal TwiML that forwards the incoming call to the LiveKit
// Cloud SIP ingress. Twilio is now purely a DID provider — the real
// voice pipeline (Sarvam STT + LLM + TTS with streaming + barge-in)
// runs inside the LiveKit Agents worker once the call arrives in the
// LK room.
//
// Replaces the old /api/webhooks/twilio-voice flow for the new Twilio
// number (+12362005512). The old endpoint stays in place for the
// trial number (+16067281257) as a safety net during cutover — retire
// it once the new number is confirmed working.
//
// The SIP URI is read from LIVEKIT_SIP_URI env var so we can repoint
// without pushing code (e.g. moving to a different LK project or
// bringing back a self-hosted SIP for testing).
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_SIP_URI = 'sip:08qvs7s4ewb.sip.livekit.cloud'

function twiml(xml: string) {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

async function handle(request: NextRequest): Promise<NextResponse> {
  // Twilio posts form-encoded params; we only care about `To` to use
  // as the SIP user part — LiveKit's dispatch rule matches by trunk,
  // not by user, so this is mostly informational / for debugging in
  // the Twilio call logs.
  const form = await request.formData().catch(() => null)
  const to = (form?.get('To') as string | null) || '+12362005512'
  const callSid = (form?.get('CallSid') as string | null) || 'unknown'

  const sipHost = process.env.LIVEKIT_SIP_URI || DEFAULT_SIP_URI
  // Ensure we only have the host part (strip any leading scheme).
  const host = sipHost.replace(/^sip:/, '')
  const sipTarget = `sip:${to}@${host};transport=udp`

  console.log('[twilio-sip-forward]', { callSid, to, sipTarget })

  // answerOnBridge keeps the caller on a ringing tone until the agent
  // side of the LiveKit room is ready — avoids dead air while the
  // voice-worker spins up STT/LLM/TTS for the session.
  return twiml(
    `<Dial answerOnBridge="true"><Sip>${escapeXml(sipTarget)}</Sip></Dial>`
  )
}

// Twilio sometimes probes with GET before posting — accept both so a
// health-check in the Twilio dashboard doesn't return a confusing 405.
export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
