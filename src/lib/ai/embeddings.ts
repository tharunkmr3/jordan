import OpenAI from 'openai'

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await getOpenAI().embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  })
  return response.data[0].embedding
}

/**
 * Split text into embedding-sized chunks.
 *
 * Detects **structured tabular input** (output from the XLSX extractor
 * which emits `=== Sheet: … ===` markers and `Row | Sheet: …` lines) and
 * chunks those row-by-row while keeping the sheet header + column
 * reference with every chunk. For plain prose it falls back to the
 * classic sentence-boundary chunker.
 *
 * Why two paths: tables lose all context when merged by spaces (row
 * values drift away from their column labels). Prose chunks naturally
 * around sentences. One algorithm can't serve both without compromise.
 */
export function chunkText(
  text: string,
  maxChunkSize = 900,
  overlap = 100
): string[] {
  if (!text.trim()) return []
  if (isTabular(text)) return chunkTabular(text, maxChunkSize)
  return chunkProse(text, maxChunkSize, overlap)
}

/** Is this text the output of our structured XLSX extractor? */
function isTabular(text: string): boolean {
  return /^===\s*Sheet:\s*"/m.test(text) && /^Row\s*\|/m.test(text)
}

/**
 * Chunk structured row output. Each chunk is:
 *   <sheet marker>
 *   Columns: ...
 *   Row | Sheet: "…" | Col: val | ...
 *   Row | Sheet: "…" | Col: val | ...
 *   ...
 *
 * Up to `maxChunkSize` chars worth of rows, sheet header repeated per
 * chunk so an isolated chunk retrieved by vector/lexical search carries
 * its own context ("these rows come from sheet X").
 */
function chunkTabular(text: string, maxChunkSize: number): string[] {
  const chunks: string[] = []

  // Split into sheet blocks. Each block starts with its `=== Sheet …`
  // marker and runs until the next one.
  const sheetBlocks = text
    .split(/\n(?=^===\s*Sheet:)/m)
    .map((s) => s.trim())
    .filter(Boolean)

  for (const block of sheetBlocks) {
    const lines = block.split('\n').filter((l) => l.length > 0)
    // Identify header lines (sheet marker + Columns: …) that need to
    // repeat at the top of every chunk from this sheet.
    const headerLines: string[] = []
    let dataStart = 0
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (l.startsWith('===') || l.startsWith('Columns:')) {
        headerLines.push(l)
        dataStart = i + 1
      } else {
        break
      }
    }

    // Pack row lines into chunks bounded by char count.
    const header = headerLines.join('\n')
    let buffer = header
    let rowCount = 0

    const pushBuffer = () => {
      if (rowCount > 0) chunks.push(buffer)
      buffer = header
      rowCount = 0
    }

    for (let i = dataStart; i < lines.length; i++) {
      const row = lines[i]
      // +1 for the newline we'll add.
      if (buffer.length + row.length + 1 > maxChunkSize && rowCount > 0) {
        pushBuffer()
      }
      buffer += '\n' + row
      rowCount++
    }
    pushBuffer()
  }

  return chunks
}

/**
 * Break-point-scored chunker (ported from tobi/qmd).
 *
 * Instead of splitting on the first sentence boundary after maxChunkSize,
 * we pre-scan the document for break points weighted by semantic quality:
 *   - h1..h6 markdown headings score 100..50
 *   - code fence boundaries score 80
 *   - horizontal rules score 60
 *   - paragraph breaks score 20
 *   - list items / single newlines score 5..1
 *
 * When we hit the target size, we look back within a window and pick the
 * highest-scoring break point with a squared-distance decay — headings
 * far back still beat low-quality breaks near the target. We also
 * detect fenced code blocks and refuse to split inside them so code
 * examples stay coherent.
 *
 * This matters for RAG quality: a chunk that starts mid-sentence or
 * splits a code block retrieves poorly because its embedding averages
 * an unfinished idea. Clean header-aligned chunks give the LLM clean
 * semantic units to reason over.
 */
interface BreakPoint { pos: number; score: number }
interface CodeFence { start: number; end: number }

// (pattern, score) — matched against the source text. Higher = better.
const BREAK_PATTERNS: Array<[RegExp, number]> = [
  [/\n#{1}(?!#)/g, 100],                  // h1
  [/\n#{2}(?!#)/g, 90],                   // h2
  [/\n#{3}(?!#)/g, 80],                   // h3
  [/\n#{4}(?!#)/g, 70],                   // h4
  [/\n#{5}(?!#)/g, 60],                   // h5
  [/\n#{6}/g, 50],                        // h6
  [/\n```/g, 80],                         // code fence boundary
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60],     // horizontal rule
  [/\n\n+/g, 20],                         // paragraph break
  [/\n[-*]\s/g, 5],                       // unordered list item
  [/\n\d+\.\s/g, 5],                      // ordered list item
  [/\n/g, 1],                             // any newline
]

function scanBreakPoints(text: string): BreakPoint[] {
  const seen = new Map<number, BreakPoint>()
  for (const [pattern, score] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index ?? 0
      const existing = seen.get(pos)
      if (!existing || score > existing.score) seen.set(pos, { pos, score })
    }
  }
  return [...seen.values()].sort((a, b) => a.pos - b.pos)
}

function findCodeFences(text: string): CodeFence[] {
  const out: CodeFence[] = []
  const re = /\n```/g
  let inFence = false
  let start = 0
  for (const m of text.matchAll(re)) {
    if (!inFence) { start = m.index ?? 0; inFence = true }
    else { out.push({ start, end: (m.index ?? 0) + m[0].length }); inFence = false }
  }
  if (inFence) out.push({ start, end: text.length })
  return out
}

function insideFence(pos: number, fences: CodeFence[]): boolean {
  return fences.some(f => pos > f.start && pos < f.end)
}

/**
 * Pick the best break point to cut at for a target char position.
 * Scans breaks within [target - window, target] and applies squared
 * distance decay so close high-scoring points are preferred.
 */
function bestCutoff(breaks: BreakPoint[], target: number, windowChars: number, fences: CodeFence[]): number {
  const windowStart = target - windowChars
  let bestScore = -1
  let bestPos = target
  for (const bp of breaks) {
    if (bp.pos < windowStart) continue
    if (bp.pos > target) break
    if (insideFence(bp.pos, fences)) continue
    const dist = target - bp.pos
    const norm = dist / windowChars
    const mult = 1.0 - (norm * norm) * 0.7
    const score = bp.score * mult
    if (score > bestScore) { bestScore = score; bestPos = bp.pos }
  }
  return bestPos
}

function chunkProse(text: string, maxChunkSize: number, overlap: number): string[] {
  if (text.length <= maxChunkSize) return text.trim() ? [text.trim()] : []

  const breaks = scanBreakPoints(text)
  const fences = findCodeFences(text)
  const window = Math.min(Math.max(maxChunkSize * 0.25, 200), 600) // ~200-600 char lookback
  const chunks: string[] = []
  let pos = 0

  while (pos < text.length) {
    const target = pos + maxChunkSize
    if (target >= text.length) {
      const tail = text.slice(pos).trim()
      if (tail) chunks.push(tail)
      break
    }
    const cut = bestCutoff(breaks, target, window, fences)
    // Guarantee forward progress even if no good break was found — fall
    // through to the target so a pathological run of no-break text
    // still chunks instead of infinite-looping.
    const endPos = cut > pos ? cut : target
    const chunk = text.slice(pos, endPos).trim()
    if (chunk) chunks.push(chunk)
    // Overlap from the end of the prior chunk → preserves cross-boundary
    // context on retrieval. Back off a character-count overlap; smart-
    // chunking breaks don't lose as much context so we keep it modest.
    pos = Math.max(endPos - overlap, endPos)
  }

  return chunks
}
