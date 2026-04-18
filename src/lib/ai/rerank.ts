// ============================================================================
// Cross-encoder reranking via Voyage AI
//
// Why: the embeddings in pgvector score the query and each chunk
// INDEPENDENTLY — "bi-encoder" style. They're fast and cheap but blind to
// fine-grained relevance that only becomes visible when you look at the
// (query, chunk) pair together.
//
// A cross-encoder reranker does exactly that: it feeds both the query and
// each candidate chunk into the SAME forward pass and scores relevance.
// In production RAG systems this is the single biggest retrieval quality
// win — Voyage's own evals show ~30% nDCG@10 lift over bi-encoder only.
// Concretely for us: "latest data in my resume" → Resume.pdf chunks stop
// getting outranked by CA-certificate chunks that merely contain the word
// "data".
//
// Voyage rerank-2.5 is state of the art, free tier is 200M tokens/month
// (well above a growing SaaS), and latency is ~100–200ms for a pool of
// 30 candidates. If the key is missing we silently fall back to the
// pre-rerank order — the feature enhances retrieval, it never blocks it.
//
// Usage pattern:
//   1) queryKnowledgeBase pulls top 30 via hybrid search
//   2) rerank() scores them with cross-encoder
//   3) Return top K (usually 5–8) to the LLM
// ============================================================================

export interface RerankCandidate {
  /** Stable id we echo back so callers can correlate to their row shape. */
  id: string
  content: string
}

export interface RerankedHit {
  id: string
  content: string
  /** Cross-encoder relevance score, typically in [0, 1]. Higher is better. */
  score: number
}

export interface RerankOptions {
  query: string
  documents: RerankCandidate[]
  topK?: number
  /** Override the rerank model. Defaults to rerank-2.5 (best quality). */
  model?: 'rerank-2.5' | 'rerank-2.5-lite' | 'rerank-2'
}

const RERANK_ENDPOINT = 'https://api.voyageai.com/v1/rerank'

/**
 * Rerank a candidate pool with Voyage's cross-encoder.
 *
 * Returns null when:
 *   - VOYAGE_API_KEY is unset (soft-disable the feature)
 *   - the API call failed
 *   - the response is malformed
 *
 * Returns [] when the caller passed an empty document list.
 *
 * Caller-friendly behaviour: the returned hits include the caller's own
 * `id` so downstream code can `.map()` back to its own row type without
 * a lookup — we don't reshape the caller's data here.
 */
export async function rerank(opts: RerankOptions): Promise<RerankedHit[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) return null

  if (opts.documents.length === 0) return []

  const topK = Math.min(opts.topK ?? 8, opts.documents.length)
  // Default to rerank-2.5-lite — ~3× faster than the full rerank-2.5 at
  // ~5% quality loss on standard benchmarks. The right tradeoff for the
  // inline critical path: a perceptible latency reduction matters more
  // than the tail quality when our hybrid+name-boost retrieval already
  // did most of the work before the reranker sees it. Callers that want
  // the full model pass `model: 'rerank-2.5'` explicitly.
  const model = opts.model ?? 'rerank-2.5-lite'

  try {
    const res = await fetch(RERANK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        query: opts.query,
        // Voyage wants the raw texts; we correlate back via index below.
        documents: opts.documents.map((d) => d.content),
        top_k: topK,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[rerank] Voyage ${res.status}: ${text.slice(0, 200)}`)
      return null
    }
    const data = await res.json() as {
      data?: Array<{ index: number; relevance_score: number }>
    }
    if (!Array.isArray(data.data)) return null
    return data.data
      .filter((item) => item.index >= 0 && item.index < opts.documents.length)
      .map((item) => ({
        id: opts.documents[item.index].id,
        content: opts.documents[item.index].content,
        score: item.relevance_score,
      }))
  } catch (err) {
    console.error('[rerank] Voyage request failed:', err)
    return null
  }
}
