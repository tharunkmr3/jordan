"use client"

import { useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { CardWidget } from "@/lib/ui-widgets/schemas"
import { useAiWidgetSubmit } from "./context"

/**
 * Detect whether an action's `value` is a URL the user should navigate
 * to in a new tab, as opposed to an intent string to submit back to
 * the agent. Agents frequently populate the action with a link (e.g.
 * a Google Calendar event URL after creating an event) and expect
 * the button to navigate; the old default of always submitting as chat
 * turned that into "echo the URL back to the agent", which is nonsense.
 *
 * Conservative on purpose: only `http://` / `https://` / `mailto:` /
 * `tel:` are treated as links. Anything else (including "confirm",
 * "delete", "event_123") stays as a chat submission so intent-based
 * actions keep working.
 */
function isNavigableUrl(value: string): boolean {
  if (!value) return false
  return /^(https?|mailto|tel):/i.test(value.trim())
}

export function AiCardWidget({ widget }: { widget: CardWidget }) {
  const { submit, disabled } = useAiWidgetSubmit()
  const [clicked, setClicked] = useState(false)
  const locked = disabled || clicked

  const actionIsLink = widget.action ? isNavigableUrl(widget.action.value) : false

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
          {actionIsLink ? (
            // URL actions: render as a real <a> styled like a Button so
            // middle-click / cmd-click / new-tab behaviour all work natively.
            // Not clamped by the "clicked" state — following a link is
            // idempotent and users may want to revisit (unlike a
            // destructive chat submit).
            <a
              href={widget.action.value}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                buttonVariants({
                  variant: widget.action.variant === "destructive"
                    ? "destructive"
                    : widget.action.variant === "secondary" ? "secondary" : "default",
                  size: "sm",
                }),
              )}
            >
              {widget.action.label}
            </a>
          ) : (
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
          )}
        </div>
      )}
    </div>
  )
}
