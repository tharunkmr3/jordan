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

  // 4) Collapse 3+ consecutive blank lines that result from step 2/3
  //    splitting, down to the standard double-newline.
  s = s.replace(/\n{3,}/g, '\n\n')

  return s
}
