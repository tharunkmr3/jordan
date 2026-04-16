"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { FormWidget } from "@/lib/ui-widgets/schemas"
import { useAiWidgetSubmit } from "./context"

/**
 * Generative `form` widget — renders when the agent emits
 * ```ui { "type": "form", "fields": [...] }```.
 *
 * Submitting posts two things back to the agent:
 *   - a human-readable chat bubble ("title: Quarterly sync, email: …")
 *   - the raw payload object so the model can key on exact values
 *
 * Disabled state: widgets in older messages become read-only; the
 * provider controls that. Prevents users from re-submitting the
 * first turn's form after they've moved on.
 */
export function AiFormWidget({ widget }: { widget: FormWidget }) {
  const { submit, disabled } = useAiWidgetSubmit()
  const [sent, setSent] = useState(false)

  // Initial values derived from each field's `default` (text / number /
  // select / boolean all supported). Memoized because the widget spec
  // never changes after first render.
  const initialValues = useMemo<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {}
    for (const f of widget.fields) {
      if ("default" in f && f.default !== undefined) v[f.name] = f.default
      else if (f.type === "boolean") v[f.name] = false
      else if (f.type === "number") v[f.name] = ""
      else v[f.name] = ""
    }
    return v
  }, [widget.fields])

  const [values, setValues] = useState<Record<string, unknown>>(initialValues)

  const locked = disabled || sent

  function update(name: string, next: unknown) {
    setValues((prev) => ({ ...prev, [name]: next }))
  }

  function handleSubmit() {
    // Minimal required-field check. We intentionally don't do deep
    // validation here — the agent will ask again if something's off.
    for (const f of widget.fields) {
      if (!f.required) continue
      const v = values[f.name]
      if (v === "" || v === null || v === undefined) return
    }

    // Human-readable bubble: one line per filled field.
    const lines = widget.fields
      .map((f) => {
        const v = values[f.name]
        if (v === "" || v === null || v === undefined) return null
        return `${f.label}: ${String(v)}`
      })
      .filter(Boolean) as string[]
    const actionHint = widget.submit.action ? ` (action: ${widget.submit.action})` : ""
    const bubble = lines.length > 0 ? lines.join("\n") + actionHint : `Submitted${actionHint}`

    const payload: Record<string, unknown> = { ...values, _widget: "form" }
    if (widget.submit.action) payload._action = widget.submit.action

    setSent(true)
    submit(bubble, payload)
  }

  return (
    <div className="rounded-xl bg-white ring-1 ring-black/[0.04] p-4 space-y-3 text-[13px]">
      {(widget.title || widget.description) && (
        <div className="space-y-0.5">
          {widget.title && <div className="text-sm font-semibold text-[#2e2e2e]">{widget.title}</div>}
          {widget.description && <p className="text-xs text-[#737373]">{widget.description}</p>}
        </div>
      )}

      <div className="space-y-2.5">
        {widget.fields.map((f) => {
          const value = values[f.name]
          const id = `w-${f.name}`
          const labelEl = (
            <Label htmlFor={id} className="text-[12px] font-medium text-[#525252]">
              {f.label}
              {f.required && <span className="text-[#F4511E] ml-0.5">*</span>}
            </Label>
          )

          if (f.type === "textarea") {
            return (
              <div key={f.name} className="space-y-1">
                {labelEl}
                <Textarea
                  id={id}
                  rows={f.rows ?? 3}
                  placeholder={f.placeholder}
                  value={String(value ?? "")}
                  disabled={locked}
                  onChange={(e) => update(f.name, e.target.value)}
                  className="text-[13px]"
                />
                {f.description && <p className="text-[11px] text-[#a3a3a3]">{f.description}</p>}
              </div>
            )
          }

          if (f.type === "number") {
            return (
              <div key={f.name} className="space-y-1">
                {labelEl}
                <Input
                  id={id}
                  type="number"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  placeholder={f.placeholder}
                  value={value === "" ? "" : String(value ?? "")}
                  disabled={locked}
                  onChange={(e) => {
                    const n = e.target.value === "" ? "" : Number(e.target.value)
                    update(f.name, n)
                  }}
                  className="text-[13px]"
                />
                {f.description && <p className="text-[11px] text-[#a3a3a3]">{f.description}</p>}
              </div>
            )
          }

          if (f.type === "select") {
            return (
              <div key={f.name} className="space-y-1">
                {labelEl}
                <Select
                  value={String(value ?? "")}
                  onValueChange={(v) => v && update(f.name, String(v))}
                  disabled={locked}
                >
                  <SelectTrigger className="text-[13px]">
                    <SelectValue placeholder={f.placeholder ?? "Select"} />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {f.description && <p className="text-[11px] text-[#a3a3a3]">{f.description}</p>}
              </div>
            )
          }

          if (f.type === "boolean") {
            return (
              <div key={f.name} className="flex items-center justify-between gap-3">
                <div>
                  {labelEl}
                  {f.description && <p className="text-[11px] text-[#a3a3a3]">{f.description}</p>}
                </div>
                <Switch
                  checked={Boolean(value)}
                  disabled={locked}
                  onCheckedChange={(v) => update(f.name, v)}
                />
              </div>
            )
          }

          // text / email / url fallback
          return (
            <div key={f.name} className="space-y-1">
              {labelEl}
              <Input
                id={id}
                type={f.type ?? "text"}
                placeholder={f.placeholder}
                value={String(value ?? "")}
                disabled={locked}
                onChange={(e) => update(f.name, e.target.value)}
                className="text-[13px]"
              />
              {f.description && <p className="text-[11px] text-[#a3a3a3]">{f.description}</p>}
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        {widget.cancel && (
          <Button
            variant="secondary"
            size="sm"
            disabled={locked}
            onClick={() => {
              setSent(true)
              submit(widget.cancel!.label)
            }}
          >
            {widget.cancel.label}
          </Button>
        )}
        <Button size="sm" onClick={handleSubmit} disabled={locked}>
          {sent ? "Sent" : widget.submit.label}
        </Button>
      </div>
    </div>
  )
}
