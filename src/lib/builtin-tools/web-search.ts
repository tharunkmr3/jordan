/**
 * Web search tool — thin wrapper over Tavily's search API.
 *
 * Why Tavily: simple API, free tier (~1000 req/mo), LLM-optimized
 * result summaries. Env var: TAVILY_API_KEY. Tool is still registered
 * when the key is missing — returns a clear "not configured" result
 * so the model can tell the user instead of looping on a 500.
 *
 * Shape is OpenAI-compatible so it plugs into the same executeAgentToolCall
 * path we use for Composio. The server invokes this directly rather than
 * going through Composio (saves a hop + doesn't consume Composio quota).
 */

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResponse {
  query: string
  results: WebSearchResult[]
  /** Optional short summary returned by Tavily's `answer` field. */
  summary?: string
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

export async function runWebSearch(query: string, opts?: { maxResults?: number; includeAnswer?: boolean }): Promise<WebSearchResponse | { error: string }> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    return { error: 'Web search is enabled on this agent but TAVILY_API_KEY is not configured on the server.' }
  }

  const body = {
    api_key: apiKey,
    query,
    search_depth: 'basic' as const,
    max_results: Math.min(Math.max(opts?.maxResults ?? 5, 1), 10),
    include_answer: opts?.includeAnswer ?? true,
    include_raw_content: false,
    include_images: false,
  }

  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { error: `Tavily ${res.status}: ${text.slice(0, 200)}` }
    }
    const data = await res.json() as {
      answer?: string
      results?: Array<{ title: string; url: string; content?: string; raw_content?: string }>
    }
    // Compress snippets before sending back to the caller. Each Tavily
    // result often carries 1–4KB of raw content; with max_results=10 that
    // puts 10–40KB into the agent's context window, drowning out the
    // system prompt and KB chunks. Trim hard (≈240 chars = ~60 tokens),
    // strip whitespace noise, and keep only URL-bearing rows. The
    // `answer` field is Tavily's own LLM-summarized digest and is
    // usually all the agent needs to compose its reply — snippets are
    // the backup + citation source.
    const results: WebSearchResult[] = (data.results ?? [])
      .filter(r => r.url && r.title)
      .map(r => {
        const raw = (r.content ?? r.raw_content ?? '').replace(/\s+/g, ' ').trim()
        const snippet = raw.length > 240 ? raw.slice(0, 237).trim() + '…' : raw
        return { title: r.title, url: r.url, snippet }
      })
    return {
      query,
      results,
      // Tavily's `answer` is already compact (2–4 sentences); pass through.
      summary: data.answer,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unknown Tavily error' }
  }
}

/**
 * OpenAI-compatible tool definitions for the two built-in tools.
 * Returned from buildBuiltinTools() and merged with Composio's toolset
 * by the pipeline when enabled via agent.settings.builtin_tools.
 */
export const WEB_SEARCH_TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: 'Search the live web for up-to-date information. Use this when the user asks about recent events, current data, or anything that might be outside the model\'s training cutoff.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        max_results: { type: 'integer', description: 'Number of results to return (1-10). Default 5.', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
  },
}

export const DEEP_RESEARCH_TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'deep_research',
    description: 'Run a multi-query web research pass and synthesize a detailed answer. Use for topics requiring breadth (market scans, competitor analysis, literature reviews). Slower and more expensive than web_search — only use when one query wouldn\'t do.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The research topic or question.' },
        depth: { type: 'string', enum: ['quick', 'thorough'], description: 'quick = 3 sub-queries, thorough = 6. Default thorough.' },
      },
      required: ['topic'],
    },
  },
}
