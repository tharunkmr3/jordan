// ============================================================================
// Jordon Voice Worker — LiveKit Agents entrypoint
// ============================================================================
//
// Persistent Node process that registers with the self-hosted LiveKit
// server. When a SIP call lands, LiveKit spawns a job in this worker;
// the entry function builds the Sarvam-backed voice pipeline and runs
// it for the lifetime of the call.
//
// Deployed as a standalone service (Coolify — no HTTP surface, only
// outbound WebSocket to LiveKit + Sarvam + Supabase). Starts with
// `node dist/index.js start`; dev is `tsx watch src/index.ts dev`.
// ============================================================================

import { fileURLToPath } from 'node:url'
import {
  cli,
  defineAgent,
  type JobContext,
  WorkerOptions,
  voice,
} from '@livekit/agents'
import { buildVoicePipeline } from './agent.js'
import { loadAgentConfig, type AgentConfig } from './supabase.js'

// Demo fallback used when the room arrives without metadata (dev testing
// via the LiveKit CLI where we aren't going through the SIP dispatch
// rule). Prod SIP calls always have agentId in the room metadata.
const DEMO_CONFIG: AgentConfig = {
  id: 'demo',
  name: 'Jordon',
  system_prompt: 'You are Jordon, a friendly voice assistant. Reply in one short sentence.',
  language: 'en',
  voice_id: 'priya',
  greeting_message: 'Hello, how can I help you today?',
  fallback_message: null,
  max_tokens: 220,
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    console.log('[voice-worker] job accepted', {
      roomName: ctx.room.name,
      metadata: ctx.room.metadata,
    })

    // LiveKit's SIP dispatch rule writes `{"agentId":"<uuid>"}` into the
    // room metadata so we know which Jordon agent row to load. Falls
    // back to demo config if absent (dev + first-call smoke test).
    let agentId: string | null = null
    try {
      if (ctx.room.metadata) {
        const parsed = JSON.parse(ctx.room.metadata) as { agentId?: string }
        agentId = parsed.agentId ?? null
      }
    } catch { /* metadata not JSON — ignore */ }

    const config: AgentConfig = agentId
      ? await loadAgentConfig(agentId)
      : DEMO_CONFIG

    await ctx.connect()

    const pipeline = await buildVoicePipeline(config)

    const session = new voice.AgentSession({
      stt: pipeline.stt,
      llm: pipeline.llm,
      tts: pipeline.tts,
      vad: pipeline.vad,
    })
    // Prime the chat history with a dummy user turn so the first LLM call
    // never starts with an assistant message. Sarvam's API (like strict
    // OpenAI-compatible endpoints) rejects requests where the first
    // non-system message is from the assistant — which happens when
    // session.say() adds the greeting before any user turn exists.
    session.history.addMessage({ role: "user", content: "__start__" })

    // The agent object wraps the system prompt + pipeline. AgentSession
    // runs it against the room's audio — one-shot, ends when caller
    // hangs up or the SIP trunk closes the session.
    const agent = new voice.Agent({
      instructions: pipeline.instructions,
    })

    await session.start({ agent, room: ctx.room })

    // Greet first so the caller doesn't hear silence on pickup.
    // allowInterruptions=true lets the caller barge in mid-greeting.
    session.say(pipeline.greeting, { allowInterruptions: true })
  },

  // Runs once per worker process on boot. Cheap place to fail fast when
  // env is misconfigured.
  prewarm: async () => {
    requireEnv('LIVEKIT_URL')
    requireEnv('LIVEKIT_API_KEY')
    requireEnv('LIVEKIT_API_SECRET')
    requireEnv('SARVAM_API_KEY')
    requireEnv('SUPABASE_URL')
    requireEnv('SUPABASE_SERVICE_ROLE_KEY')
    console.log('[voice-worker] prewarm ok')
  },
})

// Runs when this file is executed directly (`node dist/index.js start`).
// The CLI reads LIVEKIT_URL / API_KEY / API_SECRET from env, registers
// this module as the agent, and starts accepting jobs.
cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    // Named dispatch — our LiveKit Cloud SIP dispatch rule references
    // this exact name. Without it, the worker joins any available
    // room, not just the ones explicitly dispatched to it, which
    // would conflict if we ever run multiple agent types on the
    // same LiveKit project.
    agentName: 'jordon-voice-worker',
  }),
)
