"use client"

// ============================================================================
// KB File Viewer
// Renders a single kb_document in a right-side panel. Reads content_text via
// GET /api/knowledge-base/:kbId/documents/:docId, shows it in a CodeMirror
// editor (read-only by default), and lets the user edit + save — which
// triggers server-side re-chunking + re-embedding.
//
// Why CodeMirror 6 via @uiw/react-codemirror:
//  - Most polished actively-maintained OSS code editor in React. Small core
//    (~50KB gzip), tree-shakeable language extensions.
//  - Handles giant files and long-line wrapping without the layout jank
//    common to contenteditable-based editors.
//  - Native read-only mode via EditorView.editable.of(false), avoiding the
//    fake "disabled textarea" look.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import CodeMirror, { EditorView } from "@uiw/react-codemirror"
import { markdown } from "@codemirror/lang-markdown"
import { json } from "@codemirror/lang-json"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader } from "@/components/ui/loader"
import { Markdown } from "@/components/ui/markdown"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { toast } from "sonner"
import { Pencil, Check, X, FileText, RefreshCw } from "lucide-react"
import type { KbDocument } from "@/types/database"

interface Props {
  kbId: string
  docId: string
  onClose: () => void
  /** Called after a successful save so the parent can refresh the doc list
      (status / char_count / updated_at may have changed). */
  onSaved?: (doc: KbDocument) => void
}

const statusStyles: Record<string, string> = {
  ready: 'bg-emerald-50 text-emerald-700',
  processing: 'bg-blue-50 text-blue-700',
  pending: 'bg-neutral-50 text-neutral-500',
  error: 'bg-red-50 text-red-700',
}

/**
 * Pick a CodeMirror language extension from the filename. Unknown types
 * render as plain text — still a useful read/edit experience; it just
 * loses syntax highlighting.
 */
function languageExtensions(filename: string | null) {
  if (!filename) return []
  const lower = filename.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return [markdown()]
  if (lower.endsWith('.json')) return [json()]
  // Plain text, CSV, logs etc — no extension. CSV doesn't have an official
  // CodeMirror 6 language package yet; plain text is a fine fallback
  // because CSV is just comma-delimited text.
  return []
}

/** True for types whose stored content_text is extracted from a binary.
    For those we show an "Extracted" banner so users aren't surprised that
    the editor doesn't reflect their original layout. */
function isExtractedBinary(fileType: string | null, name: string): boolean {
  const t = (fileType ?? '').toLowerCase()
  const n = name.toLowerCase()
  return t.includes('pdf') || n.endsWith('.pdf')
    || t.includes('wordprocessingml') || n.endsWith('.docx')
}

/** True for files we should render as formatted markdown in read mode.
    Edit mode always falls back to the raw CodeMirror editor. */
function isMarkdown(name: string): boolean {
  const n = name.toLowerCase()
  return n.endsWith('.md') || n.endsWith('.markdown')
}

function firstLineCap(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function KbFileViewer({ kbId, docId, onClose, onSaved }: Props) {
  const [doc, setDoc] = useState<KbDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)

  const loadedForDocIdRef = useRef<string | null>(null)

  // Load the doc when the target changes. We key on docId so switching
  // between files in the list reliably reloads the viewer.
  useEffect(() => {
    let cancelled = false
    loadedForDocIdRef.current = null
    setLoading(true)
    setError(null)
    setEditing(false)
    ;(async () => {
      const res = await fetch(`/api/knowledge-base/${kbId}/documents/${docId}`)
      if (cancelled) return
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? `Failed to load (${res.status})`)
        setLoading(false)
        return
      }
      const data = (await res.json()) as KbDocument
      if (cancelled) return
      setDoc(data)
      setDraft(data.content_text ?? "")
      loadedForDocIdRef.current = docId
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [kbId, docId])

  const dirty = useMemo(
    () => editing && doc !== null && draft !== (doc.content_text ?? ""),
    [editing, draft, doc]
  )

  const beginEdit = useCallback(() => {
    if (!doc) return
    setDraft(doc.content_text ?? "")
    setEditing(true)
  }, [doc])

  const cancelEdit = useCallback(() => {
    if (dirty) {
      setDiscardOpen(true)
      return
    }
    setEditing(false)
    setDraft(doc?.content_text ?? "")
  }, [dirty, doc])

  const confirmDiscard = useCallback(() => {
    setEditing(false)
    setDraft(doc?.content_text ?? "")
    setDiscardOpen(false)
  }, [doc])

  const save = useCallback(async () => {
    if (!doc) return
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
      // data is the updated KbDocument row
      setDoc(data as KbDocument)
      setEditing(false)
      toast.success('Saved. Re-embedding complete.')
      onSaved?.(data as KbDocument)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [doc, draft, kbId, docId, onSaved])

  // Keyboard: Esc cancels edit; Ctrl/Cmd+S saves.
  useEffect(() => {
    if (!editing) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { cancelEdit() }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, cancelEdit, save])

  // --- Render ---------------------------------------------------------------

  const extensions = useMemo(
    () => [
      ...languageExtensions(doc?.name ?? null),
      EditorView.lineWrapping,
    ],
    [doc?.name]
  )

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/[0.04] px-4">
        <FileText size={16} className="text-[#737373] shrink-0" />
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
        {doc && !editing && doc.status !== 'processing' && (
          <Button size="sm" variant="secondary" onClick={beginEdit}>
            <Pencil size={13} className="mr-1.5" />
            Edit
          </Button>
        )}
        {editing && (
          <>
            <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={saving || !dirty}>
              {saving ? <RefreshCw size={13} className="mr-1.5 animate-spin" /> : <Check size={13} className="mr-1.5" />}
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close viewer">
          <X size={14} />
        </Button>
      </div>

      {/* Extracted-text notice for binaries */}
      {doc && isExtractedBinary(doc.file_type, doc.name) && (
        <div className="shrink-0 px-4 py-2 border-b border-black/[0.04] bg-yellow-50 text-yellow-900 text-[11px]">
          Text extracted from {doc.file_type?.includes('pdf') || doc.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'DOCX'}.
          Edits update the indexed text only — the original binary is not modified.
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader variant="circular" size="sm" />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="text-center">
              <div className="text-sm font-medium text-red-700">{error}</div>
              <Button size="sm" variant="secondary" className="mt-3" onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : doc ? (
          // Markdown files render as formatted HTML in read mode so users
          // can review the doc as intended. Edit mode always falls back
          // to the raw CodeMirror editor — editing rendered HTML would
          // be confusing (what gets persisted?) and round-tripping
          // rich-text edits back to markdown is a rabbit hole.
          !editing && isMarkdown(doc.name) ? (
            <div className="h-full overflow-auto px-6 py-5">
              <Markdown className="prose-sm max-w-none text-sm text-[#2e2e2e]">
                {doc.content_text ?? ''}
              </Markdown>
            </div>
          ) : (
            // CodeMirror doesn't respect wrapper padding on its own — it
            // styles its internal .cm-content element instead. Padding is
            // applied via the theme prop below so both read and edit modes
            // get the same breathing room. px-6 py-5 matches the markdown
            // viewer and the KB list's row padding.
            <div className="h-full overflow-auto">
              <CodeMirror
                value={editing ? draft : (doc.content_text ?? '')}
                onChange={editing ? (v) => setDraft(v) : undefined}
                extensions={extensions}
                editable={editing}
                basicSetup={{
                  lineNumbers: false,
                  foldGutter: false,
                  highlightActiveLine: editing,
                  highlightActiveLineGutter: false,
                  autocompletion: editing,
                  bracketMatching: editing,
                }}
                style={{
                  fontSize: '13px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  height: '100%',
                }}
                className="cm-kb-viewer h-full"
              />
            </div>
          )
        ) : null}
      </div>

      {/* Footer stats */}
      {doc && (
        <div className="shrink-0 flex items-center gap-3 px-4 h-8 border-t border-black/[0.04] text-[11px] text-[#737373]">
          <span>{doc.char_count.toLocaleString()} chars</span>
          {doc.file_size != null && <span>· {formatBytes(doc.file_size)}</span>}
          {editing && dirty && <span className="ml-auto text-[#737373]">Unsaved changes</span>}
        </div>
      )}

      {/* Discard-changes confirm */}
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              You have unsaved edits. Closing will discard them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setDiscardOpen(false)}>Keep editing</Button>
            <Button variant="destructive" size="sm" onClick={confirmDiscard}>Discard</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
