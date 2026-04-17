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
import { WEB_SEARCH_TOOL_DEF, DEEP_RESEARCH_TOOL_DEF, runWebSearch } from './web-search'
import { runDeepResearch } from './deep-research'

export interface BuiltinToolsSettings {
  web_search?: boolean
  deep_research?: boolean
}

export interface BuiltinToolsBundle {
  tools: LlmTool[]
  execute: (name: string, args: Record<string, unknown>) => Promise<string>
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

  return {
    tools,
    execute: async (name, args) => {
      if (name === 'web_search') {
        const q = typeof args.query === 'string' ? args.query : ''
        if (!q) return JSON.stringify({ error: 'query is required' })
        const max = typeof args.max_results === 'number' ? args.max_results : undefined
        const result = await runWebSearch(q, { maxResults: max })
        return JSON.stringify(result)
      }
      if (name === 'deep_research') {
        const topic = typeof args.topic === 'string' ? args.topic : ''
        if (!topic) return JSON.stringify({ error: 'topic is required' })
        const depth = args.depth === 'quick' ? 'quick' : 'thorough'
        const result = await runDeepResearch(topic, depth)
        return JSON.stringify(result)
      }
      return JSON.stringify({ error: `Unknown built-in tool: ${name}` })
    },
  }
}
