"use client"

// ============================================================================
// <ReasoningSteps>
//
// Compact collapsible timeline of what the agent did while composing the
// reply — the "thinking" phases + every tool it called. Rendered ABOVE
// the assistant reply body so users see the reasoning trace at a glance
// and can expand to audit specifics.
//
// Data source: metadata.steps on an assistant message, populated by the
// chat-pipeline's ThoughtEvent stream (see runAgenticLoopStream). Each
// step is one of:
//
//   - thinking    — a reasoning phase label ("Analyzing request",
//                   "Deciding next step (round 2)")
//   - tool_call   — a tool invocation, shown as running while the
//                   matching tool_done hasn't landed yet
//   - tool_done   — merged into its tool_call in the client reducer, so
//                   by render time every tool_call has status=done +
//                   resultPreview
//
// States:
//
//   - `streaming=true`  → auto-expanded, "Thinking…" shimmer header
//   - `streaming=false` → collapsed by default to "Thought for N steps",
//                         click to expand and audit
//
// Mimics the pattern ChatGPT / Claude Projects / Cursor use for reasoning
// transparency. Quiet by default — the response itself is the primary
// content; this is an inspector, not a distraction.
// ============================================================================

import * as React from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { TextShimmerWave } from "@/components/core/text-shimmer-wave"
import { cn } from "@/lib/utils"

export type ReasoningStep =
  | { kind: "thinking"; id: string; trigger: string; items?: string[] }
  | {
      kind: "tool_call"
      id: string
      tool: string
      args: Record<string, unknown>
      status?: "running" | "done"
      resultPreview?: string
    }
  | { kind: "tool_done"; id: string; tool: string; resultPreview: string }

interface ReasoningStepsProps {
  steps: ReasoningStep[]
  /** True while the assistant response is still streaming — keeps the
      panel auto-expanded and shows the live shimmer header. */
  streaming?: boolean
  className?: string
}

export function ReasoningSteps({ steps, streaming, className }: ReasoningStepsProps) {
  const [open, setOpen] = React.useState<boolean>(Boolean(streaming))

  // Auto-open while streaming, auto-collapse when the stream finishes
  // (unless the user explicitly opened it). Using a ref to track whether
  // the user touched the state would be cleaner, but this simpler
  // heuristic matches the ChatGPT behaviour closely.
  const lastStreaming = React.useRef(streaming)
  React.useEffect(() => {
    if (lastStreaming.current && !streaming) setOpen(false)
    if (!lastStreaming.current && streaming) setOpen(true)
    lastStreaming.current = streaming
  }, [streaming])

  if (!steps || steps.length === 0) return null

  const toolSteps = steps.filter((s): s is Extract<ReasoningStep, { kind: "tool_call" }> => s.kind === "tool_call")
  const summaryLabel = streaming
    ? "Thinking…"
    : toolSteps.length > 0
      ? `Worked through ${steps.length} step${steps.length === 1 ? "" : "s"} · ${toolSteps.length} tool call${toolSteps.length === 1 ? "" : "s"}`
      : `Thought through ${steps.length} step${steps.length === 1 ? "" : "s"}`

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 self-start text-[12px] font-medium text-[#737373] hover:text-[#2e2e2e] transition-colors"
        aria-expanded={open}
      >
        {streaming ? (
          <TextShimmerWave
            as="span"
            className="[--base-color:#a3a3a3] [--base-gradient-color:#2e2e2e] text-[12px] font-medium"
            duration={1}
            spread={1}
            zDistance={1}
            scaleDistance={1.05}
            rotateYDistance={10}
          >
            {summaryLabel}
          </TextShimmerWave>
        ) : (
          <span>{summaryLabel}</span>
        )}
        {open ? (
          <ChevronUp size={12} strokeWidth={2.25} />
        ) : (
          <ChevronDown size={12} strokeWidth={2.25} />
        )}
      </button>
      {open && (
        <div className="border-l-2 border-black/[0.06] pl-3 py-1 flex flex-col gap-2">
          {steps.map((step, i) => (
            <StepItem key={`${step.kind}-${i}-${stepKey(step)}`} step={step} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Individual step renderer
// ---------------------------------------------------------------------------

function stepKey(step: ReasoningStep): string {
  if (step.kind === "tool_call" || step.kind === "tool_done" || step.kind === "thinking") return step.id
  return ""
}

function StepItem({ step }: { step: ReasoningStep }) {
  if (step.kind === "thinking") {
    return (
      <div className="text-[12px] leading-relaxed text-[#737373]">
        <span className="text-[#a3a3a3] mr-1">•</span>
        {step.trigger}
      </div>
    )
  }
  if (step.kind === "tool_call") {
    const running = step.status !== "done"
    const prettyTool = humanizeToolName(step.tool)
    const argPreview = formatArgs(step.args)
    return (
      <div className="text-[12px] leading-relaxed text-[#525252]">
        <div className="flex items-baseline gap-1.5">
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full mt-1 shrink-0", running ? "bg-[#F4511E] animate-pulse" : "bg-[#10b981]")} />
          <span className="font-medium text-[#2e2e2e]">{prettyTool}</span>
          {running && <span className="text-[#a3a3a3] text-[11px]">running…</span>}
        </div>
        {argPreview && (
          <div className="ml-4 mt-0.5 text-[11px] text-[#737373] font-mono whitespace-pre-wrap break-all">
            {argPreview}
          </div>
        )}
        {step.resultPreview && (
          <div className="ml-4 mt-0.5 text-[11px] text-[#737373] italic">
            → {step.resultPreview}
          </div>
        )}
      </div>
    )
  }
  // tool_done shouldn't appear here (merged into tool_call by reducer),
  // but render defensively if it does.
  if (step.kind === "tool_done") {
    return (
      <div className="text-[12px] leading-relaxed text-[#525252]">
        <span className="font-medium text-[#2e2e2e]">{humanizeToolName(step.tool)}</span>
        <div className="ml-4 text-[11px] text-[#737373] italic">→ {step.resultPreview}</div>
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Convert a raw tool name into something presentable:
 *   - GOOGLECALENDAR_QUICK_ADD       → Google Calendar · Quick add
 *   - web_search                     → Web search
 *   - search_kb                      → Search knowledge base
 *   - fetch_document                 → Fetch document
 *
 * The tool name IS the thing users care about — the agent called a
 * specific action — so we don't hide it, just smooth the casing.
 */
function humanizeToolName(raw: string): string {
  if (!raw) return "Tool"
  // Composio conventions: PROVIDERNAME_ACTION_MORE. Split on the first
  // underscore so we can label "<Provider> · <action>".
  const composioMatch = raw.match(/^([A-Z][A-Z0-9]+)_([A-Z0-9_]+)$/)
  if (composioMatch) {
    const provider = titleCase(composioMatch[1].replace(/_/g, " "))
    const action = sentenceCase(composioMatch[2].replace(/_/g, " "))
    return `${provider} · ${action}`
  }
  // Built-in tools: snake_case names.
  return sentenceCase(raw.replace(/_/g, " "))
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}

function sentenceCase(s: string): string {
  if (!s) return s
  const lower = s.toLowerCase()
  return lower[0].toUpperCase() + lower.slice(1)
}

/**
 * Render a tool call's args compactly: each scalar on its own line as
 * `key: value`, truncating long string values. Arrays and nested objects
 * get a one-line JSON summary so the user can still audit but the panel
 * doesn't blow out.
 */
function formatArgs(args: Record<string, unknown>): string {
  if (!args || typeof args !== "object" || Object.keys(args).length === 0) return ""
  const lines: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue
    if (typeof v === "string") {
      const truncated = v.length > 140 ? v.slice(0, 140) + "…" : v
      lines.push(`${k}: ${truncated}`)
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k}: ${v}`)
    } else {
      const json = safeStringify(v)
      const truncated = json.length > 140 ? json.slice(0, 140) + "…" : json
      lines.push(`${k}: ${truncated}`)
    }
  }
  return lines.join("\n")
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
