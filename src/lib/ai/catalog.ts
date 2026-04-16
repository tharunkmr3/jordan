/**
 * Single source of truth for which AI models the UI offers, and how
 * their name maps to a pipeline provider. Keeps the agent settings
 * Select and the internal-chat model picker in sync — any model we
 * add here shows up in both places.
 *
 * For provider mapping, see src/lib/ai/models.ts — the `provider`
 * field here must match one of the cases in generateResponse().
 */

export interface ModelCatalogEntry {
  /** Stored in agents.model_name and passed to the SDK as model id. */
  name: string
  /** Display label in the UI. */
  label: string
  /** Shorter label for tight spaces like the composer picker. */
  short?: string
  /** Pipeline provider — must match models.ts switch cases. */
  provider: 'openai' | 'anthropic' | 'sarvam' | 'gemini'
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  { name: 'sarvam-m',          label: 'Sarvam 30B (Free)',    short: 'Sarvam 30B',  provider: 'sarvam' },
  { name: 'gpt-5.4',           label: 'OpenAI GPT-5.4',       short: 'GPT-5.4',     provider: 'openai' },
  { name: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6',    short: 'Sonnet 4.6',  provider: 'anthropic' },
  { name: 'claude-opus-4-7',   label: 'Claude Opus 4.7',      short: 'Opus 4.7',    provider: 'anthropic' },
  { name: 'gemini-pro',        label: 'Gemini Pro',           short: 'Gemini Pro',  provider: 'gemini' },
]

export function providerForModelName(name: string): ModelCatalogEntry['provider'] | null {
  return MODEL_CATALOG.find(m => m.name === name)?.provider ?? null
}

export function catalogEntry(name: string): ModelCatalogEntry | null {
  return MODEL_CATALOG.find(m => m.name === name) ?? null
}
