"use client"

import { forwardRef, useImperativeHandle, useRef } from 'react'
import { Plus, PaperPlaneTilt, Microphone } from '@phosphor-icons/react'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Shared composer used by every chat surface:
//   - Agent settings Test Chat panel
//   - Inbox internal-agent new-chat hero
//   - Inbox internal-agent active chat input
//   - Inbox customer-facing reply input
//
// API is intentionally minimal. Attachments + voice input are stubs for
// now (buttons render but don't do anything); they'll light up when the
// upload + transcribe infrastructure lands in follow-up PRs.
// ---------------------------------------------------------------------------

export interface ModelOption {
  value: string
  label: string
}

export interface AiComposerHandle {
  focus: () => void
}

export interface AiComposerProps {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  disabled?: boolean
  sending?: boolean
  placeholder?: string
  /** Extra classes on the outer card. Use for layout / width tweaks. */
  className?: string
  /** Rows the textarea starts with; grows to a max internally. */
  minRows?: number
  /** Visual variant — hero is larger (new-chat landing), inline is compact (active chat). */
  variant?: 'hero' | 'inline'
  /**
   * Model picker (internal chats only). Omit for customer-facing where the
   * model is the agent's configured one and operators shouldn't change it.
   */
  model?: {
    value: string
    options: ModelOption[]
    onChange: (next: string) => void
  }
  /** Render extra controls in the top-left area (e.g. mode switches). */
  leadingSlot?: React.ReactNode
  /** Render extra controls in the top-right area (e.g. custom actions). */
  trailingSlot?: React.ReactNode
  /** Called when a file is selected via the + menu. TODO: wire to upload. */
  onAttach?: (files: File[]) => void
  /** Called when voice input is toggled. TODO: wire to MediaRecorder. */
  onVoiceToggle?: () => void
  /** Accepted file types for the attach picker. */
  acceptFiles?: string
}

const DEFAULT_ACCEPT = [
  'image/*',
  'audio/*',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/plain',
  'text/markdown',
  '.md',
  '.markdown',
].join(',')

export const AiComposer = forwardRef<AiComposerHandle, AiComposerProps>(function AiComposer(
  {
    value,
    onChange,
    onSubmit,
    disabled = false,
    sending = false,
    placeholder = 'Ask anything',
    className,
    minRows = 2,
    variant = 'inline',
    model,
    leadingSlot,
    trailingSlot,
    onAttach,
    onVoiceToggle,
    acceptFiles = DEFAULT_ACCEPT,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }))

  const canSubmit = !disabled && !sending && value.trim().length > 0

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSubmit) onSubmit()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    onAttach?.(files)
    // Reset so picking the same file twice in a row fires onChange again.
    e.target.value = ''
  }

  return (
    <div
      className={cn(
        'rounded-2xl border border-black/[0.06] bg-white',
        'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_-2px_rgba(0,0,0,0.04)]',
        'focus-within:border-black/[0.12] transition-colors',
        disabled && 'opacity-60',
        className,
      )}
    >
      <Textarea
        ref={textareaRef}
        placeholder={placeholder}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={minRows}
        className={cn(
          'resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:border-0 shadow-none',
          variant === 'hero'
            ? 'min-h-[88px] px-4 pt-3.5 pb-2 text-[14px] leading-relaxed'
            : 'min-h-[44px] px-3.5 pt-2.5 pb-1 text-[13px] leading-relaxed',
        )}
      />

      {/* Action row: leading (+, voice, slots) | trailing (model, slots, send) */}
      <div
        className={cn(
          'flex items-center gap-1',
          variant === 'hero' ? 'px-3 pb-3' : 'px-2.5 pb-2',
        )}
      >
        {/* Attach */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={acceptFiles}
          className="hidden"
          onChange={handleFilePicked}
        />
        <ComposerIconButton
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title="Attach file"
          aria-label="Attach file"
        >
          <Plus size={14} weight="bold" />
        </ComposerIconButton>

        {/* Voice */}
        <ComposerIconButton
          onClick={() => onVoiceToggle?.()}
          disabled={disabled}
          title="Voice input"
          aria-label="Voice input"
        >
          <Microphone size={14} weight="bold" />
        </ComposerIconButton>

        {leadingSlot}

        <div className="flex-1" />

        {trailingSlot}

        {/* Model picker (internal only) */}
        {model && model.options.length > 0 && (
          <Select
            value={model.value}
            onValueChange={(v) => v && model.onChange(String(v))}
            disabled={disabled}
          >
            <SelectTrigger className="h-7 min-w-[140px] rounded-full border-black/[0.06] bg-white text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {model.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Send */}
        <button
          type="button"
          onClick={() => { if (canSubmit) onSubmit() }}
          disabled={!canSubmit}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
            canSubmit
              ? 'bg-[#2e2e2e] text-white hover:bg-black'
              : 'bg-[#ebebeb] text-[#a3a3a3]',
          )}
          title="Send"
          aria-label="Send message"
        >
          <PaperPlaneTilt size={13} weight="fill" />
        </button>
      </div>
    </div>
  )
})

function ComposerIconButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-full text-[#737373] transition-colors',
        'hover:bg-[#f5f5f5] disabled:opacity-50 disabled:hover:bg-transparent',
        rest.className,
      )}
    >
      {children}
    </button>
  )
}
