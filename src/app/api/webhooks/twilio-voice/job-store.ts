// ============================================================================
// Voice job store
// ============================================================================
//
// Twilio's webhook model is synchronous — the handler must return valid
// TwiML inside 15 seconds or the caller hears "application error".
// Our LLM + TTS pipeline routinely takes 8-18s on longer replies, so
// we split the work across two webhook hops:
//
//   1. The "speech" hook kicks off the job asynchronously, stores it
//      in this Map keyed by a fresh jobId, and returns a short
//      <Pause>+<Redirect> to /twilio-voice/poll in well under 2s.
//   2. The /twilio-voice/poll hook looks up the job; if ready it
//      returns <Play>; if pending it returns another <Pause>+<Redirect>
//      to itself with an incremented retry counter. Coolify's
//      reverse-proxy timeout is comfortably above our 1-2s poll
//      responses, and Twilio is happy because every response is fast.
//
// In-memory is sufficient because:
//   - Coolify runs a single container per app (no horizontal scale
//     in play for the voice webhook)
//   - Phone-call state is already ephemeral — a container restart
//     during an active call drops the call anyway
// If we ever add a second replica we'd lift this to Redis (coolify-redis
// is already running on the VPS for other features).
// ============================================================================

export type VoiceJobStatus =
  | { status: 'pending' }
  | { status: 'ready'; audioUrl: string; replyText: string }
  | { status: 'error'; message: string }

const STORE = new Map<string, { state: VoiceJobStatus; createdAt: number }>()

// Safety valve: jobs older than 2 minutes are pruned on every read.
// 2 min is longer than any sane call-turn and shorter than what would
// let the map leak if a call drops mid-turn.
const TTL_MS = 2 * 60 * 1000

function prune() {
  const cutoff = Date.now() - TTL_MS
  for (const [k, v] of STORE) {
    if (v.createdAt < cutoff) STORE.delete(k)
  }
}

/**
 * Register a freshly-started job and return its id. The id is the
 * opaque token passed through TwiML <Redirect> URLs so subsequent
 * poll hits can find the same job.
 */
export function createVoiceJob(jobId: string): void {
  prune()
  STORE.set(jobId, { state: { status: 'pending' }, createdAt: Date.now() })
}

export function setVoiceJobReady(jobId: string, audioUrl: string, replyText: string): void {
  const existing = STORE.get(jobId)
  STORE.set(jobId, {
    state: { status: 'ready', audioUrl, replyText },
    createdAt: existing?.createdAt ?? Date.now(),
  })
}

export function setVoiceJobError(jobId: string, message: string): void {
  const existing = STORE.get(jobId)
  STORE.set(jobId, {
    state: { status: 'error', message },
    createdAt: existing?.createdAt ?? Date.now(),
  })
}

export function getVoiceJob(jobId: string): VoiceJobStatus | null {
  prune()
  return STORE.get(jobId)?.state ?? null
}

/**
 * Generate a unique job id for a given CallSid. We include the CallSid
 * so logs are greppable by call, and a short random suffix so multiple
 * turns in the same call don't collide.
 */
export function newJobId(callSid: string): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${callSid}-${suffix}`
}
