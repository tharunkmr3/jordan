# Jordon AI — Key Decisions

## Auth & Users
- Multi-user per org with RBAC (owner, admin, agent, viewer)
- Supabase Auth (Google + Microsoft + Email/Password)
- Login page: Split layout — Indian art left, form right

## Channels
- WhatsApp: Business Cloud API (direct)
- Facebook: Meta Messenger Platform API
- Phone: Twilio + Sarvam (STT/TTS for Indian) + ElevenLabs (English option)
- Website: Simple `<script>` embed widget

## AI Models
- Sarvam 30B/105B: Default for Indian language conversations (FREE)
- OpenAI GPT-4o: English & complex queries
- Anthropic Claude: Alternative option
- Google Gemini: Alternative option
- Model selection: Admin chooses per org, later per agent

## Voice
- Sarvam Bulbul v3: Indian language TTS (telephony-grade 8kHz)
- Sarvam Saaras v3: Indian language STT (streaming)
- ElevenLabs: English voice option
- Admin chooses per org

## Indian Languages (via Sarvam)
- Sarvam Translate: 22 Indian languages
- Auto language detection
- Code-mixing support (Hinglish etc.)

## Inbox
- Real-time like Intercom
- Supabase Realtime for live updates
- Human takeover capability

## Payments
- Stripe: Subscriptions + usage-based billing
- Plans: Starter ₹15K, Growth ₹35K, Enterprise custom

## Deployment
- Local development first
- Hetzner (production)

## UI Stack
- shadcn/ui + Lucide icons
- Tremor charts
- Motion Primitives animations
- Prompt Kit for chat UI
- Satoshi font (from website)
