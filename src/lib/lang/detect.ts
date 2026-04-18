// ============================================================================
// Language detection via Unicode-script heuristic.
//
// Sarvam's TTS API requires `target_language_code` — there is no server-side
// auto-detection. For multilingual Indian customer-support agents where the
// reply text can swing between English and any of 10 Indian languages, we
// infer the language from the script of the highest-weight codepoint range
// in the text.
//
// Heuristic: walk the text, count codepoints per script range, return the
// language whose script dominates. Ties / zero-Indian-script content fall
// back to English. Works reliably for single-script runs; for code-mixed
// Hinglish (Latin-script Hindi) we favour the agent's configured language
// as an override at the call site.
// ============================================================================

import type { SarvamLanguageCode } from '@/lib/tts/sarvam'

const SARVAM_API_KEY = process.env.SARVAM_API_KEY

/**
 * Full set of Sarvam-supported BCP-47 codes, used to validate API responses
 * before we trust them — a stray/unknown code falls through to the local
 * detector instead of being passed into the TTS call and failing there.
 */
const SARVAM_LANGS: ReadonlySet<SarvamLanguageCode> = new Set([
  'en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'kn-IN',
  'ml-IN', 'mr-IN', 'bn-IN', 'gu-IN', 'pa-IN', 'od-IN',
])

/**
 * Small in-memory LRU for repeated detections inside a single server
 * process. Stock greeting + error strings repeat per call, and we'd
 * otherwise burn API credits + add latency re-detecting "I'm listening."
 * every turn. 128 entries is plenty for a handful of agents under load.
 */
const LID_CACHE_MAX = 128
const lidCache = new Map<string, SarvamLanguageCode>()
function lidCacheGet(key: string): SarvamLanguageCode | undefined {
  const hit = lidCache.get(key)
  if (hit !== undefined) {
    lidCache.delete(key); lidCache.set(key, hit) // LRU bump
  }
  return hit
}
function lidCacheSet(key: string, value: SarvamLanguageCode) {
  if (lidCache.size >= LID_CACHE_MAX) {
    const oldest = lidCache.keys().next().value
    if (oldest !== undefined) lidCache.delete(oldest)
  }
  lidCache.set(key, value)
}

interface ScriptRange {
  lang: SarvamLanguageCode
  start: number
  end: number
}

/**
 * Each Indian script sits in a dedicated Unicode block. Odia and Punjabi
 * (Gurmukhi) have their own blocks; Hindi/Marathi share Devanagari — we
 * default shared scripts to Hindi because it's the most common caller
 * language and the agent's configured language can override at the call
 * site.
 */
const RANGES: ScriptRange[] = [
  { lang: 'hi-IN', start: 0x0900, end: 0x097F }, // Devanagari (Hindi / Marathi)
  { lang: 'bn-IN', start: 0x0980, end: 0x09FF }, // Bengali
  { lang: 'pa-IN', start: 0x0A00, end: 0x0A7F }, // Gurmukhi (Punjabi)
  { lang: 'gu-IN', start: 0x0A80, end: 0x0AFF }, // Gujarati
  { lang: 'od-IN', start: 0x0B00, end: 0x0B7F }, // Odia
  { lang: 'ta-IN', start: 0x0B80, end: 0x0BFF }, // Tamil
  { lang: 'te-IN', start: 0x0C00, end: 0x0C7F }, // Telugu
  { lang: 'kn-IN', start: 0x0C80, end: 0x0CFF }, // Kannada
  { lang: 'ml-IN', start: 0x0D00, end: 0x0D7F }, // Malayalam
]

/**
 * Map an agent's configured primary language (ISO-639-1 like "hi", "ta")
 * to Sarvam's BCP-47 codes. Used as the fallback when the text itself is
 * pure Latin script (common for Hinglish / English replies).
 */
export function agentLanguageToSarvam(lang: string | null | undefined): SarvamLanguageCode {
  const m: Record<string, SarvamLanguageCode> = {
    en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN',
    bn: 'bn-IN', mr: 'hi-IN', gu: 'gu-IN', ml: 'ml-IN', pa: 'pa-IN', od: 'od-IN',
  }
  return m[(lang || 'en').toLowerCase()] ?? 'en-IN'
}

/**
 * Detect the dominant language from script analysis. Falls back to the
 * provided `fallback` code when no Indian script character is found —
 * this lets the caller pin the agent's primary language for Latin-script
 * replies (English or Hinglish).
 */
export function detectSarvamLanguage(
  text: string,
  fallback: SarvamLanguageCode = 'en-IN',
): SarvamLanguageCode {
  if (!text) return fallback

  const counts: Partial<Record<SarvamLanguageCode, number>> = {}
  let indicTotal = 0
  let letterTotal = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // Ignore whitespace + common punctuation from the denominator so the
    // ratio reflects actual letters, not formatting noise.
    if (code > 0x20 && !(code >= 0x21 && code <= 0x2F) && !(code >= 0x3A && code <= 0x40)) {
      letterTotal++
    }
    for (const r of RANGES) {
      if (code >= r.start && code <= r.end) {
        counts[r.lang] = (counts[r.lang] ?? 0) + 1
        indicTotal++
        break
      }
    }
  }

  let best: SarvamLanguageCode | null = null
  let bestCount = 0
  for (const [lang, n] of Object.entries(counts) as Array<[SarvamLanguageCode, number]>) {
    if (n > bestCount) { best = lang; bestCount = n }
  }

  // Only trust the script detection when Indic chars dominate. A handful
  // of Devanagari letters for a transliterated name inside an otherwise
  // English reply shouldn't flip the voice — the agent's configured
  // language (via `fallback`) stays in charge.
  const ratio = letterTotal > 0 ? indicTotal / letterTotal : 0
  return bestCount >= 3 && ratio >= 0.3 ? (best as SarvamLanguageCode) : fallback
}

/**
 * Remote language identification via Sarvam's /text-lid endpoint.
 * Handles code-mixed content the local script detector can't touch — e.g.
 * Latin-script Hinglish ("aap kaise hain") is classified as hi-IN because
 * Sarvam's model is trained on Romanised Indic text.
 *
 * Returns null on any failure (network error, quota, unexpected code)
 * so the caller can cleanly fall back to local detection. Never throws.
 * Short-circuits to null when the API key isn't configured.
 */
export async function detectLanguageRemote(text: string): Promise<SarvamLanguageCode | null> {
  if (!SARVAM_API_KEY || !text || text.trim().length === 0) return null

  // Cache key is the raw input — Sarvam's output is deterministic enough
  // that we can memoise without normalising.
  const cached = lidCacheGet(text)
  if (cached) return cached

  try {
    // /text-lid caps input at 1000 chars; truncate defensively so a long
    // agent response doesn't 4xx the whole detection call.
    const body = JSON.stringify({ input: text.slice(0, 1000) })
    const res = await fetch('https://api.sarvam.ai/text-lid', {
      method: 'POST',
      headers: {
        'api-subscription-key': SARVAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { language_code?: string }
    const code = json.language_code
    if (code && SARVAM_LANGS.has(code as SarvamLanguageCode)) {
      const lang = code as SarvamLanguageCode
      lidCacheSet(text, lang)
      return lang
    }
    return null
  } catch (err) {
    console.error('[lang/detect] /text-lid failed:', err)
    return null
  }
}

/**
 * Preferred detection path for server-side callers — tries Sarvam's
 * /text-lid first (handles Hinglish, Romanised Indic, code-mixed replies),
 * falls back to the local Unicode-script detector on network / quota /
 * unknown-code failure. The local fallback itself falls back to the
 * agent's configured language for Latin-script content.
 */
export async function detectSarvamLanguageAsync(
  text: string,
  fallback: SarvamLanguageCode = 'en-IN',
): Promise<SarvamLanguageCode> {
  const remote = await detectLanguageRemote(text)
  if (remote) return remote
  return detectSarvamLanguage(text, fallback)
}
