# Jordon Voice Worker

A persistent Node process that runs the voice pipeline for Jordon AI phone
calls. Subscribes to the self-hosted LiveKit server on Hetzner, gets
dispatched into a room whenever a SIP call lands, and runs Sarvam Saarika
(STT) → Sarvam-M (LLM) → Sarvam Bulbul v3 (TTS) end-to-end with streaming.

## Why this exists

The old path was Twilio webhook → Next.js `/api/webhooks/twilio-voice` →
serial LLM + TTS → `<Play>` hosted MP3. That had two problems:

1. **15-second ceiling** — Twilio aborts the webhook if the response
   isn't ready. Long LLM turns + long-form TTS regularly hit this.
2. **No barge-in** — caller had to wait for the whole reply to finish
   before they could interrupt.

LiveKit Agents owns the call session for as long as it takes, streams
audio in both directions, and handles barge-in for free via Silero VAD.

## Architecture

```
Caller → Twilio DID → <Dial><Sip> TwiML
                          ↓
                  LiveKit SIP ingress (5.78.82.31:5060)
                          ↓
                  LiveKit room
                          ↓
            this worker joins as agent
            ├─ Sarvam Saarika streaming STT
            ├─ Sarvam-M LLM (OpenAI-compatible)
            └─ Sarvam Bulbul v3 streaming TTS
                          ↓
            streamed audio back to caller
```

## Layout

```
src/
  index.ts              # CLI entrypoint + agent definition
  agent.ts              # AgentSession factory — wires STT+LLM+TTS
  supabase.ts           # Loads agent config from the main app's DB
  sarvam/
    stt.ts              # Sarvam Saarika adapter (streaming WS)
    llm.ts              # Sarvam-M adapter (OpenAI-compatible /v1)
    tts.ts              # Sarvam Bulbul v3 adapter (streaming HTTP)
Dockerfile              # Multi-stage Node 22 build
```

## Environment

Copy `.env.example` to `.env` and fill in:

- `LIVEKIT_URL` — WebSocket URL of the self-hosted server (dev:
  `ws://5.78.82.31:7880`; prod: `wss://livekit.jordon.ai` once DNS lands)
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — from `/data/livekit/livekit.yaml`
- `SARVAM_API_KEY` — the same key the Next.js app uses for TTS
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — to read the `agents` table

## Deploy

Coolify runs the worker as a standalone service on the Hetzner box:

1. New Application → Dockerfile → point at `voice-worker/`
2. Add env vars (copy from `.env.example`)
3. No HTTP exposure — the worker is outbound-only
4. Deploy; one worker instance can handle many concurrent calls, the
   pipeline is I/O bound not CPU-bound

## Local dev

```bash
npm install
cp .env.example .env   # fill in secrets
npm run dev            # tsx watches and restarts on edit
```

Without a live Twilio call you can test by spawning a LiveKit room via
the CLI and publishing test audio — run `livekit-cli room create` etc.
See `docs/local-testing.md` (TODO).

## Current status

Scaffold only — class shapes are in place; the Sarvam adapter wiring
(streaming WebSocket for Saarika, streaming HTTP for Bulbul v3, Sarvam-M
OpenAI-compatible chat) is the next commit. Once the adapters land, the
final step is switching the Twilio number's TwiML from the old webhook to
`<Dial><Sip>sip:+<ext>@5.78.82.31</Sip></Dial>`.
