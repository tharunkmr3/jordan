// ============================================================================
// Jordon Voice Worker — LiveKit Agents entrypoint
// ============================================================================
//
// A persistent Node process that connects to the self-hosted LiveKit
// server, registers as an agent pool, and gets dispatched into rooms
// the moment a SIP call lands. Inside each room it runs the
// STT → LLM → TTS voice pipeline with Sarvam at every stage.
//
// Deployed separately from the Next.js app (Coolify treats it as its
// own service). No HTTP surface of its own — it only speaks the
// LiveKit agent protocol + whatever providers the pipeline uses.
//
// Start flow:
//   1. Worker boots, connects to LIVEKIT_URL using API key + secret
//   2. LiveKit dispatches the worker into a room when a call arrives
//   3. agentEntrypoint() loads the agent config (system prompt, voice,
//      language) from Supabase based on the room's metadata
//   4. AgentSession wires Sarvam STT + Sarvam-M LLM + Sarvam TTS and
//      takes over the room's audio stream
// ============================================================================

import {
  cli,
  defineAgent,
  type JobContext,
  WorkerOptions,
} from '@livekit/agents'
import { loadAgentConfig } from './supabase.js'
import { buildAgentSession } from './agent.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`)
  }
  return value
}

const agent = defineAgent({
  /**
   * Called once per room when LiveKit assigns this worker.
   * We resolve which Jordon agent row drives this call (via room
   * metadata set by the SIP dispatch rule), build the pipeline, and
   * hand the room's audio over to it.
   */
  entry: async (ctx: JobContext) => {
    console.log('[voice-worker] job accepted', {
      roomName: ctx.room.name,
      roomSid: ctx.room.sid,
      metadata: ctx.room.metadata,
    })

    // The dispatch rule / our SIP setup writes agentId into room
    // metadata as JSON `{ agentId: "..." }`. We fall back to a
    // placeholder so early manual tests don't need metadata wired.
    let agentId: string | null = null
    try {
      if (ctx.room.metadata) {
        const parsed = JSON.parse(ctx.room.metadata) as { agentId?: string }
        agentId = parsed.agentId ?? null
      }
    } catch { /* metadata not JSON — ignore */ }

    if (!agentId) {
      console.warn('[voice-worker] no agentId in room metadata, using demo defaults')
    }

    await ctx.connect()

    const config = agentId
      ? await loadAgentConfig(agentId)
      : {
          id: 'demo',
          name: 'Jordon',
          system_prompt: 'You are Jordon, a friendly voice assistant. Keep replies to one short sentence.',
          language: 'en',
          voice_id: 'priya',
          greeting_message: 'Hello, how can I help you today?',
        }

    const session = buildAgentSession(config)

    await session.start({
      agent: session.agent,
      room: ctx.room,
    })

    // Greet first so the caller doesn't hear silence on pickup.
    await session.say(config.greeting_message, { allowInterruptions: true })
  },
})

// `cli.runApp` reads LIVEKIT_URL / API_KEY / API_SECRET from env and
// runs the worker loop. Accepts `dev` / `start` subcommands — `dev`
// runs a single session in the foreground (we use it via tsx watch);
// `start` runs the full worker pool for production.
cli.runApp(
  new WorkerOptions({
    agent: import.meta.url,
    // Pre-warm: called once on worker boot. Cheap place to verify env
    // vars are present — failing here gives a fast, clear crash
    // instead of a confusing runtime error deep in the agent path.
    prewarm: async () => {
      requireEnv('LIVEKIT_URL')
      requireEnv('LIVEKIT_API_KEY')
      requireEnv('LIVEKIT_API_SECRET')
      requireEnv('SARVAM_API_KEY')
      requireEnv('SUPABASE_URL')
      requireEnv('SUPABASE_SERVICE_ROLE_KEY')
      console.log('[voice-worker] prewarm ok — all env present')
    },
  }),
)

export default agent
