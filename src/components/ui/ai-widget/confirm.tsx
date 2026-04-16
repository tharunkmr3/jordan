"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { ConfirmWidget } from "@/lib/ui-widgets/schemas"
import { useAiWidgetSubmit } from "./context"

export function AiConfirmWidget({ widget }: { widget: ConfirmWidget }) {
  const { submit, disabled } = useAiWidgetSubmit()
  const [chosen, setChosen] = useState<string | null>(null)
  const locked = disabled || chosen !== null

  const handle = (picked: "confirm" | "cancel") => {
    if (locked) return
    const spec = picked === "confirm" ? widget.confirm : widget.cancel
    if (!spec) return
    setChosen(picked)
    submit(spec.value ?? spec.label, { _widget: "confirm", choice: picked })
  }

  return (
    <div className="rounded-xl bg-white ring-1 ring-black/[0.04] p-4 space-y-3 text-[13px]">
      {widget.title && <div className="text-sm font-semibold text-[#2e2e2e]">{widget.title}</div>}
      <p className="text-[13px] text-[#525252] leading-relaxed whitespace-pre-wrap">{widget.message}</p>
      <div className="flex items-center justify-end gap-2 pt-1">
        {widget.cancel && (
          <Button variant="secondary" size="sm" disabled={locked} onClick={() => handle("cancel")}>
            {widget.cancel.label}
          </Button>
        )}
        <Button
          size="sm"
          variant={widget.confirm.variant === "destructive" ? "destructive" : "default"}
          disabled={locked}
          onClick={() => handle("confirm")}
        >
          {chosen === "confirm" ? "Sent" : widget.confirm.label}
        </Button>
      </div>
    </div>
  )
}
