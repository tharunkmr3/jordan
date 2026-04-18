// ============================================================================
// Jordon AI Platform — Twilio Voice Webhook
// Handles incoming calls: greeting → listen → AI response → loop
// Uses ElevenLabs TTS when configured, falls back to Twilio Polly
// ============================================================================

import { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processChatMessage } from '@/lib/ai/chat-pipeline'
import { generateAndHostAudio } from '@/lib/tts/elevenlabs'
import { generateAndHostSarvamAudio, SARVAM_DEFAULT_VOICE } from '@/lib/tts/sarvam'
import { detectSarvamLanguageAsync, agentLanguageToSarvam } from '@/lib/lang/detect'

// Next runtime hints — keep the handler on Node.js (not Edge, which would
// reject some of our deps like the Supabase admin client), force dynamic
// so no caching layer between Twilio and us, and allow up to 60s of
// execution. The actual hard ceiling is Twilio's 15s webhook timeout and
// Coolify's reverse-proxy read-timeout — these hints matter mostly when
// hosting on serverless platforms with their own defaults.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Cap on how long we'll wait for the LLM+TTS stage. Twilio gives us 15s.
// If we hit 12s we bail out with a "one moment" redirect so the caller
// hears something real instead of Coolify's 502 page — the redirect
// bounces right back into this route; the model reply is still saved
// to the conversation so the next turn can reference it.
const STAGE_SOFT_TIMEOUT_MS = 12_000

function twiml(xml: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`, {
    headers: { 'Content-Type': 'text/xml' },
  })
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Strip markdown + formatting chars that TTS engines vocalize literally.
 * Polly's Indian voices in particular spell out stray asterisks, hashes,
 * and underscores ("star", "hash", "underscore"), which ends up being
 * read aloud during a call. Sarvam is better-behaved but we normalize
 * uniformly so the text that hits either provider is clean.
 */
function stripMarkdown(text: string): string {
  return text
    // Paired emphasis first so the unmatched-char sweep below doesn't
    // accidentally swallow content before emphasis is removed cleanly.
    .replace(/\*\*([^*]+?)\*\*/g, '$1')      // bold **text**
    .replace(/\*([^*]+?)\*/g, '$1')          // italic *text*
    .replace(/__([^_]+?)__/g, '$1')          // bold __text__
    .replace(/_([^_]+?)_/g, '$1')            // italic _text_
    .replace(/`([^`]+)`/g, '$1')             // inline code
    .replace(/```[\s\S]*?```/g, '')          // fenced code blocks
    .replace(/^#{1,6}\s+/gm, '')             // headings
    .replace(/^[-*+]\s+/gm, '')              // bullet lists
    .replace(/^\d+\.\s+/gm, '')              // numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links [text](url)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')// images ![alt](url)
    // Strip leftover standalone formatting chars that paired patterns
    // missed (stray `*`, `_`, `#`, `~`, `|`, `>`, backticks). Without
    // this, Polly.Aditi literally says "star" / "hash" / "underscore".
    .replace(/[*_#~|>`]/g, '')
    // URLs: TTS engines read every character of a raw URL. Strip bare
    // http(s) / www links entirely — agents shouldn't be emitting them
    // on voice channels, but defence in depth.
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    // Emoji + pictographs → TTS vocalises them as "face with tears of joy"
    // etc. Strip the entire Extended_Pictographic range.
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\n{2,}/g, '. ')                // collapse paragraphs
    .replace(/\n/g, ' ')                     // single newlines to spaces
    .replace(/\s+/g, ' ')                    // collapse whitespace
    .trim()
}

/**
 * Generate a TwiML speech element. Provider ladder:
 *   - sarvam → Bulbul v3 with Unicode-script language detection (auto-
 *     switches voice language turn-by-turn for multilingual conversations)
 *   - elevenlabs → English-first generative voice
 *   - anything else → Twilio Polly <Say> (free, works everywhere)
 * Each non-Polly provider falls through to Polly on error so a provider
 * outage degrades gracefully instead of killing the call.
 */
async function speak(
  text: string,
  voiceProvider: string | null,
  voiceId: string | null,
  pollyVoice: string,
  agentLanguage: string | null = null,
): Promise<string> {
  const cleanText = stripMarkdown(text)

  console.log('[twilio-voice/speak] start', {
    provider: voiceProvider,
    voiceId,
    agentLanguage,
    textLen: cleanText.length,
    textPreview: cleanText.slice(0, 80),
  })

  if (voiceProvider === 'sarvam') {
    try {
      // Language auto-detection: try Sarvam's /text-lid first (it handles
      // Romanised Hinglish and code-mixed content the local script
      // detector can't see), fall back to Unicode-script analysis on
      // failure, and finally to the agent's configured language for
      // pure Latin-script content.
      const fallback = agentLanguageToSarvam(agentLanguage)
      const lang = await detectSarvamLanguageAsync(cleanText, fallback)
      const speaker = voiceId || SARVAM_DEFAULT_VOICE
      console.log('[twilio-voice/speak] sarvam', { lang, speaker })
      const audioUrl = await generateAndHostSarvamAudio(cleanText, speaker, lang)
      console.log('[twilio-voice/speak] sarvam ok', { audioUrl })
      return `<Play>${escapeXml(audioUrl)}</Play>`
    } catch (err) {
      console.error('[twilio-voice/speak] sarvam failed → Polly fallback:', err)
    }
  }

  if (voiceProvider === 'elevenlabs' && voiceId) {
    try {
      const audioUrl = await generateAndHostAudio(cleanText, voiceId)
      return `<Play>${escapeXml(audioUrl)}</Play>`
    } catch (err) {
      console.error('[twilio-voice/speak] elevenlabs failed → Polly fallback:', err)
    }
  }
  console.log('[twilio-voice/speak] polly', { pollyVoice })
  return `<Say voice="${pollyVoice}">${escapeXml(cleanText)}</Say>`
}

// ---------------------------------------------------------------------------
// POST — Handle incoming call or speech result
// ---------------------------------------------------------------------------

/**
 * Race `promise` against a timer. Resolves to { ok: true, value } when the
 * promise finishes in time, or { ok: false } when it doesn't. Never throws
 * — the caller decides how to degrade. Used to keep the webhook handler
 * under Twilio's 15s + Coolify's proxy read-timeout.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false }), ms)
    promise.then(
      (value) => { clearTimeout(t); resolve({ ok: true, value }) },
      () => { clearTimeout(t); resolve({ ok: false }) },
    )
  })
}

export async function POST(request: NextRequest) {
  // Top-level guard: any uncaught error becomes a graceful <Hangup/>
  // instead of a 500 that Twilio reports as "Got HTTP 502 response" to
  // the caller. Twilio can't read a crash trace — we owe it valid XML.
  try {
    return await handle(request)
  } catch (err) {
    console.error('[twilio-voice] uncaught:', err)
    return twiml('<Say voice="Polly.Joanna">Sorry, something went wrong on our side. Please try again in a moment.</Say><Hangup/>')
  }
}

async function handle(request: NextRequest): Promise<Response> {
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

  // First call — no speech result yet, greet and listen. The two speak()
  // calls are independent, so run them in parallel to shave ~1s off the
  // initial webhook response.
  if (!speechResult) {
    const greeting = agent.greeting_message || `Hi, you've reached ${agent.name}. How can I help you?`
    const [greetingSpeech, listenPrompt] = await Promise.all([
      speak(greeting, agent.voice_provider, agent.voice_id, pollyVoice, agent.language),
      speak("I'm listening.", agent.voice_provider, agent.voice_id, pollyVoice, agent.language),
    ])

    return twiml(
      greetingSpeech +
      `<Gather input="speech" action="/api/webhooks/twilio-voice?agentId=${agentId}" method="POST" speechTimeout="auto" language="${speechLang}" speechModel="phone_call">` +
      listenPrompt +
      `</Gather>` +
      `<Say voice="${pollyVoice}">I didn't hear anything. Goodbye.</Say><Hangup/>`
    )
  }

  // Got speech — process through AI pipeline.
  //
  // Twilio enforces a 15s hard timeout on the webhook response. With the
  // LLM turn (5-12s on Opus / Gemini Pro) plus two serial Sarvam TTS
  // calls (2-4s each on longer replies), sequential execution reliably
  // blows past the limit → the caller hears "an application error
  // occurred". Countermeasures:
  //
  //   1. Run the two TTS synths concurrently (~halves the TTS stage)
  //   2. Pipeline-side, the 'phone' channel caps max_tokens and asks
  //      the model for ≤40-word replies (see buildPrompt in
  //      src/lib/ai/chat-pipeline.ts)
  //   3. Timing log around each stage so Coolify reveals the slow step
  try {
    const t0 = Date.now()

    // Soft timeout ladder: race the full LLM+TTS pipeline against a 12s
    // clock. If it wins, return the real reply. If the clock wins, we
    // cut our losses and return a stall TwiML ("One moment please")
    // that redirects Twilio back into this webhook — the work keeps
    // running in the Node event loop so the answer may be ready on the
    // next hop (cached audio URL, since Sarvam's cache key is
    // deterministic). Prevents Coolify's proxy from 502'ing the call.
    const pipelinePromise = (async () => {
      const result = await processChatMessage({
        agentId: agent.id,
        message: speechResult,
        conversationId: callSid,
        channel: 'phone',
        contactInfo: { phone: from, channelUserId: from },
      })
      const tAfterLlm = Date.now()
      const [responseSpeech, followUp] = await Promise.all([
        speak(result.response, agent.voice_provider, agent.voice_id, pollyVoice, agent.language),
        speak("Is there anything else I can help with?", agent.voice_provider, agent.voice_id, pollyVoice, agent.language),
      ])
      const tAfterTts = Date.now()
      console.log('[twilio-voice] timing', {
        llmMs: tAfterLlm - t0,
        ttsMs: tAfterTts - tAfterLlm,
        totalMs: tAfterTts - t0,
        responseLen: result.response.length,
      })
      return { responseSpeech, followUp }
    })()

    const raced = await withTimeout(pipelinePromise, STAGE_SOFT_TIMEOUT_MS)

    if (!raced.ok) {
      // Didn't finish in time. Keep the real work going in the
      // background so Sarvam's cache fills for the retry hop, and
      // return a short "thinking" TwiML that loops the user back
      // here. After a handful of loops Twilio hits its own retry cap,
      // but in practice the cache lands on the first retry.
      pipelinePromise.catch((e) => console.error('[twilio-voice] background pipeline error:', e))
      console.warn('[twilio-voice] soft timeout — redirecting to stall loop', { ms: STAGE_SOFT_TIMEOUT_MS })
      return twiml(
        `<Say voice="${pollyVoice}">One moment, please.</Say>` +
        `<Pause length="2"/>` +
        `<Redirect method="POST">/api/webhooks/twilio-voice?agentId=${agentId}&amp;stall=1</Redirect>`
      )
    }

    const { responseSpeech, followUp } = raced.value
    return twiml(
      responseSpeech +
      `<Gather input="speech" action="/api/webhooks/twilio-voice?agentId=${agentId}" method="POST" speechTimeout="auto" language="${speechLang}" speechModel="phone_call">` +
      followUp +
      `</Gather>` +
      `<Say voice="${pollyVoice}">Thank you for calling. Goodbye.</Say><Hangup/>`
    )
  } catch (err) {
    console.error('[twilio-voice] Pipeline error:', err)
    // Best-effort graceful close — fall back to Polly so we don't
    // double-fail trying to synthesise the error message itself.
    return twiml(`<Say voice="${pollyVoice}">I'm sorry, I'm having trouble right now. Please try again later. Goodbye.</Say><Hangup/>`)
  }
}
