'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { FolderCard, FolderColorPicker, type FolderAction } from '@/components/ui/folder-card'
import { HeaderActions, HeaderTitle } from '@/components/ui/header-actions'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Agent, KnowledgeBase, KbDocument } from '@/types/database'
import { Plus, Trash, Upload, Database, ArrowLeft, FileText, X, PencilSimple, Check, Warning, ArrowClockwise } from '@phosphor-icons/react'
import { Checkbox } from '@/components/ui/checkbox'
import { Panel } from '@/components/ui/panel'
import { KbFileViewer } from '@/components/app/kb-file-viewer'
import { RowActions, RowActionButton } from '@/components/ui/row-actions'
import { DocumentTypeIcon } from '@/components/ui/document-type-icon'
import { createClient } from '@/lib/supabase/client'

interface KnowledgeBaseWithDocs extends KnowledgeBase {
  kb_documents: KbDocument[]
}

const statusStyles: Record<string, string> = {
  ready: 'bg-emerald-50 text-emerald-700',
  processing: 'bg-blue-50 text-blue-700',
  pending: 'bg-neutral-50 text-neutral-500',
  error: 'bg-red-50 text-red-700',
}

/** Best-effort: pull an `{ error }` message out of a JSON error body. */
function safeXhrMessage(xhr: XMLHttpRequest): string | null {
  try {
    const parsed = JSON.parse(xhr.responseText) as { error?: string }
    if (parsed && typeof parsed.error === 'string') return parsed.error
  } catch { /* not JSON */ }
  return null
}

/** "hello world" → "Hello world". Leaves already-capitalized strings alone. */
function capitalizeFirst(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---------------------------------------------------------------------------
// UploadStatusIcon
// ---------------------------------------------------------------------------

/**
 * 18×18 icon that replaces the static file icon on in-flight upload rows.
 * Renders one of:
 *   - uploading: circular SVG progress arc, filling as bytes upload
 *   - done:      green check inside a filled green circle (~2s visible
 *                before the task clears and the real doc row takes over)
 *   - error:     red alert triangle
 * When `progress < 5` we show an indeterminate spinning arc so the user
 * sees motion even before byte-level progress kicks in.
 */
function UploadStatusIcon({
  status,
  progress,
}: {
  status: 'uploading' | 'processing' | 'done' | 'error'
  progress: number
}) {
  if (status === 'done') {
    return (
      <div className="h-[18px] w-[18px] shrink-0 rounded-full bg-emerald-500 flex items-center justify-center">
        <Check size={11} weight="bold" className="text-white" />
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="h-[18px] w-[18px] shrink-0 rounded-full bg-red-500 flex items-center justify-center">
        <Warning size={11} weight="bold" className="text-white" />
      </div>
    )
  }

  // Uploading: determinate progress ring (track + growing arc, 0-100%).
  // Processing: indeterminate spinning arc — upload is complete but the
  // server is chunking + embedding and we have no % to report.
  // Below 5% during "uploading" we also spin so the user sees motion
  // before the first progress event arrives.
  const RADIUS = 7
  const CIRC = 2 * Math.PI * RADIUS
  const displayProgress = Math.max(3, Math.min(100, progress))
  const offset = CIRC * (1 - displayProgress / 100)
  const indeterminate = status === 'processing' || progress < 5

  return (
    <div className="h-[18px] w-[18px] shrink-0">
      <svg viewBox="0 0 18 18" className={indeterminate ? 'animate-spin' : ''}>
        {/* Track */}
        <circle cx="9" cy="9" r={RADIUS} fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="2" />
        {/* Progress arc, starts at 12 o'clock */}
        <circle
          cx="9"
          cy="9"
          r={RADIUS}
          fill="none"
          stroke="#2e2e2e"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={indeterminate ? CIRC * 0.75 : offset}
          transform="rotate(-90 9 9)"
          className="transition-[stroke-dashoffset] duration-200 ease-out"
        />
      </svg>
    </div>
  )
}

function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx < 0 || idx === name.length - 1) return ''
  return name.slice(idx + 1).toLowerCase()
}

/** Bytes → "12.3 KB" / "4.5 MB". Uses base-1024. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * ISO timestamp → "Just now" / "5m ago" / "3h ago" / "Apr 16".
 * Anything older than ~30 days falls back to localized month + day.
 */
function formatRelative(iso: string): string {
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'Just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function KnowledgePage() {
  const [kbs, setKbs] = useState<KnowledgeBaseWithDocs[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedKb, setSelectedKb] = useState<string | null>(null)

  // Create KB dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createAgent, setCreateAgent] = useState<string>('')
  const [createColor, setCreateColor] = useState<string>('Blue')
  const [creating, setCreating] = useState(false)

  // Edit KB dialog
  const [editOpen, setEditOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editAgent, setEditAgent] = useState<string>('')
  const [editColor, setEditColor] = useState<string>('Blue')
  const [savingEdit, setSavingEdit] = useState(false)

  // Upload — parallel, per-file progress with optimistic UI.
  // Each entry is keyed by a client-side uuid so retries don't collide.
  interface UploadTask {
    clientId: string
    file: File
    status: 'uploading' | 'processing' | 'done' | 'error'
    progress: number    // 0-100 (real for <= 4MB via XHR, fake tween for larger)
    error?: string
    docId?: string      // once the server returns a KbDocument id
  }
  const [uploadQueue, setUploadQueue] = useState<UploadTask[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Multi-select + delete confirmation
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: 'single'; id: string; name: string }
    | { kind: 'bulk'; ids: string[] }
    | null
  >(null)
  const [deleting, setDeleting] = useState(false)

  // Clear selection when leaving / switching KB
  useEffect(() => { setSelected(new Set()) }, [selectedKb])

  // File viewer — opens to the right when a row is clicked. Reset when
  // switching KBs so we don't try to load a doc from a different KB.
  const [viewerDocId, setViewerDocId] = useState<string | null>(null)
  useEffect(() => { setViewerDocId(null) }, [selectedKb])

  // Deep-link support: when the page loads (or the URL changes via
  // client nav) with `?kb=…&doc=…`, open that KB and select that doc in
  // the viewer. Used by KB source chips in chat messages — clicking a
  // chip opens a new tab directly to the referenced doc.
  //
  // A single ref gate prevents re-triggering on every re-render, so the
  // user's subsequent in-app navigation (picking a different doc in the
  // list, closing the viewer) isn't overridden by the stale query
  // params.
  const deepLinkAppliedRef = useRef(false)
  useEffect(() => {
    if (deepLinkAppliedRef.current) return
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const kbParam = params.get('kb')
    const docParam = params.get('doc')
    if (!kbParam) return
    deepLinkAppliedRef.current = true
    setSelectedKb(kbParam)
    if (docParam) {
      // setSelectedKb() triggers the above useEffect that nulls
      // viewerDocId; queueMicrotask defers setting viewerDocId until
      // after that reset so our value wins.
      queueMicrotask(() => setViewerDocId(docParam))
    }
  }, [])

  const fetchKbs = useCallback(async () => {
    try {
      const res = await fetch('/api/knowledge-base')
      if (!res.ok) throw new Error('Failed to load knowledge bases')
      setKbs(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents')
      if (res.ok) setAgents(await res.json())
    } catch { /* non-critical */ }
  }, [])

  useEffect(() => { fetchKbs(); fetchAgents() }, [fetchKbs, fetchAgents])

  // Realtime: keep this page in sync across tabs / devices. If another
  // client creates, edits, renames, deletes, uploads, or finishes
  // processing a KB or its documents, we refetch the list instead of
  // trying to merge partial payloads — the list endpoint already joins
  // kb_documents and honors org scoping, so a refetch is the simplest
  // authoritative reconciliation path (cheap; the list is small).
  useEffect(() => {
    const supabase = createClient()
    let cleanup: (() => void) | null = null
    let cancelled = false
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || cancelled) return
      const { data: membership } = await supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', user.id)
        .single()
      const orgId = membership?.org_id as string | undefined
      if (!orgId || cancelled) return
      const channel = supabase
        .channel(`kb-sync-${orgId}`)
        // knowledge_bases: create / rename / color-change / delete in
        // another tab reflects here.
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'knowledge_bases', filter: `org_id=eq.${orgId}` },
            () => { void fetchKbs() })
        // kb_documents: upload / status transitions (processing → ready /
        // error) / delete. Filter by org_id so we don't get noise from
        // other orgs even though RLS already scopes reads.
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'kb_documents', filter: `org_id=eq.${orgId}` },
            () => { void fetchKbs() })
        .subscribe()
      cleanup = () => { void supabase.removeChannel(channel) }
    })()
    return () => {
      cancelled = true
      if (cleanup) cleanup()
    }
  }, [fetchKbs])


  const activeKb = kbs.find(kb => kb.id === selectedKb)

  async function handleCreateKb() {
    if (!createName.trim()) return
    setCreating(true)
    try {
      await fetch('/api/knowledge-base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName, description: createDesc || null, agent_id: createAgent || null, color: createColor }),
      })
      setCreateOpen(false)
      setCreateName('')
      setCreateDesc('')
      setCreateAgent('')
      await fetchKbs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  async function handleDeleteKb(kbId: string) {
    if (!confirm('Delete this knowledge base and all its documents?')) return
    await fetch(`/api/knowledge-base/${kbId}`, { method: 'DELETE' })
    setSelectedKb(null)
    await fetchKbs()
  }

  async function handleRenameKb(kbId: string, newName: string) {
    await fetch(`/api/knowledge-base/${kbId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    })
    setKbs(prev => prev.map(kb => kb.id === kbId ? { ...kb, name: newName } : kb))
  }

  function openEditDialog(kb: KnowledgeBaseWithDocs) {
    setEditingId(kb.id)
    setEditName(kb.name)
    setEditDesc(kb.description || '')
    setEditAgent(kb.agent_id || '')
    setEditColor((kb as unknown as { color?: string }).color || 'Blue')
    setEditOpen(true)
  }

  async function handleSaveEdit() {
    if (!editingId || !editName.trim()) return
    setSavingEdit(true)
    // Optimistic update
    setKbs(prev => prev.map(kb => kb.id === editingId
      ? { ...kb, name: editName, description: editDesc || null, agent_id: editAgent || null, color: editColor } as KnowledgeBaseWithDocs
      : kb))
    setEditOpen(false)
    try {
      await fetch(`/api/knowledge-base/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editName,
          description: editDesc || null,
          agent_id: editAgent || null,
          color: editColor,
        }),
      })
      await fetchKbs()
    } catch {
      setError('Failed to save changes')
      await fetchKbs()
    } finally {
      setSavingEdit(false)
    }
  }

  /**
   * Upload one file with real progress via XHR (fetch can't report upload
   * progress cross-browser yet). Updates the per-task state in uploadQueue.
   * Parallel with other uploads — each call is independent.
   */
  function uploadOne(kbId: string, task: UploadTask): Promise<void> {
    return new Promise((resolve) => {
      const formData = new FormData()
      formData.append('file', task.file)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/knowledge-base/${kbId}/upload`)

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        // Real upload goes 0 → 100 %. Once the body is fully sent, we
        // flip to a "processing" state that shows an indeterminate
        // spinner until the server returns — chunking + OpenAI
        // embeddings take several seconds on larger files, and pretending
        // those are "part of the upload" is misleading.
        const pct = Math.round((e.loaded / e.total) * 100)
        setUploadQueue(prev => prev.map(t => t.clientId === task.clientId
          ? {
              ...t,
              progress: pct,
              // When the byte-level upload hits 100 we switch status
              // immediately; the server response arrives a moment later.
              status: pct >= 100 ? 'processing' : 'uploading',
            }
          : t))
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let docId: string | undefined
          try { docId = JSON.parse(xhr.responseText)?.id } catch { /* ignore */ }
          setUploadQueue(prev => prev.map(t => t.clientId === task.clientId
            ? { ...t, status: 'done', progress: 100, docId }
            : t))
        } else {
          const msg = safeXhrMessage(xhr) || `Upload failed (${xhr.status})`
          setUploadQueue(prev => prev.map(t => t.clientId === task.clientId
            ? { ...t, status: 'error', error: msg }
            : t))
        }
        resolve()
      }

      xhr.onerror = () => {
        setUploadQueue(prev => prev.map(t => t.clientId === task.clientId
          ? { ...t, status: 'error', error: 'Network error' }
          : t))
        resolve()
      }

      xhr.send(formData)
    })
  }

  async function handleUploadFiles(files: File[]) {
    if (!selectedKb || files.length === 0) return

    const kbId = selectedKb
    const tasks: UploadTask[] = files.map(f => ({
      clientId: typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
      file: f,
      status: 'uploading',
      progress: 0,
    }))

    // Optimistic: show every file in the queue immediately.
    setUploadQueue(prev => [...tasks, ...prev])

    // Upload all in parallel. Each promise resolves regardless of outcome
    // so one failure doesn't block the others.
    await Promise.all(tasks.map(t => uploadOne(kbId, t)))

    // Refresh server state so the docs appear in the real list with their
    // server-generated ids, status, char_count etc.
    await fetchKbs()

    // Auto-clear completed tasks after a short delay so the UI doesn't
    // accumulate forever. Errors stick until the user dismisses them.
    setTimeout(() => {
      setUploadQueue(prev => prev.filter(t => t.status !== 'done'))
    }, 2000)
  }

  function dismissUploadTask(clientId: string) {
    setUploadQueue(prev => prev.filter(t => t.clientId !== clientId))
  }

  /**
   * Actually perform the delete(s). Runs in parallel for bulk so a large
   * selection doesn't block the UI one-by-one. Only called after the user
   * confirms in the modal.
   */
  async function executeDelete() {
    if (!selectedKb || !deleteTarget) return
    setDeleting(true)
    const kbId = selectedKb
    const ids = deleteTarget.kind === 'single' ? [deleteTarget.id] : deleteTarget.ids

    // Optimistic: remove rows from the current KB's doc list immediately.
    // If the request fails we'll refetch and they'll reappear.
    setKbs(prev => prev.map(kb => kb.id === kbId
      ? { ...kb, kb_documents: (kb.kb_documents || []).filter(d => !ids.includes(d.id)) }
      : kb))
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })

    try {
      await Promise.all(
        ids.map(id =>
          fetch(`/api/knowledge-base/${kbId}/documents/${id}`, { method: 'DELETE' })
        )
      )
    } catch {
      setError('Some deletes failed')
    }
    setDeleting(false)
    setDeleteTarget(null)
    await fetchKbs()
  }

  function toggleDocSelected(docId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(docId)) next.delete(docId)
      else next.add(docId)
      return next
    })
  }

  // Reindex: re-run extraction + chunking + embedding against the
  // already-stored binary. Used after a chunker/extractor upgrade to
  // refresh existing docs without the user having to re-upload. The
  // per-row set keeps the button's spinner state isolated so multiple
  // reindexes can run in parallel without stomping each other.
  const [reindexing, setReindexing] = useState<Set<string>>(new Set())
  const reindexDoc = useCallback(async (kbId: string, docId: string, docName: string) => {
    if (reindexing.has(docId)) return
    setReindexing((prev) => {
      const next = new Set(prev)
      next.add(docId)
      return next
    })
    // Optimistic: reflect processing status immediately in the list.
    setKbs((prev) => prev.map((kb) =>
      kb.id === kbId
        ? {
            ...kb,
            kb_documents: (kb.kb_documents || []).map((d) =>
              d.id === docId ? { ...d, status: 'processing' as const } : d
            ),
          }
        : kb
    ))
    try {
      const res = await fetch(
        `/api/knowledge-base/${kbId}/documents/${docId}/reindex`,
        { method: 'POST' }
      )
      const data = await res.json().catch(() => ({})) as { error?: string; chunk_count?: number }
      if (!res.ok) {
        setError(data.error ?? `Reindex failed for "${docName}"`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reindex failed')
    } finally {
      setReindexing((prev) => {
        const next = new Set(prev)
        next.delete(docId)
        return next
      })
      await fetchKbs()
    }
  }, [fetchKbs, reindexing])

  // ---- Detail view ----
  if (selectedKb && activeKb) {
    const docs = activeKb.kb_documents || []
    const agentName = agents.find(a => a.id === activeKb.agent_id)?.name

    return (
      <div className="flex h-full bg-[#f5f5f5] overflow-hidden gap-3 p-3 pl-0">
        {/* Docs list panel — flex-fills when no viewer, shrinks when
            viewer opens. The viewer is a sibling <Panel> in this same
            flex row, matching the inbox's three-column layout. */}
        <Panel
          className="flex-1 min-w-0"
          bodyClassName="overflow-auto"
          header={
            <>
              <button
                onClick={() => setSelectedKb(null)}
                className="rounded-md p-1 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#2e2e2e]"
                aria-label="Back to knowledge bases"
              >
                <ArrowLeft size={16} />
              </button>
              <span className="text-sm font-semibold text-[#2e2e2e] truncate">{capitalizeFirst(activeKb.name)}</span>
              {agentName && <Badge variant="secondary" className="text-xs">{agentName}</Badge>}
              <div className="ml-auto flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.markdown,.log,.csv,.tsv,.json,.html,.htm,.rtf,.pdf,.doc,.docx,.odt,.xls,.xlsx,.xlsm,.ods,.ppt,.pptx,.odp,.eml,.msg,.epub,.png,.jpg,.jpeg,.tiff,.tif,.bmp"
                  className="hidden"
                  onChange={e => {
                    const files = e.target.files ? Array.from(e.target.files) : []
                    if (files.length > 0) handleUploadFiles(files)
                    e.target.value = ''
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={uploadQueue.some(t => t.status === 'uploading')}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={14} className="mr-1.5" />
                  {uploadQueue.some(t => t.status === 'uploading') ? 'Uploading...' : 'Upload'}
                </Button>
                <Button variant="destructive" size="icon-sm" onClick={() => handleDeleteKb(activeKb.id)} aria-label="Delete knowledge base">
                  <Trash size={14} />
                </Button>
              </div>
            </>
          }
        >

        {/* Unified documents list. In-flight upload tasks render as rows
            in the same layout so the experience feels continuous — the
            only difference is the Status column shows a progress bar
            instead of a badge while uploading. */}
        {docs.length === 0 && uploadQueue.length === 0 ? (
          <div className="m-6 flex flex-col items-center justify-center py-20 border border-dashed border-[#d4d4d4] rounded-xl bg-[#fafafa]">
            <div className="h-12 w-12 rounded-full bg-[#f0f0f0] flex items-center justify-center mb-3">
              <FileText size={22} className="text-[#a3a3a3]" />
            </div>
            <div className="text-sm font-medium text-[#525252]">No documents yet</div>
            <div className="text-xs text-[#a3a3a3] mt-1 mb-4">Upload a file to get started</div>
            <Button
              size="sm"
              disabled={uploadQueue.some(t => t.status === 'uploading')}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} className="mr-1.5" />Upload files
            </Button>
          </div>
        ) : (
          // Column widths shrink when the canvas (document viewer) is
          // open — the panel is narrower so we need tighter columns to
          // keep everything readable. Wrapper min-w enforces a horizontal
          // scroll threshold appropriate for each mode.
          //
          // "Canvas" is the forward-looking name for the side viewer.
          // Today it renders KB files (PDF / DOCX / XLSX / …); tomorrow
          // it'll also render rich HTML / code previews / chart panels.
          <div className={viewerDocId ? "min-w-[592px]" : "min-w-[720px]"}>
            {/* Bulk actions bar — appears above the header when anything
                is selected. Replaces the static header row visually
                without jumping the layout. */}
            {selected.size > 0 && (
              <div className={`grid ${viewerDocId ? 'grid-cols-[minmax(180px,1fr)_90px_100px_120px_32px]' : 'grid-cols-[minmax(200px,1fr)_110px_130px_160px_32px]'} items-center gap-3 px-6 h-[46px] bg-[#f5f5f5] border-b border-black/[0.04]`}>
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={docs.length > 0 && selected.size === docs.length}
                    indeterminate={selected.size > 0 && selected.size < docs.length}
                    onCheckedChange={() => {
                      if (selected.size === docs.length) setSelected(new Set())
                      else setSelected(new Set(docs.map(d => d.id)))
                    }}
                  />
                  <span className="text-xs font-medium text-[#2e2e2e]">
                    {selected.size} selected
                  </span>
                </div>
                <div className="col-span-5 flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-[#737373]"
                    onClick={() => setSelected(new Set())}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setDeleteTarget({ kind: 'bulk', ids: Array.from(selected) })}
                  >
                    <Trash size={12} className="mr-1" />
                    Delete {selected.size}
                  </Button>
                </div>
              </div>
            )}

            {/* Column headers. Grid widths match the row grid below.
                Include a leading select-all checkbox column to match
                the per-row select column. Header is hidden while the
                bulk-actions bar is shown (it replaces the header).
                Fixed height (46px) matches the bulk-actions bar so the
                layout doesn't jump when selection state changes. */}
            {selected.size === 0 && (
              <div className={`grid ${viewerDocId ? 'grid-cols-[minmax(180px,1fr)_90px_100px_120px_32px]' : 'grid-cols-[minmax(200px,1fr)_110px_130px_160px_32px]'} items-center gap-3 px-6 h-[46px] bg-[#fafafa] text-[11px] font-medium tracking-wide text-[#737373] uppercase`}>
                <div className="flex items-center gap-3">
                  <span className="flex size-[18px] items-center justify-center shrink-0">
                    <Checkbox
                      checked={docs.length > 0 && selected.size === docs.length}
                      indeterminate={selected.size > 0 && selected.size < docs.length}
                      onCheckedChange={() => {
                        if (selected.size === docs.length) setSelected(new Set())
                        else setSelected(new Set(docs.map(d => d.id)))
                      }}
                    />
                  </span>
                  <span>Name</span>
                </div>
                <div>Size</div>
                <div>Uploaded</div>
                <div>Status</div>
                <div />
              </div>
            )}

            {/* In-flight upload rows first — appear at top so user sees
                their action reflected immediately. */}
            {uploadQueue.map(task => (
              <div
                key={task.clientId}
                className={`grid ${viewerDocId ? 'grid-cols-[minmax(180px,1fr)_90px_100px_120px_32px]' : 'grid-cols-[minmax(200px,1fr)_110px_130px_160px_32px]'} items-center gap-3 px-6 py-3 border-t border-black/[0.04] bg-[#fafafa]/40`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {/* File-icon slot shows upload status instead of the
                      static file icon while the task is in flight: an
                      animated circular progress arc during upload, a
                      green check momentarily when done, or a red alert
                      dot on failure. Once the task clears from the queue
                      (~2s after done) the real doc row renders with the
                      format-specific DocumentTypeIcon. */}
                  <UploadStatusIcon status={task.status} progress={task.progress} />
                  <span className="text-sm font-medium text-[#2e2e2e] truncate">
                    {capitalizeFirst(task.file.name)}
                  </span>
                </div>
                <div className="text-xs text-[#737373]">
                  {formatBytes(task.file.size)}
                </div>
                <div className="text-xs text-[#737373]">
                  Just now
                </div>
                <div>
                  {task.status === 'error' ? (
                    <span className="text-xs text-red-600 truncate block">{task.error}</span>
                  ) : task.status === 'done' ? (
                    <Badge variant="secondary" className="text-xs bg-emerald-50 text-emerald-700">Done</Badge>
                  ) : task.status === 'processing' ? (
                    <Badge variant="secondary" className="text-xs bg-blue-50 text-blue-700">
                      Processing…
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs bg-blue-50 text-blue-700">
                      Uploading · {task.progress}%
                    </Badge>
                  )}
                </div>
                <div className="sticky right-0 flex items-center justify-end pr-6 pl-3">
                  {(task.status === 'error' || task.status === 'done') && (
                    // Upload rows don't have a `group` hover trigger
                    // (they're transient), so force the chip visible by
                    // adding `opacity-100` override.
                    <RowActions className="opacity-100">
                      <RowActionButton
                        label="Dismiss"
                        onClick={() => dismissUploadTask(task.clientId)}
                      >
                        <X size={13} />
                      </RowActionButton>
                    </RowActions>
                  )}
                </div>
              </div>
            ))}

            {/* Real documents.
                The leading cell shows either a file icon OR a checkbox
                depending on state:
                  - default:         file icon
                  - hovered:         checkbox fades in over the file icon
                  - selected:        checkbox only (no file icon)
                The trash action fades in on hover and opens a confirm modal.
                Filter: hide docs whose id matches an in-flight upload
                task's docId, to prevent the brief window where both the
                optimistic upload row AND the server-inserted doc row
                render the same file side-by-side. */}
            {docs
              .filter((doc) => !uploadQueue.some((t) => t.docId === doc.id && t.status !== 'error'))
              .map(doc => {
              const isSelected = selected.has(doc.id)
              const isViewing = viewerDocId === doc.id
              return (
                <div
                  key={doc.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setViewerDocId(doc.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setViewerDocId(doc.id) }}
                  className={`cursor-pointer grid ${viewerDocId ? 'grid-cols-[minmax(180px,1fr)_90px_100px_120px_32px]' : 'grid-cols-[minmax(200px,1fr)_110px_130px_160px_32px]'} items-center gap-3 px-6 py-3 border-t border-black/[0.04] group transition-colors ${
                    isViewing ? 'bg-blue-50/60' : isSelected ? 'bg-[#fafafa]' : 'hover:bg-[#fafafa]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Icon/checkbox swap slot. Container is a fixed-size
                        relative positioning context; the two children are
                        absolutely positioned so they perfectly overlap
                        regardless of their own intrinsic dimensions. */}
                    <div className="relative h-[18px] w-[18px] shrink-0">
                      {/* Format-specific file icon — default state.
                          Colored per extension (PDF red, DOCX blue,
                          XLSX green, etc.) so the list reads as a
                          typed-file view, not a sea of identical
                          glyphs. */}
                      <span
                        className={`absolute inset-0 pointer-events-none transition-opacity ${
                          isSelected ? 'opacity-0' : 'opacity-100 group-hover:opacity-0'
                        }`}
                      >
                        <DocumentTypeIcon name={doc.name} fileType={doc.file_type} />
                      </span>
                      {/* Checkbox — fades in on hover OR when selected.
                          Use pointer-events-none + auto-on-visible so the
                          hidden state doesn't intercept clicks. */}
                      <div
                        className={`absolute inset-0 flex items-center justify-center transition-opacity ${
                          isSelected
                            ? 'opacity-100 pointer-events-auto'
                            : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
                        }`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleDocSelected(doc.id)}
                          aria-label={`Select ${doc.name}`}
                        />
                      </div>
                    </div>
                    <span className="text-sm font-medium text-[#2e2e2e] truncate">
                      {capitalizeFirst(doc.name)}
                    </span>
                  </div>
                  <div className="text-xs text-[#737373]" title={`${doc.char_count.toLocaleString()} chars`}>
                    {doc.file_size != null
                      ? formatBytes(doc.file_size)
                      : `${(doc.char_count / 1000).toFixed(1)}k chars`}
                  </div>
                  <div className="text-xs text-[#737373]" title={new Date(doc.created_at).toLocaleString()}>
                    {formatRelative(doc.created_at)}
                  </div>
                  <div>
                    <Badge variant="secondary" className={`text-xs ${statusStyles[doc.status] || ''}`}>
                      {capitalizeFirst(doc.status)}
                    </Badge>
                  </div>
                  {/* Actions chip: sticky to the right edge so it stays
                      visible when the table overflows horizontally. The
                      chip itself carries the visual weight (white bg +
                      shadow), so no row-bg trickery is needed — it reads
                      as a floating control surface on any row color. */}
                  <div className="sticky right-0 flex items-center justify-end pr-6 pl-3">
                    <RowActions>
                      <RowActionButton
                        label={reindexing.has(doc.id) ? 'Reindexing…' : 'Reindex — refresh embeddings'}
                        disabled={reindexing.has(doc.id) || doc.status === 'processing'}
                        onClick={() => reindexDoc(activeKb.id, doc.id, doc.name)}
                      >
                        <ArrowClockwise
                          size={13}
                          className={reindexing.has(doc.id) ? 'animate-spin' : ''}
                        />
                      </RowActionButton>
                      <RowActionButton
                        label="Delete document"
                        destructive
                        onClick={() => setDeleteTarget({ kind: 'single', id: doc.id, name: doc.name })}
                      >
                        <Trash size={13} />
                      </RowActionButton>
                    </RowActions>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <p className="text-xs text-[#a3a3a3] mt-4 mb-6 px-6 text-center">Supports docs (.txt, .md, .pdf, .doc/.docx, .odt, .rtf, .html, .epub), sheets (.csv, .tsv, .xls/.xlsx, .ods), slides (.ppt/.pptx, .odp), data (.json), email (.eml, .msg), and images (.png, .jpg, .tiff) · select multiple to upload in parallel</p>

        {/* Delete confirmation modal — covers both single and bulk.
            Rendered here (inside the detail view) so the state is co-located
            with the docs list that triggers it. */}
        <Dialog
          open={deleteTarget !== null}
          onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null) }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {deleteTarget?.kind === 'bulk'
                  ? `Delete ${deleteTarget.ids.length} document${deleteTarget.ids.length === 1 ? '' : 's'}?`
                  : 'Delete this document?'}
              </DialogTitle>
              <DialogDescription>
                {deleteTarget?.kind === 'single'
                  ? <>This will permanently remove <span className="font-medium text-[#2e2e2e]">{deleteTarget.name}</span> and all of its embeddings from the knowledge base. This cannot be undone.</>
                  : 'This will permanently remove the selected documents and their embeddings from the knowledge base. This cannot be undone.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={executeDelete} disabled={deleting}>
                <Trash size={14} className="mr-1.5" />
                {deleting ? 'Deleting…' : (deleteTarget?.kind === 'bulk' ? `Delete ${deleteTarget.ids.length}` : 'Delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </Panel>

        {/* File viewer — a SIBLING Panel in the same flex row, exactly
            like the inbox's Details panel. Resizable from its right
            edge via the shared Panel primitive; width persists in
            localStorage under the storageKey. */}
        {viewerDocId && (
          <Panel
            resizable
            resizeFrom="left"
            defaultWidth={520}
            minWidth={360}
            maxWidth={960}
            storageKey="kb:viewer-width"
          >
            <KbFileViewer
              kbId={selectedKb}
              docId={viewerDocId}
              onClose={() => setViewerDocId(null)}
              onSaved={() => { fetchKbs() }}
            />
          </Panel>
        )}
      </div>
    )
  }

  // ---- Folder grid view ----
  // Own its own page chrome now that the layout no longer wraps /knowledge
  // in a white card + header. Matches the inbox/agents pattern:
  // grey shell + a single Panel owning the page content with its own
  // 48px header.
  return (
    <div className="flex h-full bg-[#f5f5f5] overflow-hidden gap-3 p-3 pl-0">
      <Panel
        className="flex-1"
        bodyClassName="overflow-auto p-6"
        header={
          <>
            <span className="text-sm font-semibold text-[#2e2e2e]">Knowledge</span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" className="rounded-full" onClick={() => setCreateOpen(true)}>
                <Plus size={14} />
                New folder
              </Button>
            </div>
          </>
        }
      >
      <div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Knowledge Base</DialogTitle>
              <DialogDescription>Add a knowledge base to train your agent with custom content.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label className="text-sm">Name</Label>
                <Input placeholder="e.g. Product Documentation" value={createName} onChange={e => setCreateName(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label className="text-sm">Description</Label>
                <Textarea placeholder="What kind of knowledge will this contain?" value={createDesc} onChange={e => setCreateDesc(e.target.value)} rows={2} />
              </div>
              <div className="grid gap-2">
                <Label className="text-sm">Color</Label>
                <FolderColorPicker value={createColor} onChange={setCreateColor} />
              </div>
              <div className="grid gap-2">
                <Label className="text-sm">Assign to Agent</Label>
                <Select value={createAgent} onValueChange={v => v && setCreateAgent(v)}>
                  <SelectTrigger><SelectValue placeholder="Select an agent (optional)" /></SelectTrigger>
                  <SelectContent>
                    {agents.map(agent => (
                      <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={handleCreateKb} disabled={creating || !createName.trim()}>
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit knowledge base dialog */}
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Knowledge Base</DialogTitle>
              <DialogDescription>Update the name, description, color, or assigned agent.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label className="text-sm">Name</Label>
                <Input value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label className="text-sm">Description</Label>
                <Textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={2} />
              </div>
              <div className="grid gap-2">
                <Label className="text-sm">Color</Label>
                <FolderColorPicker value={editColor} onChange={setEditColor} />
              </div>
              <div className="grid gap-2">
                <Label className="text-sm">Assigned agent</Label>
                <Select value={editAgent} onValueChange={v => setEditAgent(v === '__none__' || !v ? '' : String(v))}>
                  <SelectTrigger><SelectValue placeholder="No agent" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No agent</SelectItem>
                    {agents.map(agent => (
                      <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="secondary" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={handleSaveEdit} disabled={savingEdit || !editName.trim()}>
                {savingEdit ? 'Saving...' : 'Save changes'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-4">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {loading && (
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
          {[1, 2, 3, 4].map(i => (
            <div key={i}>
              <Skeleton className="rounded-2xl" style={{ aspectRatio: "4/3" }} />
              <Skeleton className="h-4 w-24 mt-3" />
              <Skeleton className="h-3 w-16 mt-1" />
            </div>
          ))}
        </div>
      )}

      {!loading && !error && kbs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 border border-dashed border-[#d4d4d4] rounded-xl bg-[#fafafa]">
          <div className="h-12 w-12 rounded-full bg-[#f0f0f0] flex items-center justify-center mb-3">
            <Database size={22} weight="duotone" className="text-[#737373]" />
          </div>
          <div className="text-sm font-medium text-[#525252]">No knowledge bases yet</div>
          <div className="text-xs text-[#a3a3a3] mt-1 mb-4">Create a knowledge base and upload documents to train your agents</div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} weight="bold" className="mr-1.5" />
            New folder
          </Button>
        </div>
      )}

      {!loading && kbs.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
          {kbs.map(kb => (
            <FolderCard
              key={kb.id}
              id={kb.id}
              name={kb.name}
              docCount={kb.kb_documents?.length || 0}
              color={(kb as unknown as { color?: string }).color}
              lastUpdated={kb.updated_at}
              onClick={() => setSelectedKb(kb.id)}
              onRename={(newName) => handleRenameKb(kb.id, newName)}
              contextActions={[
                { label: "Open", icon: <ArrowLeft size={14} className="rotate-180" />, onClick: () => setSelectedKb(kb.id) },
                { label: "Edit", icon: <PencilSimple size={14} />, onClick: () => openEditDialog(kb) },
                { label: "Rename", icon: <FileText size={14} />, onClick: () => {} },
                { label: "Upload files", icon: <Upload size={14} />, onClick: () => { setSelectedKb(kb.id); setTimeout(() => fileInputRef.current?.click(), 100) } },
                { label: "Delete", icon: <Trash size={14} />, onClick: () => handleDeleteKb(kb.id), destructive: true, divider: true },
              ] as FolderAction[]}
            />
          ))}
        </div>
      )}

      {/* Recent files — flattens docs across every KB in the workspace
          and shows the 10 most recently uploaded. Click a row to jump to
          the owning KB. Uses the same table style as the KB detail view. */}
      {!loading && kbs.length > 0 && (() => {
        const recentFiles = kbs
          .flatMap(kb => (kb.kb_documents || []).map(doc => ({ doc, kb })))
          .sort((a, b) => new Date(b.doc.created_at).getTime() - new Date(a.doc.created_at).getTime())
          .slice(0, 10)

        if (recentFiles.length === 0) return null

        return (
          <div className="mt-8">
            <h2 className="text-sm font-semibold text-[#2e2e2e] mb-3">Recent files</h2>
            <div className="rounded-xl border border-black/[0.04] overflow-hidden">
              {/* Column headers. Width template differs slightly from the
                  KB detail table: no select column, plus a "Knowledge base"
                  column to show where each file lives. */}
              <div className="grid grid-cols-[1fr_140px_110px_130px_140px] items-center gap-3 px-4 h-[46px] bg-[#fafafa] text-[11px] font-medium tracking-wide text-[#737373] uppercase">
                <div>Name</div>
                <div>Knowledge base</div>
                <div>Size</div>
                <div>Uploaded</div>
                <div>Status</div>
              </div>

              {recentFiles.map(({ doc, kb }) => (
                <button
                  key={doc.id}
                  onClick={() => {
                    // Navigate into the KB AND preselect the doc so the
                    // viewer opens immediately. The detail view reads both
                    // pieces of state — setSelectedKb would otherwise reset
                    // viewerDocId via the useEffect that watches selectedKb,
                    // so set selectedKb first and defer viewerDocId one tick.
                    setSelectedKb(kb.id)
                    queueMicrotask(() => setViewerDocId(doc.id))
                  }}
                  className="w-full text-left grid grid-cols-[1fr_140px_110px_130px_140px] items-center gap-3 px-4 py-3 border-t border-black/[0.04] hover:bg-[#fafafa] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <DocumentTypeIcon name={doc.name} fileType={doc.file_type} />
                    <span className="text-sm font-medium text-[#2e2e2e] truncate">
                      {capitalizeFirst(doc.name)}
                    </span>
                  </div>
                  <div className="text-xs text-[#525252] truncate">
                    {kb.name}
                  </div>
                  <div className="text-xs text-[#737373]" title={`${doc.char_count.toLocaleString()} chars`}>
                    {doc.file_size != null
                      ? formatBytes(doc.file_size)
                      : `${(doc.char_count / 1000).toFixed(1)}k chars`}
                  </div>
                  <div className="text-xs text-[#737373]" title={new Date(doc.created_at).toLocaleString()}>
                    {formatRelative(doc.created_at)}
                  </div>
                  <div>
                    <Badge variant="secondary" className={`text-xs ${statusStyles[doc.status] || ''}`}>
                      {capitalizeFirst(doc.status)}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )
      })()}
      </Panel>
    </div>
  )
}
