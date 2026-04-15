import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  })
  return response.data[0].embedding
}

export function chunkText(text: string, maxChunkSize = 500, overlap = 50): string[] {
  // Split text into chunks of ~500 chars with 50 char overlap
  // Split on sentence boundaries when possible
  const sentences = text.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if ((current + sentence).length > maxChunkSize && current) {
      chunks.push(current.trim())
      // Keep overlap from end of previous chunk
      const words = current.split(' ')
      current = words.slice(-Math.ceil(overlap / 5)).join(' ') + ' ' + sentence
    } else {
      current += (current ? ' ' : '') + sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}
