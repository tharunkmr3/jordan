"use client"

/**
 * ChainOfThought — collapsible reasoning timeline, prompt-kit compatible.
 *
 * A ChainOfThought contains one or more ChainOfThoughtSteps. Each step has
 * a Trigger (always visible, clickable) and Content (the detail reveal).
 * Clicking the trigger toggles the step open/closed. The last step is
 * shown "active" — an orange pulsing dot on the rail.
 *
 * Styled to match the rest of Jordon's surfaces: subtle left rail, dark
 * grey trigger text, inline item bullets, opens with a gentle height
 * transition.
 */

import { createContext, useCallback, useContext, useId, useMemo, useState } from "react"
import { CaretDown } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Root context — tracks which step keys are expanded
// ---------------------------------------------------------------------------

interface ChainContextValue {
  isOpen: (key: string) => boolean
  toggle: (key: string) => void
  lastStepKey: string | null
  registerStep: (key: string) => void
}

const ChainContext = createContext<ChainContextValue | null>(null)

function useChain() {
  const ctx = useContext(ChainContext)
  if (!ctx) throw new Error("ChainOfThought sub-components must be used inside <ChainOfThought>")
  return ctx
}

// ---------------------------------------------------------------------------
// <ChainOfThought> root
// ---------------------------------------------------------------------------

export interface ChainOfThoughtProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Start with every step open rather than the default of every step closed. */
  defaultOpen?: boolean
}

export function ChainOfThought({
  children,
  className,
  defaultOpen = false,
  ...rest
}: ChainOfThoughtProps) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())
  const [allKeys, setAllKeys] = useState<string[]>([])

  const registerStep = useCallback((key: string) => {
    setAllKeys(prev => (prev.includes(key) ? prev : [...prev, key]))
    if (defaultOpen) setOpenKeys(prev => new Set(prev).add(key))
  }, [defaultOpen])

  const toggle = useCallback((key: string) => {
    setOpenKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const isOpen = useCallback((key: string) => openKeys.has(key), [openKeys])

  const value = useMemo<ChainContextValue>(
    () => ({ isOpen, toggle, lastStepKey: allKeys[allKeys.length - 1] ?? null, registerStep }),
    [isOpen, toggle, allKeys, registerStep],
  )

  return (
    <ChainContext.Provider value={value}>
      <div className={cn("relative flex flex-col gap-0", className)} {...rest}>
        {children}
      </div>
    </ChainContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// <ChainOfThoughtStep>
// ---------------------------------------------------------------------------

const StepContext = createContext<string | null>(null)

export function ChainOfThoughtStep({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  const key = useId()
  const { registerStep, lastStepKey } = useChain()

  // Register on first render so ChainContext knows about this step.
  // useMemo runs synchronously during render which is what we want.
  useMemo(() => { registerStep(key) }, [key, registerStep])

  const isLast = lastStepKey === key
  return (
    <StepContext.Provider value={key}>
      <div
        data-last={isLast || undefined}
        className={cn("relative pl-5", className)}
        {...rest}
      >
        {/* Vertical rail */}
        <span className="absolute left-[5px] top-3 bottom-0 w-px bg-black/[0.08]" aria-hidden />
        {/* Dot marker */}
        <span
          className={cn(
            "absolute left-0 top-2 h-[11px] w-[11px] rounded-full border-2 border-white",
            isLast ? "bg-[#F4511E] animate-pulse" : "bg-[#a3a3a3]",
          )}
          aria-hidden
        />
        {children}
      </div>
    </StepContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// <ChainOfThoughtTrigger>
// ---------------------------------------------------------------------------

export interface ChainOfThoughtTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * When true, render as a plain label with no caret and no click
   * behaviour — for steps that don't have any expandable content.
   * Avoids showing a chevron that does nothing.
   */
  collapsible?: boolean
}

export function ChainOfThoughtTrigger({
  children,
  className,
  collapsible = true,
  ...rest
}: ChainOfThoughtTriggerProps) {
  const stepKey = useContext(StepContext)
  const { isOpen, toggle } = useChain()
  if (!stepKey) throw new Error("<ChainOfThoughtTrigger> must be inside <ChainOfThoughtStep>")

  const open = isOpen(stepKey)

  if (!collapsible) {
    return (
      <div
        className={cn(
          "flex w-full items-center gap-1.5 py-1 text-left text-[13px] font-medium text-[#2e2e2e]",
          className,
        )}
      >
        <span className="flex-1 truncate">{children}</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => toggle(stepKey)}
      aria-expanded={open}
      className={cn(
        "group flex w-full items-center gap-1.5 py-1 text-left text-[13px] font-medium text-[#2e2e2e] transition-colors hover:text-[#2e2e2e]/70",
        className,
      )}
      {...rest}
    >
      <span className="flex-1 truncate">{children}</span>
      <CaretDown
        size={12}
        weight="bold"
        className={cn("flex-shrink-0 text-[#a3a3a3] transition-transform", open && "rotate-180")}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// <ChainOfThoughtContent>
// ---------------------------------------------------------------------------

export function ChainOfThoughtContent({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  const stepKey = useContext(StepContext)
  const { isOpen } = useChain()
  if (!stepKey) throw new Error("<ChainOfThoughtContent> must be inside <ChainOfThoughtStep>")

  const open = isOpen(stepKey)
  return (
    <div
      data-state={open ? "open" : "closed"}
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
      {...rest}
    >
      <div className="overflow-hidden">
        <div className="pb-2 pt-0.5 flex flex-col gap-0.5">{children}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// <ChainOfThoughtItem>
// ---------------------------------------------------------------------------

export function ChainOfThoughtItem({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("text-[12px] leading-relaxed text-[#525252]", className)}
      {...rest}
    >
      {children}
    </div>
  )
}
