// ============================================================================
// Jordon AI — Structured Reply Output
//
// Canonical reply format on the website channel. Instead of asking the LLM
// to emit Markdown "in the right shape" (which breaks under long prompts
// + fat tool results — see the flat-paragraphs failure mode), we enforce
// a JSON schema at the provider API. The model returns a Block[] array;
// the UI renders each block type deterministically; format drift becomes
// architecturally impossible.
//
// This is the same pattern Perplexity, Linear AI, and Notion AI use for
// their structured answer surfaces. It replaces the post-hoc `normalize-
// markdown.ts` rescue logic entirely.
//
// Channel scoping: applied ONLY on the `website` channel (chat widget +
// test chat + internal agents). Voice and messenger surfaces keep plain
// prose — a TTS engine reading block markup is nonsense, and WhatsApp
// can't render a widget card.
// ============================================================================

// ---------------------------------------------------------------------------
// Block types — the discriminated union the UI knows how to render.
// Adding a new block means: (a) add the union member here, (b) extend the
// JSON schema below, (c) extend the renderer in structured-reply.tsx.
// ---------------------------------------------------------------------------

export type Block =
  // Structural content
  | HeadingBlock
  | ParagraphBlock
  | BulletsBlock
  | OrderedBlock
  | CodeBlock
  | QuoteBlock
  | TableBlock
  // Generative-UI widgets (preserved from the pre-structured pipeline)
  | FormBlock
  | ConfirmBlock
  | ChoiceBlock
  | CardBlock

export interface HeadingBlock {
  type: 'heading'
  /** H1 = top-of-reply title (use at most once); H2 = section; H3 = sub-section. */
  level: 1 | 2 | 3
  /** Inline Markdown (bold, italic, links, inline code) is allowed inside. */
  text: string
}

export interface ParagraphBlock {
  type: 'paragraph'
  text: string
}

export interface BulletsBlock {
  type: 'bullets'
  items: string[]
}

export interface OrderedBlock {
  type: 'ordered'
  items: string[]
}

export interface CodeBlock {
  type: 'code'
  /** Language hint for syntax highlighting. Use empty string when unknown. */
  language: string
  content: string
}

export interface QuoteBlock {
  type: 'quote'
  text: string
}

export interface TableBlock {
  type: 'table'
  columns: string[]
  /** Row-major: rows[r][c] corresponds to columns[c]. */
  rows: string[][]
  /** Optional caption above the table. */
  title?: string
}

// Interactive widgets — the UI renders these with AiWidgetProvider.
// Same shapes the model used to emit inside a fenced `ui` code block;
// hoisted to first-class block types so they live in the typed contract.

export interface FormField {
  name: string
  label: string
  type: 'text' | 'email' | 'url' | 'number' | 'textarea' | 'select' | 'boolean'
  required: boolean
  options?: Array<{ value: string; label: string }>
}

export interface FormBlock {
  type: 'form'
  title: string
  fields: FormField[]
  submit: { label: string; action?: string }
}

export interface ConfirmBlock {
  type: 'confirm'
  message: string
  confirm: { label: string; variant?: 'default' | 'destructive' }
  cancel: { label: string }
}

export interface ChoiceBlock {
  type: 'choice'
  title: string
  options: Array<{ value: string; label: string; description?: string }>
}

export interface CardBlock {
  type: 'card'
  title: string
  subtitle?: string
  fields: Array<{ label: string; value: string }>
  action?: { label: string; value: string; variant?: 'default' | 'secondary' | 'destructive' }
}

export interface StructuredReply {
  blocks: Block[]
}

// ---------------------------------------------------------------------------
// JSON Schema — consumed by every provider's structured-output facility.
// OpenAI requires `strict: true` mode: every property in `required`,
// `additionalProperties: false`, and no true optionals (use nullable via
// `anyOf` with `null`). Anthropic and Gemini are more lenient but accept
// the same shape, so one schema fits all providers.
// ---------------------------------------------------------------------------

/**
 * Helper: wrap a schema so it can be null. OpenAI strict mode has no real
 * `optional` — every field lives in `required`, and absence is expressed
 * as `{ type: "null" } | <schema>`.
 */
function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [schema, { type: 'null' }] }
}

const ENUM_BLOCK_TYPES = [
  'heading', 'paragraph', 'bullets', 'ordered', 'code', 'quote', 'table',
  'form', 'confirm', 'choice', 'card',
] as const

/**
 * Build the JSON schema for a single Block member. Each member carries
 * a const `type` discriminant so parsers pick the right shape.
 */
function blockMember(
  typeValue: typeof ENUM_BLOCK_TYPES[number],
  extraProperties: Record<string, Record<string, unknown>>,
  extraRequired: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', const: typeValue },
      ...extraProperties,
    },
    required: ['type', ...extraRequired],
    additionalProperties: false,
  }
}

export const STRUCTURED_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        anyOf: [
          // Heading
          blockMember('heading', {
            level: { type: 'integer', enum: [1, 2, 3] },
            text: { type: 'string' },
          }, ['level', 'text']),
          // Paragraph
          blockMember('paragraph', {
            text: { type: 'string' },
          }, ['text']),
          // Bullets
          blockMember('bullets', {
            items: { type: 'array', items: { type: 'string' } },
          }, ['items']),
          // Ordered list
          blockMember('ordered', {
            items: { type: 'array', items: { type: 'string' } },
          }, ['items']),
          // Code
          blockMember('code', {
            language: { type: 'string' },
            content: { type: 'string' },
          }, ['language', 'content']),
          // Quote
          blockMember('quote', {
            text: { type: 'string' },
          }, ['text']),
          // Table
          blockMember('table', {
            columns: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            title: nullable({ type: 'string' }),
          }, ['columns', 'rows', 'title']),
          // Form widget
          blockMember('form', {
            title: { type: 'string' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  label: { type: 'string' },
                  type: { type: 'string', enum: ['text', 'email', 'url', 'number', 'textarea', 'select', 'boolean'] },
                  required: { type: 'boolean' },
                  options: nullable({
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        value: { type: 'string' },
                        label: { type: 'string' },
                      },
                      required: ['value', 'label'],
                      additionalProperties: false,
                    },
                  }),
                },
                required: ['name', 'label', 'type', 'required', 'options'],
                additionalProperties: false,
              },
            },
            submit: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                action: nullable({ type: 'string' }),
              },
              required: ['label', 'action'],
              additionalProperties: false,
            },
          }, ['title', 'fields', 'submit']),
          // Confirm widget
          blockMember('confirm', {
            message: { type: 'string' },
            confirm: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                variant: nullable({ type: 'string', enum: ['default', 'destructive'] }),
              },
              required: ['label', 'variant'],
              additionalProperties: false,
            },
            cancel: {
              type: 'object',
              properties: {
                label: { type: 'string' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          }, ['message', 'confirm', 'cancel']),
          // Choice widget
          blockMember('choice', {
            title: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                  label: { type: 'string' },
                  description: nullable({ type: 'string' }),
                },
                required: ['value', 'label', 'description'],
                additionalProperties: false,
              },
            },
          }, ['title', 'options']),
          // Card widget
          blockMember('card', {
            title: { type: 'string' },
            subtitle: nullable({ type: 'string' }),
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label', 'value'],
                additionalProperties: false,
              },
            },
            action: nullable({
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                variant: nullable({ type: 'string', enum: ['default', 'secondary', 'destructive'] }),
              },
              required: ['label', 'value', 'variant'],
              additionalProperties: false,
            }),
          }, ['title', 'subtitle', 'fields', 'action']),
        ],
      },
    },
  },
  required: ['blocks'],
  additionalProperties: false,
} as const

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string returned by any provider's structured-output path
 * into a validated StructuredReply, or null if the string isn't a valid
 * reply. The pipeline uses null as a signal to fall back to plain text.
 *
 * Validation is deliberately permissive — the provider's strict mode is
 * the primary guarantee; this is a belt-and-suspenders runtime check
 * that catches the edge case where strict mode wasn't actually enforced
 * (e.g. Sarvam's OpenAI-compatible endpoint that doesn't honor
 * response_format).
 */
export function parseStructuredReply(text: string): StructuredReply | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Sometimes providers wrap the JSON in a fenced code block despite being
    // told not to. Peel off ``` ...``` and retry once.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (!fenced) return null
    try { parsed = JSON.parse(fenced[1]) } catch { return null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const root = parsed as { blocks?: unknown }
  if (!Array.isArray(root.blocks)) return null
  const validBlocks: Block[] = []
  for (const raw of root.blocks) {
    const block = coerceBlock(raw)
    if (block) validBlocks.push(block)
  }
  if (validBlocks.length === 0) return null
  return { blocks: validBlocks }
}

/**
 * Runtime coercion of a single block. Returns null when the block doesn't
 * match any known shape — we drop unknown blocks rather than fail the whole
 * reply, so a partially-valid response still renders.
 */
function coerceBlock(raw: unknown): Block | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const type = typeof r.type === 'string' ? r.type : ''
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  const strArr = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every(x => typeof x === 'string') ? v as string[] : null

  switch (type) {
    case 'heading': {
      const level = r.level === 1 || r.level === 2 || r.level === 3 ? r.level : null
      const text = str(r.text)
      if (level == null || text == null) return null
      return { type: 'heading', level, text }
    }
    case 'paragraph': {
      const text = str(r.text)
      if (text == null) return null
      return { type: 'paragraph', text }
    }
    case 'bullets': {
      const items = strArr(r.items)
      if (!items) return null
      return { type: 'bullets', items }
    }
    case 'ordered': {
      const items = strArr(r.items)
      if (!items) return null
      return { type: 'ordered', items }
    }
    case 'code': {
      const content = str(r.content)
      if (content == null) return null
      return { type: 'code', language: str(r.language) ?? '', content }
    }
    case 'quote': {
      const text = str(r.text)
      if (text == null) return null
      return { type: 'quote', text }
    }
    case 'table': {
      const columns = strArr(r.columns)
      if (!columns) return null
      const rows = Array.isArray(r.rows)
        ? (r.rows as unknown[]).map(row => strArr(row) ?? []).filter(row => row.length > 0)
        : []
      return { type: 'table', columns, rows, title: str(r.title) ?? undefined }
    }
    // Widgets are passed through with minimal validation — the widget
    // renderer has its own defensive coercion that handles shape drift.
    case 'form':
    case 'confirm':
    case 'choice':
    case 'card':
      return r as unknown as Block
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// blocksToMarkdown — fallback / history export
//
// Serialize a StructuredReply back to canonical Markdown. Used for:
//  - Non-website channels that receive a prose copy (whatsapp / phone)
//  - Message.content column — stays human-readable even if metadata is
//    missing (old client, raw SQL peek, email export, etc.)
//  - History replay if the model needs the previous assistant turn in
//    a string-shape context
// ---------------------------------------------------------------------------

export function blocksToMarkdown(blocks: Block[]): string {
  const parts: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        parts.push(`${'#'.repeat(b.level)} ${b.text}`)
        break
      case 'paragraph':
        parts.push(b.text)
        break
      case 'bullets':
        parts.push(b.items.map(i => `- ${i}`).join('\n'))
        break
      case 'ordered':
        parts.push(b.items.map((i, idx) => `${idx + 1}. ${i}`).join('\n'))
        break
      case 'code':
        parts.push(`\`\`\`${b.language}\n${b.content}\n\`\`\``)
        break
      case 'quote':
        parts.push(b.text.split('\n').map(l => `> ${l}`).join('\n'))
        break
      case 'table': {
        if (b.title) parts.push(`**${b.title}**`)
        const header = `| ${b.columns.join(' | ')} |`
        const sep = `| ${b.columns.map(() => '---').join(' | ')} |`
        const rows = b.rows.map(r => `| ${r.join(' | ')} |`)
        parts.push([header, sep, ...rows].join('\n'))
        break
      }
      case 'form':
      case 'confirm':
      case 'choice':
      case 'card':
        // Widgets fall back to a fenced `ui` code block so channels
        // that only render Markdown (whatsapp will be told not to, but
        // if it slips through) still show them as structured JSON.
        parts.push(`\`\`\`ui\n${JSON.stringify(b, null, 2)}\n\`\`\``)
        break
    }
  }
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Prompt fragment
//
// Short, imperative rider appended to the website-channel system prompt
// to tell the model what shape of reply to emit. The provider's strict
// JSON schema is the real enforcement — this just gives the model
// semantic hints ("use heading level 1 once, prefer bullets over inline
// commas" etc).
// ---------------------------------------------------------------------------

export const STRUCTURED_REPLY_PROMPT_RIDER = `
Your reply MUST be a structured JSON object matching the schema below.
The user's UI renders each block deterministically — do not emit Markdown,
do not wrap in code fences, do not add extra prose outside the schema.

Content block selection:
- Use exactly one "heading" with level 1 at the top of substantive replies.
  Short greetings and one-sentence answers skip the heading.
- Break content into "heading" (level 2) sections when covering multiple
  topics.
- Prefer "bullets" over comma-joined lists in "paragraph" text.
- Use "ordered" only when steps have a meaningful sequence.
- Use "table" when comparing items across the same attributes.
- Use "code" for code snippets, with the language name in the language field
  (use "" when the language isn't known).

Interaction blocks — pick the lightest touch:

1. Prefer calling an available TOOL over asking the user anything. If a
   tool can take a best-guess action (e.g. a "quick add" calendar tool
   that accepts natural-language event strings), use it — a short
   confirmation afterwards beats a 6-field form.

2. If you need ONE piece of info or a decision, use "choice" with 2–5
   clickable options. This is the right block for "pick a time",
   "which file do you mean", "what should I name this". Each option's
   "label" should be short (1–5 words); put longer context in
   "description". Include an "Other / specify" option only when a
   free-text answer is genuinely expected.

3. Use "confirm" only for a clear yes/no on something irreversible
   (delete, send, pay). Don't use confirm as a generic "ok/cancel" —
   that's what a choice block is for.

4. Use "card" to display structured information the user is expected
   to act on (a summary + one button). Not for input.

5. Use "form" ONLY when you genuinely need 3+ fields filled in at once
   AND no tool can do it for you. Forms are the highest-friction
   widget. If the user has only given a vague request ("create an
   event", "book a meeting"), DON'T bury them in blank input fields —
   ask ONE thing first via a choice widget or a single prose question,
   and collect the rest iteratively.

Negative example: user asks "create an event". BAD = a form with
Title / Date / Start / End / Location / Description all blank. GOOD =
a short paragraph "What's the event?" + a choice widget with quick
pickers like "Tomorrow 10am", "Today 3pm", "Next Monday", "Other".
`
