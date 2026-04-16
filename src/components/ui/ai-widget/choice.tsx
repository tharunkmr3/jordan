"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { ChoiceWidget } from "@/lib/ui-widgets/schemas"
import { useAiWidgetSubmit } from "./context"

export function AiChoiceWidget({ widget }: { widget: ChoiceWidget }) {
  const { submit, disabled } = useAiWidgetSubmit()
  const [picked, setPicked] = useState<string | null>(null)
  const locked = disabled || picked !== null

  const choose = (value: string, label: string) => {
    if (locked) return
    setPicked(value)
    submit(label, { _widget: "choice", value })
  }

  return (
    <div className="space-y-2">
      {(widget.title || widget.description) && (
        <div className="space-y-0.5 px-0.5">
          {widget.title && <div className="text-sm font-medium text-[#2e2e2e]">{widget.title}</div>}
          {widget.description && <p className="text-xs text-[#737373]">{widget.description}</p>}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {widget.options.map((o) => {
          const isPicked = picked === o.value
          return (
            <button
              key={o.value}
              type="button"
              disabled={locked}
              onClick={() => choose(o.value, o.label)}
              className={cn(
                "text-left rounded-xl px-3.5 py-2.5 text-[13px] ring-1 transition-colors",
                isPicked
                  ? "ring-[#F4511E] bg-[#FFF4EE] text-[#2e2e2e]"
                  : locked
                    ? "ring-black/[0.04] bg-white text-[#a3a3a3]"
                    : "ring-black/[0.04] bg-white text-[#2e2e2e] hover:bg-[#fafafa]",
              )}
            >
              <div className="font-medium">{o.label}</div>
              {o.description && <div className="text-[12px] text-[#737373] mt-0.5">{o.description}</div>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
