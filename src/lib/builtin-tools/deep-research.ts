/**
 * deep_research tool — multi-query research pass.
 *
 * Strategy:
 * 1. Use the LLM (cheap model) to expand the user's topic into N sub-queries.
 * 2. Run each sub-query through Tavily in parallel.
 * 3. Return a compact synthesis: sub-query → top 3 results as bullet points
 *    with URLs. The CALLING model synthesizes further in its final response.
 *
 * This keeps us honest: no hidden "research summarizer" that could confabulate.
 * The calling model sees the raw sources and builds its own answer.
 */

import OpenAI from 'openai'
import { runWebSearch, type WebSearchResult } from './web-search'

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY required for deep_research query expansion')
    _openai = new OpenAI({ apiKey })
  }
  return _openai
}

export interface DeepResearchOutput {
  topic: string
  subQueries: string[]
  findings: Array<{
    query: string
    results: WebSearchResult[]
    summary?: string
  }>
}

export async function runDeepResearch(
  topic: string,
  depth: 'quick' | 'thorough' = 'thorough',
): Promise<DeepResearchOutput | { error: string }> {
  const numQueries = depth === 'quick' ? 3 : 6

  // 1. Expand topic into sub-queries using a cheap model.
  let subQueries: string[] = []
  try {
    const expansion = await getOpenAI().chat.completions.create({
      // Cheap model for query expansion — the main agent model handles
      // the real synthesis after we return findings.
      model: 'gpt-5.4-mini',
      messages: [
        {
          role: 'system',
          content: `You expand a research topic into ${numQueries} focused web search queries. Each query should cover a distinct angle. Return ONLY a JSON array of strings, no prose.`,
        },
        { role: 'user', content: topic },
      ],
      response_format: { type: 'json_object' },
    })
    const raw = expansion.choices[0]?.message?.content ?? '[]'
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      subQueries = parsed.filter(s => typeof s === 'string').slice(0, numQueries)
    } else if (Array.isArray(parsed.queries)) {
      subQueries = parsed.queries.filter((s: unknown) => typeof s === 'string').slice(0, numQueries)
    }
  } catch (err) {
    console.error('[deep_research] query expansion failed:', err)
  }
  // Fallback: just use the topic itself if expansion failed.
  if (subQueries.length === 0) subQueries = [topic]

  // 2. Fire every sub-query in parallel. Tavily can handle it.
  const results = await Promise.all(
    subQueries.map(async (q) => {
      const r = await runWebSearch(q, { maxResults: 3, includeAnswer: true })
      if ('error' in r) return { query: q, results: [] as WebSearchResult[] }
      return { query: q, results: r.results, summary: r.summary }
    }),
  )

  return {
    topic,
    subQueries,
    findings: results,
  }
}
