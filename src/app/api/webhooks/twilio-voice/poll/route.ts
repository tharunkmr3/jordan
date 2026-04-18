// ============================================================================
// Twilio Voice — async job poll endpoint
// ============================================================================
//
// Step 2 of the split-webhook dance (see job-store.ts). The "speech"
// webhook kicks off the LLM+TTS pipeline in the background and
// redirects Twilio here with a jobId. This route looks up the job
// state and responds:
//
//   - ready   → <Play> the synthesized audio, then <Gather> the next
//               user utterance (which POSTs back to the main webhook
//               and starts a new job).
//   - pending → <Pause> 1s then <Redirect> back here with retries+1.
//               Twilio POSTs are fast (<200ms) so the caller hears
//               mostly natural silence while we wait.
//   - error   → apologize + <Hangup>.
//
// A hard retry cap (default 20 → ~20s of polling) prevents the caller
// from being stuck forever if the backend pipeline dies without
// writing an error state.
// ============================================================================

import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getVoiceJob } from '../job-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RETRIES = 20 // ~20 seconds of polling at 1s/hop

function twiml(xml: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`, {
    headers: { 'Content-Type': 'text/xml' },
  })
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Pick the right Polly voice for fallback prompts based on the agent's
 * primary language. Matches the map in the main webhook — kept inline
 * so this route has no cross-import of the main route's internals.
 */
function pollyFor(language: string | null | undefined): string {
  const m: Record<string, string> = {
    en: 'Polly.Joanna', hi: 'Polly.Aditi', ta: 'Polly.Aditi',
    te: 'Polly.Aditi', kn: 'Polly.Aditi', bn: 'Polly.Aditi',
  }
  return m[(language || 'en').toLowerCase()] ?? 'Polly.Joanna'
}

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl
    const jobId = searchParams.get('jobId')
    const agentId = searchParams.get('agentId')
    const retries = Number(searchParams.get('retries') ?? '0') || 0

    if (!jobId || !agentId) {
      return twiml('<Say voice="Polly.Joanna">Sorry, something went wrong. Goodbye.</Say><Hangup/>')
    }

    // Need the agent's language to pick speech-recognition locale + a
    // sensible Polly fallback if we end up bailing.
    const supabase = createAdminClient()
    const { data: agent } = await supabase
      .from('agents')
      .select('language')
      .eq('id', agentId)
      .single()
    const pollyVoice = pollyFor(agent?.language)
    const speechLangMap: Record<string, string> = {
      en: 'en-US', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN',
      kn: 'kn-IN', bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN',
    }
    const speechLang = speechLangMap[agent?.language ?? 'en'] ?? 'en-US'

    const job = getVoiceJob(jobId)

    if (!job) {
      // Job vanished (container restart mid-call, or the main handler
      // crashed before inserting). Bail gracefully.
      console.warn('[twilio-voice/poll] job not found', { jobId })
      return twiml(`<Say voice="${pollyVoice}">Sorry, I lost track of what we were discussing. Please call back.</Say><Hangup/>`)
    }

    if (job.status === 'ready') {
      console.log('[twilio-voice/poll] ready', { jobId, retries, replyLen: job.replyText.length })
      // Play the answer, then open a fresh Gather for the next turn.
      // Gather's action goes back to the main webhook so the next
      // speech creates a new job.
      return twiml(
        `<Play>${escapeXml(job.audioUrl)}</Play>` +
        `<Gather input="speech" action="/api/webhooks/twilio-voice?agentId=${agentId}" method="POST" speechTimeout="auto" language="${speechLang}" speechModel="phone_call"/>` +
        `<Say voice="${pollyVoice}">Thank you for calling. Goodbye.</Say><Hangup/>`
      )
    }

    if (job.status === 'error') {
      console.warn('[twilio-voice/poll] error state', { jobId, message: job.message })
      return twiml(`<Say voice="${pollyVoice}">Sorry, I ran into a problem. Please try again in a moment. Goodbye.</Say><Hangup/>`)
    }

    // Still pending. Keep Twilio warm with a short pause and loop back
    // to ourselves until we exhaust the retry budget.
    if (retries >= MAX_RETRIES) {
      console.warn('[twilio-voice/poll] retries exhausted', { jobId, retries })
      return twiml(`<Say voice="${pollyVoice}">Sorry, that's taking too long. Please try again. Goodbye.</Say><Hangup/>`)
    }

    return twiml(
      `<Pause length="1"/>` +
      `<Redirect method="POST">/api/webhooks/twilio-voice/poll?jobId=${jobId}&amp;agentId=${agentId}&amp;retries=${retries + 1}</Redirect>`
    )
  } catch (err) {
    console.error('[twilio-voice/poll] uncaught:', err)
    return twiml('<Say voice="Polly.Joanna">Sorry, something went wrong. Goodbye.</Say><Hangup/>')
  }
}
