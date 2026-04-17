"use client"

import { useEffect, useState } from 'react'
import { FileText, FilePdf, FileDoc, FileXls, FilePpt, Image as ImageIcon, SpeakerHigh, DownloadSimple } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import type { UploadedAttachment, AttachmentKind } from '@/lib/chat-attachments/constants'

/**
 * Shared renderer for an attachment inside a chat bubble. Renders
 * three shapes based on kind:
 *
 *   image → inline thumbnail, lightbox on click
 *   audio → <audio controls> + filename + download button
 *   other → file card (icon + name + size + download)
 *
 * URLs are fetched lazily from /api/chat/attachments/sign so the
 * bubble doesn't leak a signed URL on render if the user never
 * scrolls it into view.
 */
export function AttachmentPreview({ attachment }: { attachment: UploadedAttachment }) {
  if (attachment.kind === 'image') return <ImageAttachment attachment={attachment} />
  if (attachment.kind === 'audio') return <AudioAttachment attachment={attachment} />
  return <FileAttachment attachment={attachment} />
}

export function AttachmentList({ attachments }: { attachments: UploadedAttachment[] }) {
  if (attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map(a => <AttachmentPreview key={a.id} attachment={a} />)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Signed URL hook — lazily fetch once per attachment per render session.
// ---------------------------------------------------------------------------

function useSignedUrl(path: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/chat/attachments/sign?path=${encodeURIComponent(path)}`)
        if (!res.ok) return
        const data = await res.json() as { url?: string }
        if (!cancelled && data.url) setUrl(data.url)
      } catch { /* silent */ }
    })()
    return () => { cancelled = true }
  }, [path])
  return url
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

function ImageAttachment({ attachment }: { attachment: UploadedAttachment }) {
  const url = useSignedUrl(attachment.path)
  const [lightbox, setLightbox] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => url && setLightbox(true)}
        className="group/img block overflow-hidden rounded-xl ring-1 ring-black/[0.04] bg-[#f5f5f5] transition-colors hover:ring-black/[0.08]"
        title={attachment.name}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={attachment.name}
            className="max-h-[220px] max-w-[320px] object-cover"
          />
        ) : (
          <div className="flex h-24 w-40 items-center justify-center text-[#a3a3a3]">
            <ImageIcon size={28} weight="fill" />
          </div>
        )}
      </button>
      {lightbox && url && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
          onClick={() => setLightbox(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={attachment.name}
            className="max-h-full max-w-full rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

function AudioAttachment({ attachment }: { attachment: UploadedAttachment }) {
  const url = useSignedUrl(attachment.path)
  return (
    <div className="flex min-w-[220px] max-w-[360px] flex-col gap-2 rounded-xl bg-white p-3 ring-1 ring-black/[0.04]">
      <div className="flex items-center gap-2 text-[12px] text-[#2e2e2e]">
        <SpeakerHigh size={14} weight="fill" className="flex-shrink-0 text-[#737373]" />
        <span className="truncate font-medium">{attachment.name}</span>
      </div>
      {url ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio controls src={url} className="w-full" />
      ) : (
        <div className="h-8 w-full animate-pulse rounded-md bg-[#f5f5f5]" />
      )}
      {attachment.transcript && (
        <details className="group/transcript">
          <summary className="cursor-pointer text-[11px] font-medium text-[#737373] hover:text-[#2e2e2e]">
            Transcript
          </summary>
          <p className="mt-1 text-[12px] text-[#525252] leading-relaxed whitespace-pre-wrap">
            {attachment.transcript}
          </p>
        </details>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// File (pdf, docx, xlsx, pptx, md, txt)
// ---------------------------------------------------------------------------

function FileAttachment({ attachment }: { attachment: UploadedAttachment }) {
  const url = useSignedUrl(attachment.path)
  return (
    <div className="flex max-w-[280px] items-center gap-2.5 rounded-xl bg-white p-2.5 pr-3 ring-1 ring-black/[0.04]">
      <div className={cn('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg', tintFor(attachment.kind))}>
        <FileKindIcon kind={attachment.kind} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-[#2e2e2e]">{attachment.name}</div>
        <div className="text-[11px] text-[#a3a3a3]">
          {attachment.kind.toUpperCase()} · {formatBytes(attachment.size)}
        </div>
      </div>
      {url && (
        <a
          href={url}
          download={attachment.name}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[#737373] hover:bg-[#f5f5f5]"
          title="Download"
          aria-label="Download"
        >
          <DownloadSimple size={13} weight="bold" />
        </a>
      )}
    </div>
  )
}

function FileKindIcon({ kind }: { kind: AttachmentKind }) {
  const size = 16
  switch (kind) {
    case 'pdf':   return <FilePdf size={size} weight="fill" />
    case 'docx':  return <FileDoc size={size} weight="fill" />
    case 'xlsx':  return <FileXls size={size} weight="fill" />
    case 'pptx':  return <FilePpt size={size} weight="fill" />
    case 'markdown':
    case 'text':
    default:      return <FileText size={size} weight="fill" />
  }
}

function tintFor(kind: AttachmentKind): string {
  switch (kind) {
    case 'pdf':   return 'bg-red-50 text-red-600'
    case 'docx':  return 'bg-blue-50 text-blue-600'
    case 'xlsx':  return 'bg-emerald-50 text-emerald-600'
    case 'pptx':  return 'bg-orange-50 text-orange-600'
    case 'markdown': return 'bg-neutral-100 text-neutral-700'
    default:      return 'bg-neutral-50 text-neutral-600'
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
