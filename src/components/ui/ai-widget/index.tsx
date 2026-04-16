"use client"

import { parseWidget, type Widget } from "@/lib/ui-widgets/schemas"
import { AiFormWidget } from "./form"
import { AiConfirmWidget } from "./confirm"
import { AiChoiceWidget } from "./choice"
import { AiCardWidget } from "./card"
import { AiTableWidget } from "./table"

export { AiWidgetProvider, useAiWidgetSubmit, type AiWidgetSubmitFn } from "./context"

/**
 * Entry point for rendering a `ui` code block from a markdown response.
 *
 * Given the raw string inside the fenced block, parse it against our
 * Zod union schema. If it validates, dispatch to the matching component.
 * Anything invalid falls back to a plain `<pre>` so the user sees the
 * raw JSON rather than a crash — useful when the model is still
 * learning the shape.
 */
export function AiWidget({ source }: { source: string }) {
  const widget = parseWidget(source)
  if (!widget) return <RawBlock source={source} />
  return <AiWidgetBody widget={widget} />
}

function AiWidgetBody({ widget }: { widget: Widget }) {
  switch (widget.type) {
    case "form":
      return <AiFormWidget widget={widget} />
    case "confirm":
      return <AiConfirmWidget widget={widget} />
    case "choice":
      return <AiChoiceWidget widget={widget} />
    case "card":
      return <AiCardWidget widget={widget} />
    case "table":
      return <AiTableWidget widget={widget} />
  }
}

function RawBlock({ source }: { source: string }) {
  return (
    <pre className="rounded-lg bg-[#fafafa] ring-1 ring-black/[0.04] p-3 text-[11px] font-mono text-[#525252] overflow-x-auto">
      <span className="text-[#a3a3a3] block mb-1">Invalid `ui` block — falling back to raw JSON:</span>
      {source}
    </pre>
  )
}
