"use client"

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Plus, PaperPlaneTilt, Microphone, X, FileText, FilePdf, FileDoc, FileXls, FilePpt, Image as ImageIcon, SpeakerHigh, BookOpenText, Stop } from '@phosphor-icons/react'
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

export interface KbReference {
  id: string
  name: string
  kbName: string
}

export interface AiComposerProps {
  value: string
  onChange: (next: string) => void
  /**
   * Called with the typed text, uploaded attachments, and any KB docs the
   * user pinned with @-mention when the user hits send. Composer clears
   * its own text/attachment/reference state after a successful submit —
   * parent only needs to dispatch the request.
   */
  onSubmit: (context: { text: string; attachments: UploadedAttachment[]; kbReferenceIds: string[] }) => void
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
  /**
   * Called when the user clicks the send button while `sending` is true.
   * Enables the stop-generation UX — the send button turns into a stop
   * button (black square) as soon as the stream starts. Parent is
   * responsible for aborting the in-flight request (typically via an
   * AbortController) and clearing `sending`. Omit to keep the old
   * behaviour where the button just disables while sending.
   */
  onStop?: () => void
  /** Enable the attach button + drag-drop. Default true. */
  attachments?: boolean
  /**
   * Override the upload endpoint. Defaults to /api/chat/attachments; the
   * unauthenticated widget will need its own endpoint later.
   */
  uploadEndpoint?: string
  /**
   * Enable @-mention to reference knowledge-base files. When true the
   * composer lazily fetches /api/knowledge-base/files on the first @ and
   * opens a picker; selections become pinned chips (separate from upload
   * attachments) and are emitted as kbReferenceIds on submit. Default
   * true; disable for public widget surfaces.
   */
  knowledgeMentions?: boolean
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

interface KbFile {
  id: string
  name: string
  kb_id: string
  kb_name: string
  char_count: number
}

function clientTempId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Browsers disagree on supported MIME types for MediaRecorder — pick the
 * best match. Chrome + Firefox back webm/opus; Safari backs mp4/aac.
 * Returning undefined lets the recorder pick its own default (required
 * on older iOS Safari).
 */
function pickSupportedMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return undefined
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
    onStop,
    attachments: attachmentsEnabled = true,
    uploadEndpoint = '/api/chat/attachments',
    knowledgeMentions = true,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  // @-mention state. `mention` is non-null while the textarea cursor sits
  // inside an active @query token; nulling it closes the popover.
  // `mentionFiles` caches the KB file list (fetched once per session);
  // `mentionHighlight` is the keyboard-highlighted row.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [mentionFiles, setMentionFiles] = useState<KbFile[] | null>(null)
  const [mentionHighlight, setMentionHighlight] = useState(0)
  const [kbReferences, setKbReferences] = useState<KbReference[]>([])
  /**
   * Voice input state:
   *   idle        → mic button enabled, normal styling
   *   recording   → recording in progress, mic button red+pulsing
   *   transcribing→ upload+whisper round-trip underway
   *   failed      → brief red flash if perms denied or transcription fails
   */
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing' | 'failed'>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recorderChunksRef = useRef<Blob[]>([])
  const recorderStreamRef = useRef<MediaStream | null>(null)

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }))

  const hasPendingUpload = attachments.some(a => a.status === 'pending')
  const canSubmit = !disabled && !sending && !hasPendingUpload && (
    value.trim().length > 0
    || attachments.some(a => a.status === 'ready')
    || kbReferences.length > 0
  )

  // Fetch KB file list once, the first time the user opens an @ mention.
  // Kept in a ref-gated state so repeated opens reuse the same array.
  async function ensureMentionFiles() {
    if (mentionFiles !== null) return
    try {
      const res = await fetch('/api/knowledge-base/files')
      if (!res.ok) { setMentionFiles([]); return }
      const data = await res.json() as KbFile[]
      setMentionFiles(data)
    } catch {
      setMentionFiles([])
    }
  }

  /**
   * Scan backwards from the cursor to figure out whether the user is inside
   * an @ token. A token is @<alnum-or-space-dot-dash-underscore> up to 60
   * chars, bounded on the left by start-of-string or whitespace. Matching a
   * token opens the popover; leaving the token (space-after-query, moving
   * the cursor, deleting past the @) closes it.
   */
  function detectMention(text: string, cursor: number): { query: string; start: number } | null {
    if (!knowledgeMentions) return null
    const before = text.slice(0, cursor)
    const match = before.match(/(?:^|\s)@([\w .\-_/]{0,60})$/)
    if (!match) return null
    const query = match[1] ?? ''
    const start = before.length - query.length - 1 // index of '@'
    return { query, start }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // @-mention navigation takes priority when the popover is open so Enter
    // selects a file instead of sending, and Up/Down move the highlight.
    if (mention && mentionFiles && filteredMentionFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionHighlight((h) => (h + 1) % filteredMentionFiles.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionHighlight((h) => (h - 1 + filteredMentionFiles.length) % filteredMentionFiles.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const pick = filteredMentionFiles[mentionHighlight]
        if (pick) selectMention(pick)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSubmit) doSubmit()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    onChange(next)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'

    if (knowledgeMentions) {
      const m = detectMention(next, el.selectionStart ?? next.length)
      if (m) {
        setMention(m)
        setMentionHighlight(0)
        void ensureMentionFiles()
      } else if (mention) {
        setMention(null)
      }
    }
  }

  function selectMention(file: KbFile) {
    if (!mention) return
    // Replace "@query" (from mention.start up to the current cursor) with
    // nothing — the chip below the textarea carries the reference. Avoids
    // leaving "@filename" inline which would then be sent literally.
    const el = textareaRef.current
    const cursor = el?.selectionStart ?? value.length
    const next = value.slice(0, mention.start) + value.slice(cursor)
    onChange(next)
    setMention(null)
    // De-dupe: skip if this file is already pinned.
    setKbReferences((prev) => {
      if (prev.some((r) => r.id === file.id)) return prev
      return [...prev, { id: file.id, name: file.name, kbName: file.kb_name }]
    })
    // Restore focus + cursor to where the @ used to be.
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.selectionStart = mention.start
      el.selectionEnd = mention.start
    })
  }

  function removeKbReference(id: string) {
    setKbReferences((prev) => prev.filter((r) => r.id !== id))
  }

  // Filter + sort the KB file list for the popover using a simple case-
  // insensitive substring match. Kept inline since the list is capped at
  // 500 server-side and the user types interactively.
  const filteredMentionFiles: KbFile[] = (() => {
    if (!mention || !mentionFiles) return []
    const q = mention.query.trim().toLowerCase()
    if (!q) return mentionFiles.slice(0, 8)
    return mentionFiles
      .filter((f) => f.name.toLowerCase().includes(q) || f.kb_name.toLowerCase().includes(q))
      .slice(0, 8)
  })()

  // Clicking outside the textarea/popover closes the popover cleanly.
  useEffect(() => {
    if (!mention) return
    const handler = (e: MouseEvent) => {
      const el = textareaRef.current
      if (!el) return
      if (el.contains(e.target as Node)) return
      const pop = document.getElementById('ai-composer-mention-popover')
      if (pop && pop.contains(e.target as Node)) return
      setMention(null)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [mention])

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
    onSubmit({ text: value, attachments: ready, kbReferenceIds: kbReferences.map((r) => r.id) })
    // Composer owns these concerns — clear text, attachments, and KB refs
    // after send.
    onChange('')
    setAttachments([])
    setKbReferences([])
    setMention(null)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!attachmentsEnabled || disabled) return
    e.preventDefault()
    setDragActive(false)
    acceptFiles(e.dataTransfer.files)
  }

  /**
   * Toggle voice recording. First click prompts mic permission + starts
   * recording. Second click stops, uploads the WebM blob to the upload
   * endpoint (which transcribes via Whisper), and drops the transcript
   * into the composer textarea — user can edit before sending. We
   * intentionally don't auto-send so transcription errors are catchable.
   */
  async function handleVoiceToggle() {
    onVoiceToggle?.()
    if (disabled || sending) return

    if (voiceState === 'recording') {
      // Stop — onstop handler does the upload.
      recorderRef.current?.stop()
      return
    }

    if (voiceState === 'transcribing') return // no-op while uploading

    // Start a new recording.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recorderStreamRef.current = stream
      const mimeType = pickSupportedMime()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      recorderChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recorderChunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        setVoiceState('transcribing')
        try {
          const blob = new Blob(recorderChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'
          const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type })
          const fd = new FormData()
          fd.append('file', file)
          const res = await fetch(uploadEndpoint, { method: 'POST', body: fd })
          if (!res.ok) throw new Error(`Transcribe failed (${res.status})`)
          const uploaded = (await res.json()) as UploadedAttachment
          if (uploaded.transcript) {
            // Append transcript into the existing textarea content so
            // partial drafts + dictation mix gracefully.
            const next = value.trim().length > 0 ? `${value} ${uploaded.transcript}` : uploaded.transcript
            onChange(next)
          }
          setVoiceState('idle')
        } catch (err) {
          console.error('[ai-composer] voice transcribe failed:', err)
          setVoiceState('failed')
          setTimeout(() => setVoiceState('idle'), 2000)
        } finally {
          // Release the mic.
          recorderStreamRef.current?.getTracks().forEach(t => t.stop())
          recorderStreamRef.current = null
          recorderRef.current = null
          recorderChunksRef.current = []
        }
      }

      recorder.start()
      setVoiceState('recording')
    } catch (err) {
      console.error('[ai-composer] getUserMedia failed:', err)
      setVoiceState('failed')
      setTimeout(() => setVoiceState('idle'), 2000)
    }
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

      {(attachments.length > 0 || kbReferences.length > 0) && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {kbReferences.map((r) => (
            <KbReferenceChip key={r.id} reference={r} onRemove={() => removeKbReference(r.id)} />
          ))}
          {attachments.map(a => (
            <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
          ))}
        </div>
      )}

      {mention && filteredMentionFiles.length > 0 && (
        <div
          id="ai-composer-mention-popover"
          className="absolute bottom-full left-2 z-30 mb-2 w-[320px] rounded-xl border border-black/[0.06] bg-white py-1 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.12)]"
        >
          <div className="px-3 py-1.5 text-[11px] font-medium text-[#a3a3a3]">
            Knowledge files
          </div>
          <ul className="max-h-[280px] overflow-y-auto">
            {filteredMentionFiles.map((f, i) => {
              const isActive = i === mentionHighlight
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setMentionHighlight(i)}
                    onClick={() => selectMention(f)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]',
                      isActive ? 'bg-[#f5f5f5]' : 'hover:bg-[#fafafa]',
                    )}
                  >
                    <BookOpenText size={14} weight="bold" className="flex-shrink-0 text-[#737373]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-[#2e2e2e]">{f.name}</div>
                      <div className="truncate text-[11px] text-[#a3a3a3]">{f.kb_name}</div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {mention && mentionFiles && filteredMentionFiles.length === 0 && (
        <div
          id="ai-composer-mention-popover"
          className="absolute bottom-full left-2 z-30 mb-2 w-[320px] rounded-xl border border-black/[0.06] bg-white px-3 py-3 text-[12px] text-[#737373] shadow-[0_4px_20px_-4px_rgba(0,0,0,0.12)]"
        >
          No matching files. Upload documents under <span className="font-medium text-[#2e2e2e]">Knowledge</span> to reference them here.
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
            ? 'min-h-[120px] px-4 pt-3.5 pb-2 text-[17px] leading-relaxed'
            : 'min-h-[64px] px-3.5 pt-3 pb-1.5 text-[16px] leading-relaxed',
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
              <Plus size={18} weight="bold" />
            </ComposerIconButton>
          </>
        )}

        {/* Voice */}
        <ComposerIconButton
          onClick={handleVoiceToggle}
          disabled={disabled || sending}
          title={
            voiceState === 'recording' ? 'Stop recording'
            : voiceState === 'transcribing' ? 'Transcribing…'
            : voiceState === 'failed' ? 'Voice input failed — try again'
            : 'Voice input'
          }
          aria-label="Voice input"
          className={cn(
            voiceState === 'recording' && 'bg-[#F4511E]/10 text-[#F4511E] hover:bg-[#F4511E]/15 animate-pulse',
            voiceState === 'transcribing' && 'text-[#F4511E]',
            voiceState === 'failed' && 'bg-red-50 text-red-600',
          )}
        >
          {voiceState === 'transcribing'
            ? <Loader variant="circular" size="sm" />
            : <Microphone size={18} weight={voiceState === 'recording' ? 'fill' : 'bold'} />}
        </ComposerIconButton>

        {/* Model picker (internal only) — sits on the LEFT next to attach
            and voice, so the model choice reads as part of the "input
            mode" controls, not as a trailing send-adjacent action. */}
        {model && model.options.length > 0 && (
          <Select
            value={model.value}
            onValueChange={(v) => v && model.onChange(String(v))}
            disabled={disabled}
          >
            <SelectTrigger className="h-9 min-w-[160px] rounded-full border-black/[0.06] bg-white text-[14px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {model.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {leadingSlot}

        <div className="flex-1" />

        {trailingSlot}

        {/* Send / Stop — while sending and a stop handler is wired, the
            send button becomes a stop button that aborts the in-flight
            stream. Matches the ChatGPT / Claude pattern where the same
            affordance doubles as submit and halt. */}
        {sending && onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#2e2e2e] text-white transition-colors hover:bg-black"
            title="Stop generating"
            aria-label="Stop generating"
          >
            <Stop size={14} weight="fill" />
          </button>
        ) : (
          <button
            type="button"
            onClick={doSubmit}
            disabled={!canSubmit}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-full transition-colors',
              canSubmit
                ? 'bg-[#2e2e2e] text-white hover:bg-black'
                : 'bg-[#ebebeb] text-[#a3a3a3]',
            )}
            title="Send"
            aria-label="Send message"
          >
            <PaperPlaneTilt size={16} weight="fill" />
          </button>
        )}
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
        'flex h-9 w-9 items-center justify-center rounded-full text-[#737373] transition-colors',
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

function KbReferenceChip({
  reference,
  onRemove,
}: {
  reference: KbReference
  onRemove: () => void
}) {
  return (
    <div className="group/chip relative flex items-center gap-2 max-w-[240px] rounded-lg px-2 py-1.5 text-[12px] bg-[#FFF4EE] text-[#2e2e2e] ring-1 ring-[#F4511E]/20">
      <span className="flex-shrink-0 text-[#F4511E]">
        <BookOpenText size={14} weight="bold" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{reference.name}</div>
        <div className="truncate text-[10px] text-[#a3a3a3]">{reference.kbName}</div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded-full text-[#a3a3a3] hover:bg-black/5 hover:text-[#2e2e2e] transition-colors"
        aria-label="Remove reference"
      >
        <X size={11} weight="bold" />
      </button>
    </div>
  )
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
