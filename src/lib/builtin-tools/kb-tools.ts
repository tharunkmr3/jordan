// ============================================================================
// Agentic KB retrieval tools
//
// Two tools the agent can call whenever it thinks one-shot retrieval
// might have missed something:
//
//  1) search_kb — explicit RAG search, optionally filtered to a named
//     file. Lets the model say "hmm, the user asked about their resume,
//     let me search the KB specifically with that filter" instead of
//     relying on whatever pre-retrieval the pipeline already did.
//
//  2) fetch_document — pull the full text of a specific document by
//     filename. For cases where the agent knows the file exists (from
//     the KB Inventory block in the system prompt) but wasn't given
//     enough retrieved content to answer fully. Bounded by a char cap
//     so one large spreadsheet doesn't blow the context window.
//
// This is "agentic RAG" — the standard production pattern from Cursor,
// Claude Projects, Notion AI. Moves retrieval decisions FROM the
// pipeline TO the model, which lets the model recover from bad initial
// retrievals instead of answering wrong.
//
// Tools are wired up automatically when the agent has any ready
// documents in its KB. There's no settings toggle — every KB-enabled
// agent benefits from them, and the cost is zero when the model
// doesn't call them (tool declarations are cheap).
// ============================================================================

import type { LlmTool } from '@/lib/composio/tools'
import type { MessageSource } from '@/types/database'
import { createAdminClient } from '@/lib/supabase/admin'
import { queryKnowledgeBase } from '@/lib/ai/knowledge-base'

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

export const KB_SEARCH_TOOL_DEF: LlmTool = {
  type: 'function',
  function: {
    name: 'search_kb',
    description:
      "Search this agent's knowledge base for passages relevant to a query. Returns the top matching chunks with filename, snippet, and relevance score. Use this when the pre-retrieved context didn't cover the user's question, when the user asks about a specific file by name, or when you need more detail on a topic the initial retrieval touched lightly. Prefer this over guessing from memory.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query. Be specific — "Q2 2024 revenue by region" works better than "revenue".',
        },
        filename_filter: {
          type: 'string',
          description: "Optional — restrict results to documents whose filename contains this substring (case-insensitive). Use when the user names a specific file (e.g. 'Resume.pdf', 'invoice').",
        },
        max_results: {
          type: 'integer',
          description: 'Number of passages to return (1–12). Default 5.',
          minimum: 1,
          maximum: 12,
        },
      },
      required: ['query'],
    },
  },
}

export const KB_FETCH_TOOL_DEF: LlmTool = {
  type: 'function',
  function: {
    name: 'fetch_document',
    description:
      "Fetch the FULL text content of a specific document in this agent's knowledge base, identified by filename. Use this when you need the complete contents of a file (not just retrieved passages) — e.g. to summarize a whole resume, walk through a contract end-to-end, or cite every row of a small spreadsheet. Bounded by a char cap; ask for sections of a large doc via search_kb instead.",
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Exact or partial filename. Case-insensitive substring match — "resume" will find "Resume.pdf".',
        },
        max_chars: {
          type: 'integer',
          description: 'Cap on characters returned (1000–40000). Default 20000. Larger values may consume significant context window.',
          minimum: 1000,
          maximum: 40000,
        },
      },
      required: ['filename'],
    },
  },
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

type Supabase = ReturnType<typeof createAdminClient>

/**
 * A KB source captured during a single agentic turn. Used internally to
 * build the bundle's getCapturedSources() output. Chunk id is the stable
 * dedupe key when we have it (search_kb hits); for fetch_document we
 * synthesize one from the document id so the same file retrieved twice
 * still collapses to a single chip.
 */
type CapturedKbHit = {
  chunkId: string
  documentId: string
  documentName: string
  kbId: string
  snippet: string
  similarity: number
}

/**
 * search_kb executor.
 *
 * Reuses the pipeline's canonical retrieval path (queryKnowledgeBase →
 * hybrid search → reranker) so tool-driven retrieval matches the quality
 * of the automatic first-turn retrieval. When a filename_filter is
 * supplied, we over-fetch and post-filter by document name — pushing the
 * filter into the RPC would require another migration and the result set
 * is always small enough to filter in-memory.
 *
 * Captured hits flow through onCapture so the bundle can expose them to
 * the pipeline after the agentic loop completes.
 */
async function runKbSearch(
  agentId: string,
  args: { query: string; filename_filter?: string; max_results?: number },
  onCapture: (hits: CapturedKbHit[]) => void,
): Promise<string> {
  const query = args.query?.trim()
  if (!query) return JSON.stringify({ error: 'query is required' })

  const want = Math.min(Math.max(args.max_results ?? 5, 1), 12)
  const filter = args.filename_filter?.toLowerCase().trim() ?? ''

  // If a filename filter is present, ask for a wider pool so we have
  // enough matches after filtering. No filter → request exactly `want`.
  const over = filter ? Math.min(want * 4, 30) : want

  try {
    const hits = await queryKnowledgeBase(agentId, query, over)
    const filtered = filter
      ? hits.filter((h) => h.documentName.toLowerCase().includes(filter))
      : hits
    const top = filtered.slice(0, want)

    if (top.length === 0) {
      return JSON.stringify({
        query,
        filename_filter: filter || null,
        results: [],
        note: filter
          ? `No passages found. If you believe the file "${filter}" exists, call fetch_document instead to read the whole file.`
          : 'No relevant passages found for this query.',
      })
    }

    // Capture for the citation-chip pipeline.
    onCapture(top.map((h) => ({
      chunkId: h.id,
      documentId: h.documentId,
      documentName: h.documentName,
      kbId: h.kbId,
      snippet: h.content.length > 220 ? h.content.slice(0, 220).trim() + '…' : h.content,
      similarity: h.similarity,
    })))

    return JSON.stringify({
      query,
      filename_filter: filter || null,
      results: top.map((h) => ({
        filename: h.documentName,
        snippet: h.content.length > 600 ? h.content.slice(0, 600).trim() + '…' : h.content,
        relevance: Number(h.similarity.toFixed(3)),
      })),
    })
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : 'search_kb failed' })
  }
}

/**
 * fetch_document executor.
 *
 * Finds the document by case-insensitive substring on filename, scoped
 * to the agent's KBs. Reassembles the full text by concatenating chunks
 * in index order. Truncates to max_chars to protect the model's context
 * window on very large files.
 *
 * Captures a single synthetic source hit for the document so the
 * citation chip pipeline can attribute the answer to this file. The
 * snippet is the first ~220 chars of the returned content — the same
 * shape the regular KB-chunk path emits.
 */
async function runKbFetch(
  supabase: Supabase,
  agentId: string,
  args: { filename: string; max_chars?: number },
  onCapture: (hits: CapturedKbHit[]) => void,
): Promise<string> {
  const filename = args.filename?.trim()
  if (!filename) return JSON.stringify({ error: 'filename is required' })
  const maxChars = Math.min(Math.max(args.max_chars ?? 20000, 1000), 40000)

  try {
    // 1. Find the document id(s) whose name matches.
    const { data: docs, error: docErr } = await supabase
      .from('kb_documents')
      .select('id, name, kb_id, knowledge_bases!inner(agent_id)')
      .eq('knowledge_bases.agent_id', agentId)
      .eq('status', 'ready')
      .ilike('name', `%${filename}%`)
      .limit(5)

    if (docErr) {
      return JSON.stringify({ error: `lookup failed: ${docErr.message}` })
    }
    if (!docs || docs.length === 0) {
      return JSON.stringify({
        error: 'document_not_found',
        filename,
        note: "No document with a matching filename. Check the file inventory in your context for the list of files available.",
      })
    }
    if (docs.length > 1) {
      // Ambiguous — return the candidate list so the model can refine.
      return JSON.stringify({
        error: 'ambiguous_filename',
        filename,
        candidates: docs.map((d: { name: string }) => d.name),
        note: 'Multiple documents match. Call fetch_document again with a more specific filename.',
      })
    }

    const doc = docs[0] as { id: string; name: string; kb_id: string }

    // 2. Concatenate chunks for the matching document.
    const { data: chunks, error: chunksErr } = await supabase
      .from('kb_chunks')
      .select('id, content, chunk_index')
      .eq('document_id', doc.id)
      .order('chunk_index', { ascending: true })

    if (chunksErr) {
      return JSON.stringify({ error: `read failed: ${chunksErr.message}` })
    }

    const full = (chunks ?? []).map((c: { content: string }) => c.content).join('\n\n')
    const truncated = full.length > maxChars
    const content = truncated ? full.slice(0, maxChars) + `\n\n…[truncated; ${full.length - maxChars} chars omitted]` : full

    // Capture the document as a source so the chip pipeline picks it up.
    // Use the first chunk's id as the chunkId if present so dedupe across
    // multiple fetch_document calls against the same file works cleanly.
    const firstChunkId = (chunks?.[0] as { id?: string } | undefined)?.id ?? `doc-${doc.id}`
    onCapture([{
      chunkId: firstChunkId,
      documentId: doc.id,
      documentName: doc.name,
      kbId: doc.kb_id,
      snippet: full.length > 220 ? full.slice(0, 220).trim() + '…' : full,
      // fetch_document doesn't have a relevance score — it's a deterministic
      // lookup by filename. Use 1.0 so the downstream noise-filter never
      // drops the chip for an intentional fetch.
      similarity: 1.0,
    }])

    return JSON.stringify({
      filename: doc.name,
      char_count: full.length,
      returned_chars: content.length,
      truncated,
      content,
    })
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : 'fetch_document failed' })
  }
}

// ---------------------------------------------------------------------------
// Bundle builder
// ---------------------------------------------------------------------------

export interface KbAgenticTools {
  tools: LlmTool[]
  execute: (name: string, args: Record<string, unknown>) => Promise<string>
  /**
   * KB chunks surfaced through tool calls during this turn. The pipeline
   * reads this after the agentic loop finishes and merges into the
   * assistant message's metadata.sources so tool-answered queries still
   * get the clickable citation chip — without this, an agent that
   * answers via `fetch_document` or `search_kb` produces a correct
   * reply with zero visible source attribution.
   *
   * De-duplicated by chunk id (when available) or document id + kb id
   * so multiple agentic calls against the same document only produce
   * one chip per document.
   */
  getCapturedSources: () => MessageSource[]
}

/**
 * Build the KB agentic tool bundle for an agent. Returns null if the
 * agent has no ready documents — there's nothing for the tools to
 * operate on, and exposing them would just confuse the model.
 *
 * Called from the chat pipeline alongside buildBuiltinTools. The
 * pipeline merges both bundles into a single tool list for the LLM.
 */
export async function buildKbAgenticTools(
  supabase: Supabase,
  agentId: string,
): Promise<KbAgenticTools | null> {
  // Cheap existence check — don't expose retrieval tools when there's
  // nothing indexed. The count-only query is O(1) on the index.
  const { count, error } = await supabase
    .from('kb_documents')
    .select('id, knowledge_bases!inner(agent_id)', { count: 'exact', head: true })
    .eq('knowledge_bases.agent_id', agentId)
    .eq('status', 'ready')

  if (error) {
    console.error('[kb-tools] existence check failed:', error)
    return null
  }
  if (!count || count === 0) return null

  // Per-turn capture map. Keyed by chunkId so duplicate hits across
  // multiple tool calls collapse to one chip. We keep the highest-
  // similarity hit per key, matching the KB retrieval filter semantics.
  const captured = new Map<string, CapturedKbHit>()
  const onCapture = (hits: CapturedKbHit[]) => {
    for (const h of hits) {
      const prev = captured.get(h.chunkId)
      if (!prev || h.similarity > prev.similarity) {
        captured.set(h.chunkId, h)
      }
    }
  }

  return {
    tools: [KB_SEARCH_TOOL_DEF, KB_FETCH_TOOL_DEF],
    execute: async (name, args) => {
      if (name === 'search_kb') {
        return runKbSearch(
          agentId,
          args as { query: string; filename_filter?: string; max_results?: number },
          onCapture,
        )
      }
      if (name === 'fetch_document') {
        return runKbFetch(
          supabase,
          agentId,
          args as { filename: string; max_chars?: number },
          onCapture,
        )
      }
      return JSON.stringify({ error: `Unknown KB tool: ${name}` })
    },
    getCapturedSources: () => {
      // De-dupe by documentId — if the model ran search_kb and then
      // fetch_document on the same file, we still only want one chip.
      // Within a document, keep the highest-similarity hit (which is
      // also the one with the richest snippet after the filter).
      const byDoc = new Map<string, CapturedKbHit>()
      for (const h of captured.values()) {
        const prev = byDoc.get(h.documentId)
        if (!prev || h.similarity > prev.similarity) {
          byDoc.set(h.documentId, h)
        }
      }
      return [...byDoc.values()].map((h) => ({
        chunk_id: h.chunkId,
        document_id: h.documentId,
        document_name: h.documentName,
        kb_id: h.kbId,
        snippet: h.snippet,
        similarity: h.similarity,
      }))
    },
  }
}
