"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { CardWidget } from "@/lib/ui-widgets/schemas"
import { useAiWidgetSubmit } from "./context"

export function AiCardWidget({ widget }: { widget: CardWidget }) {
  const { submit, disabled } = useAiWidgetSubmit()
  const [clicked, setClicked] = useState(false)
  const locked = disabled || clicked

  return (
    <div className="rounded-xl bg-white ring-1 ring-black/[0.04] p-4 space-y-3 text-[13px]">
      <div className="space-y-0.5">
        <div className="text-sm font-semibold text-[#2e2e2e]">{widget.title}</div>
        {widget.subtitle && <p className="text-xs text-[#737373]">{widget.subtitle}</p>}
      </div>
      {widget.fields && widget.fields.length > 0 && (
        <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          {widget.fields.map((f, i) => (
            <div key={i} className="contents">
              <dt className="text-[#737373]">{f.label}</dt>
              <dd className="text-[#2e2e2e]">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {widget.action && (
        <div className="flex justify-end pt-1">
          <Button
            size="sm"
            variant={widget.action.variant === "destructive" ? "destructive" : widget.action.variant === "secondary" ? "secondary" : "default"}
            disabled={locked}
            onClick={() => {
              setClicked(true)
              submit(widget.action!.value, { _widget: "card", action: widget.action!.value })
            }}
          >
            {widget.action.label}
          </Button>
        </div>
      )}
    </div>
  )
}
