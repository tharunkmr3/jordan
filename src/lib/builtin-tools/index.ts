/**
 * Built-in tool loader for the chat pipeline.
 *
 * Reads agent.settings.builtin_tools to decide which tools to expose:
 *   { web_search: boolean, deep_research: boolean }
 *
 * Returns an LLM-shaped tool list + an executor that the pipeline
 * calls when the model requests one of these tool names. The pipeline
 * merges this bundle with Composio's bundle before running the
 * agentic loop; each tool name is unique (`web_search`,
 * `deep_research`) so there's no collision.
 */

import type { LlmTool } from '@/lib/composio/tools'
import type { WebMessageSource } from '@/types/database'
import { WEB_SEARCH_TOOL_DEF, DEEP_RESEARCH_TOOL_DEF, runWebSearch } from './web-search'
import { runDeepResearch } from './deep-research'

export interface BuiltinToolsSettings {
  web_search?: boolean
  deep_research?: boolean
}

export interface BuiltinToolsBundle {
  tools: LlmTool[]
  execute: (name: string, args: Record<string, unknown>) => Promise<string>
  /**
   * Web / research URLs captured during this agent turn. Populated by
   * the executor on each web_search / deep_research tool call; the
   * pipeline reads it after the agentic loop finishes and merges into
   * the assistant message's metadata.sources. De-duplicated by URL so
   * the same link doesn't produce multiple chips even if the agent
   * searched twice.
   */
  getCapturedSources: () => WebMessageSource[]
}

/**
 * Inspect agent settings and return the enabled built-in tools.
 * Returns null when none are enabled.
 */
export function buildBuiltinTools(settings: Record<string, unknown> | null | undefined): BuiltinToolsBundle | null {
  const flags = (settings?.builtin_tools as BuiltinToolsSettings | undefined) ?? {}
  const tools: LlmTool[] = []
  if (flags.web_search) tools.push(WEB_SEARCH_TOOL_DEF)
  if (flags.deep_research) tools.push(DEEP_RESEARCH_TOOL_DEF)
  if (tools.length === 0) return null

  // URL → WebMessageSource so we collapse duplicate links across a
  // multi-tool-call turn into a single chip.
  const captured = new Map<string, WebMessageSource>()

  const captureHits = (hits: Array<{ url?: string; title?: string; snippet?: string }>, tool: 'web_search' | 'deep_research') => {
    for (const h of hits ?? []) {
      if (!h?.url) continue
      if (captured.has(h.url)) continue
      captured.set(h.url, {
        kind: 'web',
        url: h.url,
        title: h.title || hostOf(h.url) || h.url,
        snippet: (h.snippet ?? '').slice(0, 300),
        tool,
      })
    }
  }

  return {
    tools,
    execute: async (name, args) => {
      if (name === 'web_search') {
        const q = typeof args.query === 'string' ? args.query : ''
        if (!q) return JSON.stringify({ error: 'query is required' })
        const max = typeof args.max_results === 'number' ? args.max_results : undefined
        const result = await runWebSearch(q, { maxResults: max })
        if ('results' in result) captureHits(result.results, 'web_search')
        return JSON.stringify(result)
      }
      if (name === 'deep_research') {
        const topic = typeof args.topic === 'string' ? args.topic : ''
        if (!topic) return JSON.stringify({ error: 'topic is required' })
        const depth = args.depth === 'quick' ? 'quick' : 'thorough'
        const result = await runDeepResearch(topic, depth)
        // deep_research shape: { summary, sources?: [{title, url, snippet}] }
        // Tolerant of either `sources` or `results` field names.
        const hitsField = (result as unknown as { sources?: unknown; results?: unknown })
        const hits = Array.isArray(hitsField.sources)
          ? hitsField.sources as Array<{ url?: string; title?: string; snippet?: string }>
          : Array.isArray(hitsField.results)
          ? hitsField.results as Array<{ url?: string; title?: string; snippet?: string }>
          : []
        captureHits(hits, 'deep_research')
        return JSON.stringify(result)
      }
      return JSON.stringify({ error: `Unknown built-in tool: ${name}` })
    },
    getCapturedSources: () => Array.from(captured.values()),
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
