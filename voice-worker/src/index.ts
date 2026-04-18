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
  llm,
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

/**
 * Strip <think>...</think> reasoning blocks from a text stream before TTS.
 *
 * sarvam-m is a chain-of-thought model (like DeepSeek-R1) that emits its
 * internal reasoning inside <think>...</think> tags before the actual reply.
 * Without stripping, the TTS speaks every word of the reasoning verbatim,
 * which the caller hears as long nonsensical text before (or instead of) the
 * real answer.
 *
 * Handles the case where <think> or </think> is split across chunk boundaries
 * by keeping a small look-behind buffer (7 chars for '<think>', 8 for
 * '</think>').
 */
function stripThinkBlocks(upstream: ReadableStream<string>): ReadableStream<string> {
  let buf = ''
  let inside = false

  return new ReadableStream<string>({
    async start(controller) {
      const reader = upstream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            // Flush any leftover text that's outside a think block
            if (!inside && buf) controller.enqueue(buf)
            controller.close()
            return
          }
          buf += value
          let out = ''

          // Drain as much of buf as we can safely classify
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (inside) {
              const end = buf.indexOf('</think>')
              if (end === -1) {
                // Close tag not yet arrived — hold last 8 chars so '</think>'
                // split across chunks doesn't slip through as output
                buf = buf.slice(Math.max(0, buf.length - 8))
                break
              }
              buf = buf.slice(end + 8) // consume up to and including </think>
              inside = false
            } else {
              const start = buf.indexOf('<think>')
              if (start === -1) {
                // No open tag in sight — emit all but last 7 chars so a
                // '<think>' split across chunks isn't emitted prematurely
                const safe = buf.length - 7
                if (safe > 0) {
                  out += buf.slice(0, safe)
                  buf = buf.slice(safe)
                }
                break
              }
              out += buf.slice(0, start) // emit text before the think block
              buf = buf.slice(start + 7) // consume <think>
              inside = true
            }
          }

          if (out) controller.enqueue(out)
        }
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
      }
    },
  })
}

/**
 * voice.Agent subclass that intercepts ttsNode to strip <think> blocks.
 * All other behaviour (sttNode, llmNode, etc.) is inherited unchanged.
 */
class JordonAgent extends voice.Agent {
  override async ttsNode(
    text: ReadableStream<string>,
    modelSettings: Parameters<voice.Agent['ttsNode']>[1],
  ) {
    return super.ttsNode(stripThinkBlocks(text), modelSettings)
  }
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

    // Prime agent._chatCtx with a dummy user turn before the session starts.
    // Sarvam's API (and strict OpenAI-compatible endpoints) rejects LLM
    // requests where the first non-system message is from the assistant.
    // This happens because session.say() adds the greeting as an assistant
    // turn before any user message exists. The fix must go on voice.Agent
    // (not AgentSession) — agent._chatCtx is what agent_activity actually
    // passes to the LLM; session._chatCtx is a separate, unused object.
    const seedCtx = new llm.ChatContext()
    seedCtx.addMessage({ role: 'user', content: '__start__' })

    // JordonAgent extends voice.Agent to strip <think>...</think> blocks
    // from LLM output before TTS receives it. sarvam-m is a CoT reasoner
    // and emits its thinking verbatim — without stripping the caller hears
    // hundreds of words of internal monologue before the actual reply.
    const agent = new JordonAgent({
      instructions: pipeline.instructions,
      chatCtx: seedCtx,
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
