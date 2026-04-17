/**
 * normalizeModelMarkdown — fix the patterns models fall back to even after
 * being told not to, WITHOUT rewriting intentional markdown.
 *
 * The LLMs we support (Claude, GPT, Sarvam, Gemini) keep emitting:
 *   "**Label:** description text"          ← pseudo-heading as inline bold
 *   bare-text section titles               ← newline instead of ## heading
 *   consecutive plain lines under a heading ← instead of - bullets
 *   ---                                    ← unwanted dividers
 *   spray of inline **bold** on every noun phrase
 *
 * This module normalizes the first two and strips the third. It's
 * deliberately conservative: any real markdown (fenced code, real bullet
 * lists, tables, real headings) passes through untouched.
 *
 * Applied server-side BEFORE the message is saved/returned, so both the
 * initial render and any history replay see the clean version.
 */

export function normalizeModelMarkdown(text: string): string {
  if (!text) return text

  // Split into "code-block-preserving" chunks. We never touch content
  // inside fenced code blocks (``` ... ```), and we never touch content
  // inside the `<think>...</think>` trace either since that's reasoning
  // presented verbatim to the user.
  const out: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    // Preserve ``` code fences verbatim.
    if (text.startsWith('```', i)) {
      const close = text.indexOf('```', i + 3)
      const end = close === -1 ? n : close + 3
      out.push(text.slice(i, end))
      i = end
      continue
    }
    // Preserve <think>...</think> verbatim.
    if (text.startsWith('<think>', i)) {
      const close = text.indexOf('</think>', i + 7)
      const end = close === -1 ? n : close + 8
      out.push(text.slice(i, end))
      i = end
      continue
    }
    // Accumulate normal text up to the next fence/think tag.
    let next = n
    const nextFence = text.indexOf('```', i)
    const nextThink = text.indexOf('<think>', i)
    for (const candidate of [nextFence, nextThink]) {
      if (candidate !== -1 && candidate < next) next = candidate
    }
    out.push(applyTextTransforms(text.slice(i, next)))
    i = next
  }
  return out.join('')
}

function applyTextTransforms(text: string): string {
  let s = text

  // 1) Remove stray --- horizontal rules. The prompt says no, but models
  //    sprinkle them anyway to imply section breaks. Headings do this job.
  //    Only strip when --- is on its own line (not part of code, not a
  //    table alignment row — those only appear inside tables which are
  //    already guarded by the code-fence preservation logic above for
  //    fenced versions, and for plain tables "---" is always between `|`
  //    chars, never alone on a line).
  s = s.replace(/^\s*---+\s*$/gm, '')

  // 2) Convert `**Label:** rest-of-line` into `## Label\n\nrest-of-line`.
  //    Only fires when:
  //      - The line STARTS with **
  //      - Between the ** and :** there are 1–60 chars (real label length)
  //      - After the closing **, there's a space and actual description
  //    That's the exact "inline pseudo-heading" pattern the models use for
  //    section items; real bulleted labels don't start the line with ** so
  //    they're untouched.
  s = s.replace(
    /^[ \t]*\*\*([^*\n][^*\n]{0,80}?):\*\*[ \t]+(.+)$/gm,
    (_m, label: string, rest: string) => `## ${label.trim()}\n\n${rest.trim()}`,
  )

  // 3) Convert `**Label:** ` ALONE on a line (no description following) into
  //    `## Label`. Rare but happens when models use the pattern as a heading.
  s = s.replace(
    /^[ \t]*\*\*([^*\n][^*\n]{0,80}?):\*\*[ \t]*$/gm,
    (_m, label: string) => `## ${label.trim()}`,
  )

  // 4) Rescue flat-text sections that should have been ## heading + bullets.
  //    When the system prompt's format rules lose attention weight (long
  //    tool results in context, deep agent loops), models fall back to
  //    emitting a "short line" followed by a run of bullet-shaped lines,
  //    each on its own paragraph, with no markdown prefix at all:
  //
  //      Latest market moves
  //      The S&P 500 rose 1.18% to 6,967.38
  //      The Nasdaq Composite jumped 1.96% to 23,639.08
  //      Recent CNBC coverage shows major U.S. indexes pushing higher
  //
  //    Renders as a wall of visually indistinguishable paragraphs. This
  //    pass detects that shape and reformats it in place.
  s = rescueFlatStructure(s)

  // 5) Collapse 3+ consecutive blank lines that result from prior splits,
  //    down to the standard double-newline.
  s = s.replace(/\n{3,}/g, '\n\n')

  return s
}

// ---------------------------------------------------------------------------
// Flat-section rescue
// ---------------------------------------------------------------------------

/**
 * Models under heavy context load (long system prompt + bulky tool results)
 * sometimes abandon Markdown structure entirely and emit one paragraph per
 * line separated by blank lines:
 *
 *   Latest market moves
 *
 *   The S&P 500 rose 1.18% to 6,967.38
 *
 *   The Nasdaq Composite jumped 1.96% to 23,639.08
 *
 *   Recent CNBC coverage shows major U.S. indexes pushing higher
 *
 * Renders as a wall of visually identical paragraphs — no hierarchy, no
 * bullets. This pass scans for that shape (a short heading-like paragraph
 * followed by 2+ bullet-shaped paragraphs) and rewrites it into proper
 * `## heading` + `- bullet` form.
 *
 * ALSO handles the less-common variant where the heading + its items all
 * live inside a single block separated by single newlines (no blank line
 * between lines).
 *
 * Rules — conservative on purpose so genuine prose isn't mangled:
 *   - Heading paragraph: single line, 2–8 words, ≤ 60 chars, starts with
 *     a letter, no terminating `. ! ? :`, no existing Markdown prefix.
 *   - Bullet paragraph: single line, 5–240 chars, starts with capital/
 *     digit/quote, contains a space, no existing Markdown prefix.
 *   - Needs at least 2 consecutive bullet paragraphs after the heading
 *     (a heading + 1 item isn't a list).
 */
const MARKDOWN_LINE_PREFIX = /^(#{1,6}\s|[-*]\s|\d+\.\s|>\s|\||\s*```)/

function looksLikeHeadingLine(line: string): boolean {
  if (!line || line.includes('\n')) return false
  const words = line.split(/\s+/).filter(Boolean).length
  return (
    line.length <= 60 &&
    words >= 2 &&
    words <= 8 &&
    !/[.!?:]$/.test(line) &&
    /^[A-Za-z]/.test(line) &&
    !MARKDOWN_LINE_PREFIX.test(line)
  )
}

function looksLikeBulletLine(line: string): boolean {
  if (!line || line.includes('\n')) return false
  if (line.length < 5 || line.length > 240) return false
  if (!/^[A-Z0-9"'\u201C\u2018]/.test(line)) return false  // capital, digit, or smart quote
  if (!/\s/.test(line)) return false
  if (MARKDOWN_LINE_PREFIX.test(line)) return false
  return true
}

function rescueFlatStructure(text: string): string {
  // First pass: single-block rescue (heading + bullets all in one paragraph
  // separated only by single newlines).
  const blocks = text.split(/\n{2,}/)
  const afterBlockRescue = blocks.map(rescueBlock)

  // Second pass: adjacent-paragraph rescue. Walk the paragraphs and when
  // we see a heading-shaped paragraph followed by 2+ bullet-shaped ones,
  // fuse them into a single `## heading\n\n- bullet…` block.
  const paragraphs = afterBlockRescue.map(p => p.trim()).filter(Boolean)
  const out: string[] = []
  let i = 0
  while (i < paragraphs.length) {
    const p = paragraphs[i]
    if (looksLikeHeadingLine(p)) {
      const bullets: string[] = []
      let j = i + 1
      while (j < paragraphs.length && looksLikeBulletLine(paragraphs[j])) {
        bullets.push(paragraphs[j])
        j++
      }
      if (bullets.length >= 2) {
        out.push(`## ${p}\n\n${bullets.map(b => `- ${b}`).join('\n')}`)
        i = j
        continue
      }
    }
    out.push(p)
    i++
  }
  return out.join('\n\n')
}

function rescueBlock(block: string): string {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 3) return block
  if (lines.some(l => MARKDOWN_LINE_PREFIX.test(l))) return block

  const first = lines[0]
  const rest = lines.slice(1)

  if (!looksLikeHeadingLine(first)) return block
  if (!rest.every(looksLikeBulletLine)) return block

  return `## ${first}\n\n${rest.map(l => `- ${l}`).join('\n')}`
}
