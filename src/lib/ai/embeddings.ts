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

/** Classic sentence-boundary chunker for prose. */
function chunkProse(text: string, maxChunkSize: number, overlap: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if ((current + sentence).length > maxChunkSize && current) {
      chunks.push(current.trim())
      // Keep overlap from end of previous chunk so cross-boundary
      // context isn't lost on retrieval.
      const words = current.split(' ')
      current = words.slice(-Math.ceil(overlap / 5)).join(' ') + ' ' + sentence
    } else {
      current += (current ? ' ' : '') + sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}
