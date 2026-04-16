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
import { Plus, Trash, Upload, ChatDots, Database, ArrowLeft, FileText, X, PencilSimple } from '@phosphor-icons/react'

interface KnowledgeBaseWithDocs extends KnowledgeBase {
  kb_documents: KbDocument[]
}

const statusStyles: Record<string, string> = {
  ready: 'bg-emerald-50 text-emerald-700',
  processing: 'bg-blue-50 text-blue-700',
  pending: 'bg-neutral-50 text-neutral-500',
  error: 'bg-red-50 text-red-700',
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

  // FAQ dialog
  const [faqOpen, setFaqOpen] = useState(false)
  const [faqQuestion, setFaqQuestion] = useState('')
  const [faqAnswer, setFaqAnswer] = useState('')
  const [addingFaq, setAddingFaq] = useState(false)

  // Upload
  const [uploading, setUploading] = useState(false)
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

  async function handleUpload(file: File) {
    if (!selectedKb) return
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      await fetch(`/api/knowledge-base/${selectedKb}/upload`, { method: 'POST', body: formData })
      await fetchKbs()
    } catch {
      setError('Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleDeleteDoc(docId: string) {
    if (!selectedKb) return
    await fetch(`/api/knowledge-base/${selectedKb}/documents/${docId}`, { method: 'DELETE' })
    await fetchKbs()
  }

  async function handleAddFaq() {
    if (!selectedKb || !faqQuestion.trim() || !faqAnswer.trim()) return
    setAddingFaq(true)
    try {
      await fetch(`/api/knowledge-base/${selectedKb}/faq`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: faqQuestion, answer: faqAnswer }),
      })
      setFaqOpen(false)
      setFaqQuestion('')
      setFaqAnswer('')
      await fetchKbs()
    } catch {
      setError('Failed to add FAQ')
    } finally {
      setAddingFaq(false)
    }
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
            accept=".txt,.csv,.pdf,.docx"
            className="hidden"
            onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); e.target.value = '' }}
          />
          <Button variant="secondary" size="sm" onClick={() => { setFaqOpen(true) }}>
            <ChatDots size={14} className="mr-1.5" />Add FAQ
          </Button>
          <Button variant="secondary" size="sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            <Upload size={14} className="mr-1.5" />{uploading ? 'Uploading...' : 'Upload'}
          </Button>
          <Button variant="destructive" size="icon-sm" onClick={() => handleDeleteKb(activeKb.id)} aria-label="Delete knowledge base">
            <Trash size={14} />
          </Button>
        </HeaderActions>

        {/* Documents grid */}
        {docs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 border border-dashed border-[#d4d4d4] rounded-xl bg-[#fafafa]">
            <div className="h-12 w-12 rounded-full bg-[#f0f0f0] flex items-center justify-center mb-3">
              <FileText size={22} className="text-[#a3a3a3]" />
            </div>
            <div className="text-sm font-medium text-[#525252]">No documents yet</div>
            <div className="text-xs text-[#a3a3a3] mt-1 mb-4">Upload a file or add an FAQ to get started</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setFaqOpen(true)}>
                <ChatDots size={14} className="mr-1.5" />Add FAQ
              </Button>
              <Button size="sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                <Upload size={14} className="mr-1.5" />Upload File
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {docs.map(doc => (
              <div key={doc.id} className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-[#fafafa] group transition-colors">
                <FileText size={18} className="text-[#737373] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#2e2e2e] truncate">{doc.name}</div>
                  <div className="text-xs text-[#a3a3a3]">
                    {doc.file_type || 'text'} · {(doc.char_count / 1000).toFixed(1)}k chars
                  </div>
                </div>
                <Badge variant="secondary" className={`text-xs shrink-0 ${statusStyles[doc.status] || ''}`}>
                  {doc.status}
                </Badge>
                <button
                  onClick={() => handleDeleteDoc(doc.id)}
                  className="p-1 rounded text-[#a3a3a3] hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* FAQ dialog */}
        <Dialog open={faqOpen} onOpenChange={setFaqOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add FAQ</DialogTitle>
              <DialogDescription>Add a question-answer pair to train your agent.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label className="text-sm">Question</Label>
                <Textarea placeholder="e.g. What are your business hours?" value={faqQuestion} onChange={e => setFaqQuestion(e.target.value)} rows={2} />
              </div>
              <div className="grid gap-2">
                <Label className="text-sm">Answer</Label>
                <Textarea placeholder="e.g. We're open Mon-Fri 9am to 6pm IST." value={faqAnswer} onChange={e => setFaqAnswer(e.target.value)} rows={3} />
              </div>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={handleAddFaq} disabled={addingFaq || !faqQuestion.trim() || !faqAnswer.trim()}>
                {addingFaq ? 'Adding...' : 'Add FAQ'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <p className="text-xs text-[#a3a3a3] mt-4 text-center">Supports .txt, .csv, .pdf, .docx</p>
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
                { label: "Upload file", icon: <Upload size={14} />, onClick: () => { setSelectedKb(kb.id); setTimeout(() => fileInputRef.current?.click(), 100) } },
                { label: "Add FAQ", icon: <ChatDots size={14} />, onClick: () => { setSelectedKb(kb.id); setTimeout(() => setFaqOpen(true), 100) } },
                { label: "Delete", icon: <Trash size={14} />, onClick: () => handleDeleteKb(kb.id), destructive: true, divider: true },
              ] as FolderAction[]}
            />
          ))}
        </div>
      )}
    </div>
  )
}
