'use client'

import { useCallback, useEffect, useState } from 'react'
import { Brain, Plus, Trash, PencilSimple, Check, X, Globe, Lock, Lightbulb, Sparkle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { HeaderActions } from '@/components/ui/header-actions'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'

interface MemoryRow {
  id: string
  content: string
  is_shared: boolean
  source: 'auto' | 'explicit' | 'manual'
  importance: number
  created_at: string
  updated_at: string
  last_accessed_at: string
  user_id: string
  owner_name: string
  is_own: boolean
}

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

function SourceBadge({ source }: { source: MemoryRow['source'] }) {
  const map: Record<MemoryRow['source'], { label: string; icon: typeof Brain; className: string }> = {
    auto: { label: 'Learned', icon: Sparkle, className: 'bg-blue-50 text-blue-700' },
    explicit: { label: 'Told', icon: Lightbulb, className: 'bg-amber-50 text-amber-700' },
    manual: { label: 'Added', icon: PencilSimple, className: 'bg-neutral-100 text-neutral-600' },
  }
  const m = map[source]
  const Icon = m.icon
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${m.className}`}>
      <Icon size={11} weight="bold" />
      {m.label}
    </span>
  )
}

export default function MemoriesPage() {
  const [rows, setRows] = useState<MemoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState<'all' | 'mine' | 'shared'>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newShared, setNewShared] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const load = useCallback(async (s: typeof scope) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/memories?scope=${s}`)
      if (res.ok) {
        const data = await res.json() as MemoryRow[]
        setRows(data)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(scope) }, [scope, load])

  async function createMemory() {
    if (!newContent.trim()) return
    setCreating(true)
    // Optimistic — add a placeholder row so the list updates instantly.
    const temp: MemoryRow = {
      id: `temp-${Date.now()}`,
      content: newContent.trim(),
      is_shared: newShared,
      source: 'manual',
      importance: 7,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString(),
      user_id: '',
      owner_name: 'You',
      is_own: true,
    }
    setRows((prev) => [temp, ...prev])
    setCreateOpen(false)
    const payload = { content: newContent.trim(), is_shared: newShared }
    setNewContent('')
    setNewShared(false)
    try {
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        setRows((prev) => prev.filter((r) => r.id !== temp.id))
      } else {
        // Refetch so the temp row is replaced by the authoritative one.
        await load(scope)
      }
    } finally {
      setCreating(false)
    }
  }

  async function toggleShare(row: MemoryRow) {
    if (!row.is_own) return
    const next = !row.is_shared
    setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, is_shared: next } : r))
    await fetch(`/api/memories/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_shared: next }),
    })
  }

  async function saveEdit(row: MemoryRow) {
    const trimmed = editText.trim()
    if (trimmed.length < 3 || trimmed === row.content) {
      setEditingId(null)
      return
    }
    setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, content: trimmed } : r))
    setEditingId(null)
    await fetch(`/api/memories/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: trimmed }),
    })
  }

  async function deleteMemory(row: MemoryRow) {
    if (!confirm('Delete this memory? Your internal agents will forget it.')) return
    setRows((prev) => prev.filter((r) => r.id !== row.id))
    await fetch(`/api/memories/${row.id}`, { method: 'DELETE' })
  }

  return (
    <>
      <HeaderActions>
        <Tabs value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
          <TabsList className="h-8">
            <TabsTrigger value="all" className="text-[12px]">All</TabsTrigger>
            <TabsTrigger value="mine" className="text-[12px]">Mine</TabsTrigger>
            <TabsTrigger value="shared" className="text-[12px]">Shared</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus size={14} weight="bold" />
          Add memory
        </Button>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add memory</DialogTitle>
              <DialogDescription>
                Internal agents will reference this across conversations.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="e.g. User prefers replies in Hindi; lead all emails with a TL;DR."
              rows={4}
              className="text-[13px]"
            />
            <div className="flex items-center justify-between rounded-lg bg-[#fafafa] px-3 py-2">
              <div>
                <div className="text-[13px] font-medium text-[#2e2e2e]">Share with team</div>
                <div className="text-[11px] text-[#737373]">Other members can reference this memory too.</div>
              </div>
              <Switch checked={newShared} onCheckedChange={(v) => setNewShared(v)} />
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button onClick={createMemory} disabled={creating || newContent.trim().length < 3}>Save memory</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </HeaderActions>

      <div className="mx-auto max-w-3xl p-6">
        <div className="mb-5 flex items-start gap-3 rounded-lg bg-[#fafafa] px-4 py-3 ring-1 ring-black/[0.04]">
          <Brain size={18} weight="bold" className="mt-0.5 flex-shrink-0 text-[#737373]" />
          <div className="flex-1">
            <div className="text-[13px] font-medium text-[#2e2e2e]">
              Memories give your internal agents long-term recall
            </div>
            <div className="text-[12px] text-[#737373] mt-0.5">
              Any time you chat with an internal agent, it will quietly learn and remember useful facts.
              Say &quot;remember that …&quot; to save something explicitly, or add one below.
              Memories are private to you unless you share them with your team.
            </div>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[#d4d4d4] bg-[#fafafa] py-16">
            <Brain size={32} weight="duotone" className="text-[#c4c4c4]" />
            <div className="mt-3 text-[13px] font-medium text-[#737373]">
              {scope === 'shared' ? 'No shared memories yet' : 'No memories yet'}
            </div>
            <div className="mt-1 text-[12px] text-[#a3a3a3]">
              {scope === 'shared'
                ? 'Memories shared across your team will appear here.'
                : 'Chat with an internal agent or add one manually.'}
            </div>
            {scope !== 'shared' && (
              <Button size="sm" className="mt-3 gap-1.5" onClick={() => setCreateOpen(true)}>
                <Plus size={14} weight="bold" />
                Add memory
              </Button>
            )}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((row) => (
              <li
                key={row.id}
                className="group rounded-lg bg-white px-4 py-3 ring-1 ring-black/[0.04] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-shadow hover:shadow-[0_1px_4px_rgba(0,0,0,0.06)]"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    {editingId === row.id ? (
                      <div className="space-y-2">
                        <Textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={3}
                          className="text-[13px]"
                          autoFocus
                        />
                        <div className="flex gap-2">
                          <Button size="sm" className="h-7 gap-1" onClick={() => saveEdit(row)}>
                            <Check size={12} weight="bold" />
                            Save
                          </Button>
                          <Button size="sm" variant="secondary" className="h-7 gap-1" onClick={() => setEditingId(null)}>
                            <X size={12} weight="bold" />
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-[13px] leading-relaxed text-[#2e2e2e]">
                        {row.content}
                      </div>
                    )}
                    {editingId !== row.id && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#a3a3a3]">
                        <SourceBadge source={row.source} />
                        {row.is_shared && (
                          <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[11px]">
                            <Globe size={11} weight="bold" />
                            Shared
                          </Badge>
                        )}
                        {!row.is_own && <span>by {row.owner_name}</span>}
                        <span>·</span>
                        <span>{formatRelative(row.created_at)}</span>
                      </div>
                    )}
                  </div>

                  {row.is_own && editingId !== row.id && (
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => toggleShare(row)}
                        title={row.is_shared ? 'Make private' : 'Share with team'}
                        className="rounded p-1.5 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#2e2e2e]"
                      >
                        {row.is_shared
                          ? <Globe size={14} weight="bold" />
                          : <Lock size={14} weight="bold" />}
                      </button>
                      <button
                        onClick={() => { setEditingId(row.id); setEditText(row.content) }}
                        title="Edit"
                        className="rounded p-1.5 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#2e2e2e]"
                      >
                        <PencilSimple size={14} weight="bold" />
                      </button>
                      <button
                        onClick={() => deleteMemory(row)}
                        title="Delete"
                        className="rounded p-1.5 text-[#737373] hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash size={14} weight="bold" />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
