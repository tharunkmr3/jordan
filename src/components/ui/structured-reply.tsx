"use client"

// ============================================================================
// <StructuredReply>
//
// Renders an assistant reply from its typed Block[] representation. This is
// the deterministic sibling of the Markdown pipeline — every block type has
// a fixed React component, so format drift is architecturally impossible:
// the model can't emit an unexpected layout because the schema doesn't let
// it.
//
// Inline Markdown inside `text` fields (bold, italic, inline code, links) is
// still rendered via a small inline-markdown pass. Block-level structure is
// entirely driven by the JSON.
// ============================================================================

import * as React from "react"
import { Markdown } from "@/components/ui/markdown"
import { cn } from "@/lib/utils"
import type { Block, StructuredReply as StructuredReplyType } from "@/lib/ai/structured-output"
import { AiFormWidget } from "./ai-widget/form"
import { AiConfirmWidget } from "./ai-widget/confirm"
import { AiChoiceWidget } from "./ai-widget/choice"
import { AiCardWidget } from "./ai-widget/card"
import { AiTableWidget } from "./ai-widget/table"

interface StructuredReplyProps {
  reply: StructuredReplyType
  className?: string
}

export function StructuredReply({ reply, className }: StructuredReplyProps) {
  if (!reply?.blocks || reply.blocks.length === 0) return null
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {reply.blocks.map((block, i) => (
        <BlockRenderer key={i} block={block} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Block dispatch
// ---------------------------------------------------------------------------

function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case "heading":
      return <HeadingBlock block={block} />
    case "paragraph":
      return <ParagraphBlock block={block} />
    case "bullets":
      return <BulletsBlock block={block} />
    case "ordered":
      return <OrderedBlock block={block} />
    case "code":
      return <CodeBlock block={block} />
    case "quote":
      return <QuoteBlock block={block} />
    case "table":
      return <TableBlock block={block} />
    case "form":
      return <AiFormWidget widget={block as Parameters<typeof AiFormWidget>[0]['widget']} />
    case "confirm":
      return <AiConfirmWidget widget={block as Parameters<typeof AiConfirmWidget>[0]['widget']} />
    case "choice":
      return <AiChoiceWidget widget={block as Parameters<typeof AiChoiceWidget>[0]['widget']} />
    case "card":
      return <AiCardWidget widget={block as Parameters<typeof AiCardWidget>[0]['widget']} />
    default: {
      // Exhaustiveness guard — TS yells if a new Block type is added
      // without updating this switch.
      const _exhaustive: never = block
      void _exhaustive
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Content blocks
//
// All text fields support inline Markdown (bold, italic, links, inline code)
// via the Markdown component. Block-level structure is owned by us though —
// we never let the Markdown renderer produce headings / lists / tables.
// That's what makes rendering deterministic.
// ---------------------------------------------------------------------------

function Inline({ text }: { text: string }) {
  // Small trick: wrap in a span so the Markdown component's paragraph
  // wrapping doesn't add an extra block-level margin (headings/bullets
  // control their own spacing).
  return (
    <Markdown
      className={[
        "leading-relaxed",
        "prose-p:inline prose-p:my-0",
        "prose-code:text-[#2e2e2e] prose-code:bg-[#f5f5f5] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em] prose-code:font-mono prose-code:before:content-none prose-code:after:content-none",
        "prose-a:text-[#2e2e2e] prose-a:underline prose-a:decoration-[#a3a3a3] hover:prose-a:decoration-[#2e2e2e]",
        "prose-strong:text-[#2e2e2e] prose-strong:font-semibold",
      ].join(" ")}
    >
      {text}
    </Markdown>
  )
}

function HeadingBlock({ block }: { block: Extract<Block, { type: "heading" }> }) {
  const base = "font-semibold text-[#2e2e2e] tracking-tight"
  if (block.level === 1) {
    return <h1 className={cn(base, "text-lg mt-1")}>{block.text}</h1>
  }
  if (block.level === 2) {
    return <h2 className={cn(base, "text-[15px] mt-2")}>{block.text}</h2>
  }
  return <h3 className={cn(base, "text-sm mt-1")}>{block.text}</h3>
}

function ParagraphBlock({ block }: { block: Extract<Block, { type: "paragraph" }> }) {
  return (
    <div className="text-sm text-[#2e2e2e]">
      <Inline text={block.text} />
    </div>
  )
}

function BulletsBlock({ block }: { block: Extract<Block, { type: "bullets" }> }) {
  return (
    <ul className="list-disc pl-5 space-y-1 text-sm text-[#2e2e2e] marker:text-[#a3a3a3]">
      {block.items.map((item, i) => (
        <li key={i} className="leading-relaxed">
          <Inline text={item} />
        </li>
      ))}
    </ul>
  )
}

function OrderedBlock({ block }: { block: Extract<Block, { type: "ordered" }> }) {
  return (
    <ol className="list-decimal pl-5 space-y-1 text-sm text-[#2e2e2e] marker:text-[#a3a3a3]">
      {block.items.map((item, i) => (
        <li key={i} className="leading-relaxed">
          <Inline text={item} />
        </li>
      ))}
    </ol>
  )
}

function CodeBlock({ block }: { block: Extract<Block, { type: "code" }> }) {
  // Delegate to the Markdown renderer so we get the same syntax highlighting
  // as inline fenced blocks. Build a minimal ``` <lang>\n<code>\n``` source.
  const lang = block.language || ""
  const md = `\`\`\`${lang}\n${block.content}\n\`\`\``
  return <Markdown>{md}</Markdown>
}

function QuoteBlock({ block }: { block: Extract<Block, { type: "quote" }> }) {
  return (
    <blockquote className="border-l-2 border-black/[0.08] pl-3 text-sm text-[#525252] italic">
      <Inline text={block.text} />
    </blockquote>
  )
}

function TableBlock({ block }: { block: Extract<Block, { type: "table" }> }) {
  // Route structured content tables through the existing AiTableWidget so
  // they pick up the shared styling (hover rows, header treatment) and stay
  // consistent with widget tables. The widget shape uses { key, label }
  // columns and keyed row objects; we adapt here so models can emit the
  // simpler string-row form.
  const adapted = {
    type: "table" as const,
    title: block.title,
    columns: block.columns.map((c, i) => ({ key: `c${i}`, label: c })),
    rows: block.rows.map((row) => {
      const obj: Record<string, string> = {}
      row.forEach((cell, i) => { obj[`c${i}`] = cell })
      return obj
    }),
  }
  return <AiTableWidget widget={adapted as unknown as Parameters<typeof AiTableWidget>[0]['widget']} />
}
