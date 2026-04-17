/**
 * normalizeModelMarkdown — clean up minor Markdown patterns that models
 * emit even after being told not to, on channels where Markdown is still
 * the authoritative format (phone voice-readout of the synthesized prose,
 * WhatsApp / Messenger replies).
 *
 * On the `website` channel this normalizer runs only when structured-
 * output synthesis failed — structured output is the primary enforcement
 * there, so flat-text rescue heuristics (the old `rescueFlatStructure`
 * code path) were removed. Format drift on website is handled by the
 * JSON schema, not by retrofitting Markdown after the fact.
 *
 * What's still normalized:
 *   - `**Label:** description` pseudo-headings → real `## Heading` +
 *     body break (Anthropic in particular loves this pattern)
 *   - Stray `---` horizontal rules on their own line → removed
 *   - 3+ consecutive blank lines → collapsed to the canonical double-
 *     newline
 *
 * Code fences and <think>…</think> traces are preserved verbatim.
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

  // 4) Collapse 3+ consecutive blank lines that result from prior splits,
  //    down to the standard double-newline.
  s = s.replace(/\n{3,}/g, '\n\n')

  return s
}
