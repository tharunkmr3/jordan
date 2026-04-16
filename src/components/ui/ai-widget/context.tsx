"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"

/**
 * Chat surfaces (agent settings test chat, inbox internal chat, widget
 * embed) each have their own send-message function. A generative UI
 * widget deep inside a rendered message doesn't know which surface
 * it's in — so we hand it a `submit` function through React context.
 *
 * Each chat surface wraps its message list in <AiWidgetProvider submit={...}>
 * and inside widgets call useAiWidgetSubmit() to get the function.
 * Submitting posts the user's filled values back as the next user
 * message, kicking off another agent turn.
 */

export interface AiWidgetSubmitFn {
  /**
   * Send the widget's result back to the agent as a new user message.
   *
   * @param message  The primary user-visible message (shown in the chat bubble).
   * @param payload  Optional structured JSON payload appended to the message
   *                 so the model has exact values to key on, while the bubble
   *                 stays human-readable.
   */
  (message: string, payload?: Record<string, unknown>): void
}

interface AiWidgetContextValue {
  submit: AiWidgetSubmitFn
  /** Disables interaction on widgets in old messages (only the latest turn should be actionable). */
  disabled?: boolean
}

const AiWidgetContext = createContext<AiWidgetContextValue | null>(null)

export function AiWidgetProvider({
  submit,
  disabled,
  children,
}: {
  submit: AiWidgetSubmitFn
  disabled?: boolean
  children: ReactNode
}) {
  const value = useMemo(() => ({ submit, disabled }), [submit, disabled])
  return <AiWidgetContext.Provider value={value}>{children}</AiWidgetContext.Provider>
}

export function useAiWidgetSubmit(): AiWidgetContextValue {
  const ctx = useContext(AiWidgetContext)
  if (!ctx) {
    // Fallback for storybook / isolated renders — widgets render but
    // clicking does nothing. Logs a dev-only warning.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[ai-widget] rendered outside <AiWidgetProvider>. Submit actions are inert.")
    }
    return { submit: () => {}, disabled: true }
  }
  return ctx
}
