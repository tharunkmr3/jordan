"use client"

import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { Plus, PaperPlaneTilt, Microphone, X, FileText, FilePdf, FileDoc, FileXls, FilePpt, Image as ImageIcon, SpeakerHigh } from '@phosphor-icons/react'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader } from '@/components/ui/loader'
import { cn } from '@/lib/utils'
import {
  COMPOSER_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  classifyMimeType,
  isAcceptedMimeType,
  type UploadedAttachment,
  type AttachmentKind,
} from '@/lib/chat-attachments/constants'

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
  /**
   * Called with the typed text and any uploaded attachments when the user
   * hits send. The composer clears its own text/attachment state after a
   * successful submit — parent only needs to dispatch the request.
   */
  onSubmit: (context: { text: string; attachments: UploadedAttachment[] }) => void
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
  /** Called when voice input is toggled. TODO: wire to MediaRecorder. */
  onVoiceToggle?: () => void
  /** Enable the attach button + drag-drop. Default true. */
  attachments?: boolean
  /**
   * Override the upload endpoint. Defaults to /api/chat/attachments; the
   * unauthenticated widget will need its own endpoint later.
   */
  uploadEndpoint?: string
}

/**
 * Local state for an in-flight upload.
 * - pending → selected, upload POST still running
 * - ready   → server returned an UploadedAttachment; safe to send
 * - failed  → surfaced inline on the chip so the user can remove/retry
 */
type ComposerAttachment =
  | { id: string; kind: AttachmentKind; name: string; size: number; status: 'pending'; file: File }
  | { id: string; kind: AttachmentKind; name: string; size: number; status: 'ready'; uploaded: UploadedAttachment }
  | { id: string; kind: AttachmentKind; name: string; size: number; status: 'failed'; error: string }

function clientTempId(): string {
  return Math.random().toString(36).slice(2, 10)
}

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
    onVoiceToggle,
    attachments: attachmentsEnabled = true,
    uploadEndpoint = '/api/chat/attachments',
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }))

  const hasPendingUpload = attachments.some(a => a.status === 'pending')
  const canSubmit = !disabled && !sending && !hasPendingUpload && (value.trim().length > 0 || attachments.some(a => a.status === 'ready'))

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSubmit) doSubmit()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }

  async function uploadFile(file: File) {
    const id = clientTempId()
    const kind = classifyMimeType(file.type || 'application/octet-stream', file.name)
    setAttachments(prev => [
      ...prev,
      { id, kind, name: file.name, size: file.size, status: 'pending', file },
    ])

    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(uploadEndpoint, { method: 'POST', body: fd })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Upload failed (${res.status})`)
      }
      const uploaded = (await res.json()) as UploadedAttachment
      setAttachments(prev => prev.map(a => a.id === id ? {
        id, kind: uploaded.kind, name: uploaded.name, size: uploaded.size, status: 'ready', uploaded,
      } : a))
    } catch (err) {
      setAttachments(prev => prev.map(a => a.id === id ? {
        id, kind, name: file.name, size: file.size, status: 'failed', error: err instanceof Error ? err.message : 'Upload failed',
      } : a))
    }
  }

  function acceptFiles(fileList: FileList | File[] | null) {
    if (!fileList) return
    const files = Array.from(fileList)
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setAttachments(prev => [
          ...prev,
          { id: clientTempId(), kind: 'text', name: file.name, size: file.size, status: 'failed', error: 'File too large (>25MB)' },
        ])
        continue
      }
      if (!isAcceptedMimeType(file.type || '', file.name)) {
        setAttachments(prev => [
          ...prev,
          { id: clientTempId(), kind: 'text', name: file.name, size: file.size, status: 'failed', error: 'Unsupported file type' },
        ])
        continue
      }
      void uploadFile(file)
    }
  }

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFiles(e.target.files)
    e.target.value = '' // allow picking the same file twice in a row
  }

  function removeAttachment(id: string) {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  function doSubmit() {
    if (!canSubmit) return
    const ready = attachments
      .filter(a => a.status === 'ready')
      .map(a => (a as Extract<ComposerAttachment, { status: 'ready' }>).uploaded)
    onSubmit({ text: value, attachments: ready })
    // Composer owns these concerns — clear text + attachments after send.
    onChange('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!attachmentsEnabled || disabled) return
    e.preventDefault()
    setDragActive(false)
    acceptFiles(e.dataTransfer.files)
  }

  return (
    <div
      onDragOver={(e) => {
        if (!attachmentsEnabled || disabled) return
        e.preventDefault()
        if (!dragActive) setDragActive(true)
      }}
      onDragLeave={(e) => {
        // Only dismiss when leaving the outer card, not moving between children.
        if (e.currentTarget === e.target) setDragActive(false)
      }}
      onDrop={onDrop}
      className={cn(
        'relative rounded-2xl border border-black/[0.06] bg-white',
        'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_-2px_rgba(0,0,0,0.04)]',
        'focus-within:border-black/[0.12] transition-colors',
        dragActive && 'border-[#F4511E]/50 ring-2 ring-[#F4511E]/20',
        disabled && 'opacity-60',
        className,
      )}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[#FFF4EE]/80">
          <span className="text-[13px] font-medium text-[#F4511E]">Drop file to attach</span>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {attachments.map(a => (
            <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
          ))}
        </div>
      )}

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
        {attachmentsEnabled && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={COMPOSER_ACCEPT}
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
          </>
        )}

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
          onClick={doSubmit}
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

function AttachmentKindIcon({ kind, size = 14 }: { kind: AttachmentKind; size?: number }) {
  switch (kind) {
    case 'image': return <ImageIcon size={size} weight="fill" />
    case 'audio': return <SpeakerHigh size={size} weight="fill" />
    case 'pdf':   return <FilePdf size={size} weight="fill" />
    case 'docx':  return <FileDoc size={size} weight="fill" />
    case 'xlsx':  return <FileXls size={size} weight="fill" />
    case 'pptx':  return <FilePpt size={size} weight="fill" />
    case 'markdown':
    case 'text':
    default:      return <FileText size={size} weight="fill" />
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment
  onRemove: () => void
}) {
  const isFailed = attachment.status === 'failed'
  const isPending = attachment.status === 'pending'
  return (
    <div
      className={cn(
        'group/chip relative flex items-center gap-2 max-w-[240px] rounded-lg px-2 py-1.5 text-[12px]',
        isFailed
          ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
          : 'bg-[#f5f5f5] text-[#2e2e2e] ring-1 ring-black/[0.04]',
      )}
    >
      <span className={cn('flex-shrink-0', isFailed ? 'text-red-500' : 'text-[#737373]')}>
        {isPending
          ? <Loader variant="circular" size="sm" />
          : <AttachmentKindIcon kind={attachment.kind} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{attachment.name}</div>
        <div className={cn('truncate text-[10px]', isFailed ? 'text-red-500' : 'text-[#a3a3a3]')}>
          {isFailed
            ? attachment.error
            : isPending
              ? 'Uploading…'
              : formatBytes(attachment.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded-full text-[#a3a3a3] hover:bg-black/5 hover:text-[#2e2e2e] transition-colors"
        aria-label="Remove attachment"
      >
        <X size={11} weight="bold" />
      </button>
    </div>
  )
}
