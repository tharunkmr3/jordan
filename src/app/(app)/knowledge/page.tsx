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
import { Plus, Trash, Upload, Database, ArrowLeft, FileText, X, PencilSimple } from '@phosphor-icons/react'

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
        // Leave 5% at the top for server-side processing (chunk + embed).
        const pct = Math.min(95, Math.round((e.loaded / e.total) * 95))
        setUploadQueue(prev => prev.map(t => t.clientId === task.clientId
          ? { ...t, progress: pct }
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

  async function handleDeleteDoc(docId: string) {
    if (!selectedKb) return
    await fetch(`/api/knowledge-base/${selectedKb}/documents/${docId}`, { method: 'DELETE' })
    await fetchKbs()
  }

  // ---- Detail view ----
  if (selectedKb && activeKb) {
    const docs = activeKb.kb_documents || []
    const agentName = agents.find(a => a.id === activeKb.agent_id)?.name

    return (
      <div className="p-6">
        <HeaderTitle>
          <button
            onClick={() => setSelectedKb(null)}
            className="rounded-md p-1 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#2e2e2e]"
            aria-label="Back to knowledge bases"
          >
            <ArrowLeft size={16} />
          </button>
          <span className="text-base font-semibold text-[#2e2e2e] truncate">{activeKb.name}</span>
          {agentName && <Badge variant="secondary" className="text-xs">{agentName}</Badge>}
        </HeaderTitle>

        <HeaderActions>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.pdf,.docx"
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
        </HeaderActions>

        {/* Unified documents list. In-flight upload tasks render as rows
            in the same layout so the experience feels continuous — the
            only difference is the Status column shows a progress bar
            instead of a badge while uploading. */}
        {docs.length === 0 && uploadQueue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 border border-dashed border-[#d4d4d4] rounded-xl bg-[#fafafa]">
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
          <div className="rounded-xl border border-black/[0.04] overflow-hidden">
            {/* Column headers. Grid widths match the row grid below. */}
            <div className="grid grid-cols-[1fr_90px_110px_130px_160px_32px] items-center gap-3 px-4 py-2.5 bg-[#fafafa] text-[11px] font-medium tracking-wide text-[#737373] uppercase">
              <div>Name</div>
              <div>Type</div>
              <div>Size</div>
              <div>Uploaded</div>
              <div>Status</div>
              <div />
            </div>

            {/* In-flight upload rows first — appear at top so user sees
                their action reflected immediately. */}
            {uploadQueue.map(task => (
              <div
                key={task.clientId}
                className="grid grid-cols-[1fr_90px_110px_130px_160px_32px] items-center gap-3 px-4 py-3 border-t border-black/[0.04] bg-[#fafafa]/40"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText size={18} className="text-[#737373] shrink-0" />
                  <span className="text-sm font-medium text-[#2e2e2e] truncate">
                    {capitalizeFirst(task.file.name)}
                  </span>
                </div>
                <div className="text-xs text-[#737373]">
                  {capitalizeFirst(fileExtension(task.file.name) || 'text')}
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
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1 rounded-full bg-black/[0.06] overflow-hidden">
                        <div
                          className="h-full bg-[#2e2e2e] transition-[width] duration-200"
                          style={{ width: `${task.progress}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-[#737373] shrink-0 w-8 text-right tabular-nums">
                        {task.progress}%
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex justify-end">
                  {(task.status === 'error' || task.status === 'done') && (
                    <button
                      onClick={() => dismissUploadTask(task.clientId)}
                      className="p-1 rounded text-[#a3a3a3] hover:text-[#2e2e2e] hover:bg-black/[0.04]"
                      aria-label="Dismiss"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}

            {/* Real documents */}
            {docs.map(doc => (
              <div
                key={doc.id}
                className="grid grid-cols-[1fr_90px_110px_130px_160px_32px] items-center gap-3 px-4 py-3 border-t border-black/[0.04] hover:bg-[#fafafa] group transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText size={18} className="text-[#737373] shrink-0" />
                  <span className="text-sm font-medium text-[#2e2e2e] truncate">
                    {capitalizeFirst(doc.name)}
                  </span>
                </div>
                <div className="text-xs text-[#737373]">
                  {capitalizeFirst(doc.file_type || 'text')}
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
                <div className="flex justify-end">
                  <button
                    onClick={() => handleDeleteDoc(doc.id)}
                    className="p-1 rounded text-[#a3a3a3] hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Delete document"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-[#a3a3a3] mt-4 text-center">Supports .txt, .md, .csv, .pdf, .docx · select multiple to upload in parallel</p>
      </div>
    )
  }

  // ---- Folder grid view ----
  return (
    <div className="p-6">
      <HeaderActions>
        <Button size="sm" className="rounded-full" onClick={() => setCreateOpen(true)}>
          <Plus size={14} />
          New Knowledge Base
        </Button>
      </HeaderActions>
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
            New Knowledge Base
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
    </div>
  )
}
