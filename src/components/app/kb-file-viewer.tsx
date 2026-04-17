"use client"

// ============================================================================
// KB File Viewer
//
// Two tabs:
//   - Preview: renders the original file in its native format
//       • PDF / images  → signed URL in an <iframe> / <img>
//       • DOCX          → server-rendered sanitized HTML (mammoth)
//       • XLSX          → server-rendered sanitized HTML (SheetJS)
//       • PPT / PPTX    → converted to PDF server-side (LibreOffice), iframe
//       • CSV           → client-side parse + styled <table>
//       • Markdown      → rendered via our <Markdown> component
//       • TXT           → CodeMirror read-only
//       • missing/error → helpful placeholder with a shortcut to the Text tab
//   - Text: the extracted content_text, always editable. Click anywhere to
//     start editing; no dedicated Edit button. Save appears when dirty,
//     Cmd/Ctrl+S saves, Esc reverts.
//
// Preview HTML + converted PDF paths are cached server-side so repeat opens
// are fast. PATCH /content_text invalidates the cache.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import CodeMirror, { EditorView } from "@uiw/react-codemirror"
import { markdown } from "@codemirror/lang-markdown"
import { json } from "@codemirror/lang-json"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Markdown } from "@/components/ui/markdown"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { Check, X, FileText, RefreshCw, AlertCircle, Eye, Pencil } from "lucide-react"
import type { KbDocument } from "@/types/database"
// Load PdfRenderer only on the client — react-pdf pulls in pdfjs-dist's
// browser build, which references DOMMatrix and crashes when Node.js's
// module loader touches it during SSR. `ssr: false` keeps the whole module
// out of the server bundle.
import dynamic from "next/dynamic"
const PdfRenderer = dynamic(
  () => import("@/components/app/pdf-renderer").then(m => m.PdfRenderer),
  { ssr: false },
)
import { DocumentTypeIcon } from "@/components/ui/document-type-icon"

// --- Types matching the server response -------------------------------------

type PreviewKind = 'native' | 'html' | 'pdf' | 'spreadsheet' | 'text' | 'error' | 'missing'

interface SheetPreview {
  name: string
  html: string
}

interface Preview {
  kind: PreviewKind
  signedUrl?: string
  html?: string
  sheets?: SheetPreview[]
  message?: string
  reason?: string
}

type FileKind =
  | 'pdf' | 'docx' | 'xlsx' | 'pptx'
  | 'csv' | 'markdown' | 'text' | 'image' | 'unknown'

interface DocResponse extends KbDocument {
  preview: Preview
  kind: FileKind
}

interface Props {
  kbId: string
  docId: string
  onClose: () => void
  onSaved?: (doc: KbDocument) => void
}

const statusStyles: Record<string, string> = {
  ready: 'bg-emerald-50 text-emerald-700',
  processing: 'bg-blue-50 text-blue-700',
  pending: 'bg-neutral-50 text-neutral-500',
  error: 'bg-red-50 text-red-700',
}

function languageExtensions(filename: string | null) {
  if (!filename) return []
  const lower = filename.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return [markdown()]
  if (lower.endsWith('.json')) return [json()]
  return []
}

function firstLineCap(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Main viewer
// ---------------------------------------------------------------------------

export function KbFileViewer({ kbId, docId, onClose, onSaved }: Props) {
  const [doc, setDoc] = useState<DocResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Text-tab edit state. There's no "view vs edit" mode — the editor is
  // always editable; we only track whether the draft differs from what the
  // server has so we can show Save.
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)

  // Which tab is active. Default = preview so the user sees the native
  // render first; falls back to text automatically when no preview exists.
  const [tab, setTab] = useState<'preview' | 'text'>('preview')

  // Load on docId change. Reset everything so stale edits never leak
  // between files when the user clicks through the list.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setDoc(null)
    setDraft("")
    setTab('preview')
    ;(async () => {
      const res = await fetch(`/api/knowledge-base/${kbId}/documents/${docId}`)
      if (cancelled) return
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? `Failed to load (${res.status})`)
        setLoading(false)
        return
      }
      const data = (await res.json()) as DocResponse
      if (cancelled) return
      setDoc(data)
      setDraft(data.content_text ?? "")
      // If the server says Preview isn't usable for this doc, jump
      // straight to the Text tab so the user sees the actual content.
      if (data.preview?.kind === 'text' || data.preview?.kind === 'missing') {
        setTab('text')
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [kbId, docId])

  const dirty = useMemo(
    () => doc !== null && draft !== (doc.content_text ?? ""),
    [draft, doc]
  )

  const revertDraft = useCallback(() => {
    setDraft(doc?.content_text ?? "")
  }, [doc])

  const save = useCallback(async () => {
    if (!doc || !dirty) return
    setSaving(true)
    try {
      const res = await fetch(`/api/knowledge-base/${kbId}/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_text: draft }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Save failed')
        setSaving(false)
        return
      }
      // Server returns the updated KbDocument. Preview cache got nuked
      // by the PATCH route; re-fetch so the Preview tab gets regenerated
      // content on its next visit. Cheap — just one GET.
      const refreshed = await fetch(`/api/knowledge-base/${kbId}/documents/${docId}`)
      if (refreshed.ok) {
        const full = (await refreshed.json()) as DocResponse
        setDoc(full)
        setDraft(full.content_text ?? '')
      } else {
        setDoc((prev) => prev ? { ...prev, ...(data as KbDocument) } : prev)
      }
      toast.success('Saved. Re-embedding complete.')
      onSaved?.(data as KbDocument)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [doc, dirty, draft, kbId, docId, onSaved])

  // Keyboard: Cmd/Ctrl+S saves, Esc reverts unsaved changes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty) save()
      }
      if (e.key === 'Escape' && dirty) {
        // Prompt before tossing changes — a stray Esc shouldn't delete work.
        setDiscardOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, save])

  const requestClose = () => {
    if (dirty) { setDiscardOpen(true); return }
    onClose()
  }

  // Tab switcher helper — warn on navigate away from an unsaved text draft.
  const switchTab = (next: 'preview' | 'text') => {
    if (tab === 'text' && next === 'preview' && dirty) {
      setDiscardOpen(true)
      return
    }
    setTab(next)
  }

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/[0.04] px-4">
        {doc ? (
          <DocumentTypeIcon name={doc.name} fileType={doc.file_type} size={16} />
        ) : (
          <FileText size={16} className="text-[#737373] shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-[#2e2e2e] truncate">
              {doc ? firstLineCap(doc.name) : 'Loading…'}
            </span>
            {doc && (
              <Badge variant="secondary" className={`text-[10px] shrink-0 ${statusStyles[doc.status] || ''}`}>
                {firstLineCap(doc.status)}
              </Badge>
            )}
          </div>
        </div>
        {tab === 'text' && dirty && (
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <RefreshCw size={13} className="mr-1.5 animate-spin" /> : <Check size={13} className="mr-1.5" />}
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" onClick={requestClose} aria-label="Close viewer">
          <X size={14} />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 items-center gap-0 border-b border-black/[0.04] px-4">
        <TabButton active={tab === 'preview'} onClick={() => switchTab('preview')}>
          <Eye size={13} />
          Preview
        </TabButton>
        <TabButton active={tab === 'text'} onClick={() => switchTab('text')}>
          <Pencil size={13} />
          Text
          {dirty && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-[#F4511E] inline-block" />}
        </TabButton>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <BodySkeleton />
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="text-center">
              <div className="text-sm font-medium text-red-700">{error}</div>
              <Button size="sm" variant="secondary" className="mt-3" onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : doc ? (
          tab === 'preview' ? (
            <PreviewPane doc={doc} onSwitchToText={() => setTab('text')} />
          ) : (
            <TextPane
              doc={doc}
              value={draft}
              onChange={setDraft}
            />
          )
        ) : null}
      </div>

      {/* Footer stats */}
      {doc && (
        <div className="shrink-0 flex items-center gap-3 px-4 h-8 border-t border-black/[0.04] text-[11px] text-[#737373]">
          <span>{doc.char_count.toLocaleString()} chars</span>
          {doc.file_size != null && <span>· {formatBytes(doc.file_size)}</span>}
          {tab === 'text' && dirty && (
            <span className="ml-auto text-[#F4511E]">Unsaved changes</span>
          )}
        </div>
      )}

      {/* Discard-changes confirm */}
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              You have unsaved edits. Continuing will discard them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setDiscardOpen(false)}>Keep editing</Button>
            <Button variant="destructive" size="sm" onClick={() => {
              revertDraft()
              setDiscardOpen(false)
              // If the user was switching away, carry them there now.
              if (tab === 'text') setTab('preview')
              else onClose()
            }}>Discard</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------------------

function TabButton({
  active, onClick, children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 h-10 text-[13px] font-medium border-b-2 transition-colors ${
        active
          ? 'border-[#F4511E] text-[#2e2e2e]'
          : 'border-transparent text-[#737373] hover:text-[#2e2e2e]'
      }`}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Loading skeleton that matches the body area
// ---------------------------------------------------------------------------

function BodySkeleton() {
  return (
    <div className="p-6 space-y-3">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preview tab — format-specific renderers
// ---------------------------------------------------------------------------

function PreviewPane({ doc, onSwitchToText }: { doc: DocResponse; onSwitchToText: () => void }) {
  const { preview, kind, name, file_type } = doc

  // Missing binary (legacy uploads) — friendly call-to-action.
  if (preview.kind === 'missing') {
    return (
      <FallbackMessage
        icon={<AlertCircle size={20} className="text-yellow-600" />}
        title="Original file not available"
        message="This document was uploaded before preview support. Re-upload it to see the native view, or switch to the Text tab to read the extracted content."
        action={<Button size="sm" onClick={onSwitchToText}>Open Text tab</Button>}
      />
    )
  }

  if (preview.kind === 'error') {
    return (
      <FallbackMessage
        icon={<AlertCircle size={20} className="text-red-600" />}
        title="Preview could not be generated"
        message={preview.message ?? 'The server was unable to render this file.'}
        action={<Button size="sm" onClick={onSwitchToText}>Open Text tab</Button>}
      />
    )
  }

  // Formats that can't be rendered natively yet fall through to Text tab.
  if (preview.kind === 'text') {
    return (
      <FallbackMessage
        icon={<FileText size={20} className="text-[#737373]" />}
        title="No native preview for this format"
        message={preview.reason ?? 'Showing extracted text instead.'}
        action={<Button size="sm" onClick={onSwitchToText}>Open Text tab</Button>}
      />
    )
  }

  // Images — handled via the native kind using <img>.
  if (kind === 'image' && preview.kind === 'native' && preview.signedUrl) {
    return (
      <div className="h-full overflow-auto bg-[#fafafa] flex items-center justify-center p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview.signedUrl} alt={name} className="max-w-full max-h-full object-contain" />
      </div>
    )
  }

  // PDFs (native) and PPTX (converted to PDF) both render via our own
  // pdf.js-based renderer — custom toolbar, thumbnails, zoom, page nav
  // that matches Jordon's styling. Beats the dark Chrome built-in viewer.
  // kind === 'image' is handled above; everything else in 'native' is PDF.
  if ((preview.kind === 'native' && kind !== 'image') || preview.kind === 'pdf') {
    const url = preview.signedUrl!
    return <PdfRenderer url={url} filename={name} />
  }

  // CSVs: parse client-side from the already-available content_text.
  // Simpler + faster than round-tripping HTML from the server for what's
  // just comma-delimited data.
  if (kind === 'csv') {
    return <CsvTable source={doc.content_text ?? ''} />
  }

  // Markdown rendered via existing component — same as before.
  if (kind === 'markdown') {
    return (
      <div className="h-full overflow-auto px-6 py-5">
        <Markdown className="prose-sm max-w-none text-sm text-[#2e2e2e]">
          {doc.content_text ?? ''}
        </Markdown>
      </div>
    )
  }

  // XLSX — Excel-style sheet tabs at the bottom, one sheet visible at
  // a time with sticky header row, grid borders, and tabular alignment.
  if (preview.kind === 'spreadsheet' && preview.sheets && preview.sheets.length > 0) {
    return <SpreadsheetView sheets={preview.sheets} />
  }

  // Generic server-generated sanitized HTML (legacy path — DOCX now
  // flows through 'pdf' via LibreOffice). Kept for future formats.
  if (preview.kind === 'html' && typeof preview.html === 'string') {
    return (
      <div className="h-full overflow-auto px-6 py-5">
        <div
          className="kb-preview-html text-sm text-[#2e2e2e]"
          // eslint-disable-next-line react/no-danger-html -- sanitized server-side via sanitize-html
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />
      </div>
    )
  }

  // Plain text — CodeMirror read-only (nicer than a <pre>).
  if (kind === 'text') {
    return (
      <div className="h-full overflow-auto">
        <CodeMirror
          value={doc.content_text ?? ''}
          editable={false}
          extensions={[...languageExtensions(name), EditorView.lineWrapping]}
          basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false }}
          style={{
            fontSize: '13px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            height: '100%',
          }}
          className="cm-kb-viewer h-full"
        />
      </div>
    )
  }

  // Unknown shape — generic fallback.
  return (
    <FallbackMessage
      icon={<FileText size={20} className="text-[#737373]" />}
      title={`Preview unavailable for ${file_type ?? 'this format'}`}
      message="Open the Text tab to read the extracted content."
      action={<Button size="sm" onClick={onSwitchToText}>Open Text tab</Button>}
    />
  )
}

function FallbackMessage({
  icon, title, message, action,
}: {
  icon: React.ReactNode
  title: string
  message: string
  action?: React.ReactNode
}) {
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto h-10 w-10 rounded-full bg-[#f5f5f5] flex items-center justify-center mb-3">
          {icon}
        </div>
        <div className="text-sm font-medium text-[#2e2e2e]">{title}</div>
        <p className="text-xs text-[#737373] mt-1.5 leading-relaxed">{message}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CSV → styled table
// Minimal parser (handles quoted fields + escaped quotes). Good enough for
// typical exports; heavy CSVs should use papaparse but we avoid the dep.
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let current: string[] = []
  let cell = ''
  let i = 0
  let inQuotes = false
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue }
        inQuotes = false; i++
      } else {
        cell += ch; i++
      }
    } else {
      if (ch === '"') { inQuotes = true; i++ }
      else if (ch === ',') { current.push(cell); cell = ''; i++ }
      else if (ch === '\r') { i++ } // normalize CRLF
      else if (ch === '\n') { current.push(cell); rows.push(current); current = []; cell = ''; i++ }
      else { cell += ch; i++ }
    }
  }
  // Trailing cell / row
  if (cell.length > 0 || current.length > 0) {
    current.push(cell)
    rows.push(current)
  }
  return rows
}

function CsvTable({ source }: { source: string }) {
  const rows = useMemo(() => parseCsv(source), [source])
  if (rows.length === 0) {
    return <FallbackMessage icon={<FileText size={20} />} title="Empty CSV" message="This CSV file has no rows." />
  }
  const [head, ...body] = rows
  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 bg-[#fafafa] z-10">
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className="px-3 py-2 text-left text-xs font-medium text-[#737373] border-b border-black/[0.04]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="hover:bg-[#fafafa]">
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-3 py-2 border-b border-black/[0.04] ${
                    ci === 0 ? 'font-medium text-[#2e2e2e]' : 'text-[#525252]'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text tab — always editable, click anywhere to start typing
// ---------------------------------------------------------------------------

function TextPane({
  doc, value, onChange,
}: {
  doc: DocResponse
  value: string
  onChange: (s: string) => void
}) {
  const isExtractedBinary =
    doc.kind === 'pdf' || doc.kind === 'docx' || doc.kind === 'xlsx' || doc.kind === 'pptx'

  return (
    <div className="flex h-full flex-col">
      {isExtractedBinary && (
        <div className="shrink-0 px-4 py-2 border-b border-black/[0.04] bg-yellow-50 text-yellow-900 text-[11px]">
          This is the indexed text extracted from the original file. Edits update what the agent sees — the original binary is not modified.
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        <CodeMirror
          value={value}
          onChange={onChange}
          extensions={[
            ...languageExtensions(doc.name),
            EditorView.lineWrapping,
          ]}
          editable={true}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: true,
            highlightActiveLineGutter: false,
            autocompletion: true,
            bracketMatching: true,
          }}
          style={{
            fontSize: '13px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            minHeight: '100%',
          }}
          className="cm-kb-viewer h-full"
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SpreadsheetView — Excel-style tabbed view
// One sheet visible at a time, sticky header row, grid borders, tabs at
// the bottom. Looks and navigates like a real spreadsheet rather than a
// stacked pile of HTML tables.
// ---------------------------------------------------------------------------

function SpreadsheetView({ sheets }: { sheets: SheetPreview[] }) {
  const [active, setActive] = useState(0)
  // Guard against out-of-range when the sheets prop changes (new file).
  useEffect(() => {
    if (active >= sheets.length) setActive(0)
  }, [sheets, active])

  const current = sheets[active] ?? sheets[0]
  if (!current) return null

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Cells */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div
          className="kb-xlsx-sheet-body"
          // eslint-disable-next-line react/no-danger-html -- sanitized server-side via sanitize-html
          dangerouslySetInnerHTML={{ __html: current.html }}
        />
      </div>

      {/* Sheet tab strip — always visible at the bottom, Excel-style.
          Hidden when there's only a single sheet since the tab would
          be redundant chrome. */}
      {sheets.length > 1 && (
        <div className="shrink-0 flex items-stretch gap-px border-t border-black/[0.04] bg-[#f5f5f5] px-2 overflow-x-auto">
          {sheets.map((s, i) => {
            const isActive = i === active
            return (
              <button
                key={`${s.name}-${i}`}
                onClick={() => setActive(i)}
                className={`px-3 h-8 text-[12px] font-medium whitespace-nowrap transition-colors rounded-t-md -mb-px ${
                  isActive
                    ? 'bg-white text-[#2e2e2e] border-x border-t border-black/[0.06]'
                    : 'text-[#737373] hover:bg-white/60 hover:text-[#2e2e2e]'
                }`}
              >
                {s.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
