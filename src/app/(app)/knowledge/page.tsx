'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
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
import { Plus, Trash, Upload, ChatDots, CaretDown, CaretRight, Database } from '@phosphor-icons/react'

// ---- Types ----

interface KnowledgeBaseWithDocs extends KnowledgeBase {
  kb_documents: KbDocument[]
}

const statusStyles: Record<string, string> = {
  ready: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  processing: 'bg-blue-50 text-blue-700 border-blue-200',
  pending: 'bg-neutral-50 text-neutral-500 border-neutral-200',
  error: 'bg-red-50 text-red-700 border-red-200',
}

// ---- Page ----

export default function KnowledgePage() {
  const [kbs, setKbs] = useState<KnowledgeBaseWithDocs[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Create KB dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createAgent, setCreateAgent] = useState<string>('')
  const [creating, setCreating] = useState(false)

  // FAQ dialog
  const [faqOpen, setFaqOpen] = useState(false)
  const [faqKbId, setFaqKbId] = useState<string | null>(null)
  const [faqQuestion, setFaqQuestion] = useState('')
  const [faqAnswer, setFaqAnswer] = useState('')
  const [addingFaq, setAddingFaq] = useState(false)

  // Upload
  const [uploading, setUploading] = useState<Record<string, boolean>>({})
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const fetchKbs = useCallback(async () => {
    try {
      const res = await fetch('/api/knowledge-base')
      if (!res.ok) throw new Error('Failed to load knowledge bases')
      const data = await res.json()
      setKbs(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents')
      if (!res.ok) return
      const data = await res.json()
      setAgents(data)
    } catch {
      // non-critical
    }
  }, [])

  useEffect(() => {
    fetchKbs()
    fetchAgents()
  }, [fetchKbs, fetchAgents])

  // ---- Handlers ----

  async function handleCreateKb() {
    if (!createName.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/knowledge-base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createName,
          description: createDesc || null,
          agent_id: createAgent || null,
        }),
      })
      if (!res.ok) throw new Error('Failed to create knowledge base')
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
    try {
      const res = await fetch(`/api/knowledge-base/${kbId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      await fetchKbs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  async function handleUpload(kbId: string, file: File) {
    setUploading((prev) => ({ ...prev, [kbId]: true }))
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`/api/knowledge-base/${kbId}/upload`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) throw new Error('Upload failed')
      await fetchKbs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading((prev) => ({ ...prev, [kbId]: false }))
    }
  }

  async function handleAddFaq() {
    if (!faqKbId || !faqQuestion.trim() || !faqAnswer.trim()) return
    setAddingFaq(true)
    try {
      const res = await fetch(`/api/knowledge-base/${faqKbId}/faq`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: faqQuestion, answer: faqAnswer }),
      })
      if (!res.ok) throw new Error('Failed to add FAQ')
      setFaqOpen(false)
      setFaqQuestion('')
      setFaqAnswer('')
      setFaqKbId(null)
      await fetchKbs()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add FAQ')
    } finally {
      setAddingFaq(false)
    }
  }

  function toggleExpand(kbId: string) {
    setExpanded((prev) => ({ ...prev, [kbId]: !prev[kbId] }))
  }

  // ---- Render ----

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-[15px] font-semibold text-[#0a0a0a]">Knowledge Base</h1>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={
            <Button size="sm" className="h-8 gap-1.5 text-[13px]">
              <Plus size={14} weight="bold" />
              Create Knowledge Base
            </Button>
          } />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Knowledge Base</DialogTitle>
              <DialogDescription>
                Add a knowledge base to train your agent with custom content.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="kb-name" className="text-[13px]">Name</Label>
                <Input
                  id="kb-name"
                  placeholder="e.g. Product Documentation"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="kb-desc" className="text-[13px]">Description</Label>
                <Textarea
                  id="kb-desc"
                  placeholder="What kind of knowledge will this contain?"
                  value={createDesc}
                  onChange={(e) => setCreateDesc(e.target.value)}
                  rows={2}
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-[13px]">Assign to Agent</Label>
                <Select value={createAgent} onValueChange={(v) => v && setCreateAgent(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an agent (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                size="sm"
                onClick={handleCreateKb}
                disabled={creating || !createName.trim()}
                className="text-[13px]"
              >
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700 mb-4">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {loading && (
        <div className="grid gap-4">
          {[1, 2].map((i) => (
            <Card key={i} className="border-[#e5e5e5]">
              <CardContent className="p-5">
                <Skeleton className="h-5 w-48 mb-3" />
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!loading && !error && kbs.length === 0 && (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-[#d4d4d4] bg-[#fafafa] py-24">
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#f0f0f0]">
              <Database size={20} weight="duotone" className="text-[#737373]" />
            </div>
            <div className="text-[13px] font-medium text-[#525252]">No knowledge bases yet</div>
            <div className="text-[12px] text-[#a3a3a3] mt-1 mb-4">
              Create a knowledge base and upload documents to train your agents
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)} className="h-8 gap-1.5 text-[13px]">
              <Plus size={14} weight="bold" />
              Create Knowledge Base
            </Button>
          </div>
        </div>
      )}

      {!loading && kbs.length > 0 && (
        <div className="grid gap-4">
          {kbs.map((kb) => {
            const docs = kb.kb_documents || []
            const isExpanded = expanded[kb.id] ?? false
            const readyCount = docs.filter((d) => d.status === 'ready').length
            const agentName = agents.find((a) => a.id === kb.agent_id)?.name

            return (
              <Card key={kb.id} className="border-[#e5e5e5]">
                <CardContent className="p-5">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-1">
                    <button
                      onClick={() => toggleExpand(kb.id)}
                      className="flex items-center gap-2 text-left"
                    >
                      {isExpanded
                        ? <CaretDown size={14} weight="bold" className="text-[#737373] mt-0.5" />
                        : <CaretRight size={14} weight="bold" className="text-[#737373] mt-0.5" />
                      }
                      <div>
                        <h3 className="text-[14px] font-semibold text-[#0a0a0a]">{kb.name}</h3>
                        {kb.description && (
                          <p className="text-[12px] text-[#737373] mt-0.5">{kb.description}</p>
                        )}
                      </div>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      {agentName && (
                        <Badge variant="secondary" className="text-[11px] font-normal">
                          {agentName}
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[11px]">
                        {readyCount}/{docs.length} docs
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-[#a3a3a3] hover:text-red-600"
                        onClick={() => handleDeleteKb(kb.id)}
                      >
                        <Trash size={14} />
                      </Button>
                    </div>
                  </div>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="mt-4 ml-6">
                      {/* Actions */}
                      <div className="flex gap-2 mb-4">
                        <input
                          ref={(el) => { fileInputRefs.current[kb.id] = el }}
                          type="file"
                          accept=".txt,.csv,.pdf,.docx"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0]
                            if (file) handleUpload(kb.id, file)
                            e.target.value = ''
                          }}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5 text-[12px]"
                          disabled={uploading[kb.id]}
                          onClick={() => fileInputRefs.current[kb.id]?.click()}
                        >
                          <Upload size={12} />
                          {uploading[kb.id] ? 'Uploading...' : 'Upload File'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5 text-[12px]"
                          onClick={() => {
                            setFaqKbId(kb.id)
                            setFaqOpen(true)
                          }}
                        >
                          <ChatDots size={12} />
                          Add FAQ
                        </Button>
                      </div>

                      {/* Document list */}
                      {docs.length === 0 ? (
                        <div className="text-[12px] text-[#a3a3a3] py-4 text-center border border-dashed border-[#e5e5e5] rounded-lg">
                          No documents yet. Upload a file or add an FAQ.
                        </div>
                      ) : (
                        <div className="border border-[#e5e5e5] rounded-lg overflow-hidden">
                          <table className="w-full text-[12px]">
                            <thead>
                              <tr className="border-b border-[#e5e5e5] bg-[#fafafa]">
                                <th className="text-left px-3 py-2 font-medium text-[#525252]">Name</th>
                                <th className="text-left px-3 py-2 font-medium text-[#525252]">Type</th>
                                <th className="text-left px-3 py-2 font-medium text-[#525252]">Size</th>
                                <th className="text-left px-3 py-2 font-medium text-[#525252]">Status</th>
                                <th className="px-3 py-2 w-8"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {docs.map((doc) => (
                                <tr key={doc.id} className="border-b border-[#f0f0f0] last:border-0">
                                  <td className="px-3 py-2 text-[#0a0a0a] max-w-[200px] truncate">
                                    {doc.name}
                                  </td>
                                  <td className="px-3 py-2 text-[#737373]">
                                    {doc.file_type === 'faq' ? 'FAQ' : (doc.file_type?.split('/').pop() || 'file')}
                                  </td>
                                  <td className="px-3 py-2 text-[#737373]">
                                    {doc.char_count ? `${(doc.char_count / 1000).toFixed(1)}k chars` : '-'}
                                  </td>
                                  <td className="px-3 py-2">
                                    <Badge
                                      variant="outline"
                                      className={`text-[10px] ${statusStyles[doc.status] || ''}`}
                                    >
                                      {doc.status}
                                    </Badge>
                                  </td>
                                  <td className="px-3 py-2">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 w-6 p-0 text-[#c4c4c4] hover:text-red-600"
                                      onClick={async () => {
                                        if (!confirm('Delete this document?')) return
                                        try {
                                          const res = await fetch(
                                            `/api/knowledge-base/${kb.id}/documents/${doc.id}`,
                                            { method: 'DELETE' }
                                          )
                                          if (!res.ok) throw new Error('Failed to delete document')
                                          await fetchKbs()
                                        } catch (err) {
                                          setError(err instanceof Error ? err.message : 'Delete failed')
                                        }
                                      }}
                                    >
                                      <Trash size={12} />
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* FAQ Dialog */}
      <Dialog open={faqOpen} onOpenChange={setFaqOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add FAQ</DialogTitle>
            <DialogDescription>
              Add a question and answer pair to the knowledge base.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="faq-q" className="text-[13px]">Question</Label>
              <Input
                id="faq-q"
                placeholder="e.g. What are your business hours?"
                value={faqQuestion}
                onChange={(e) => setFaqQuestion(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="faq-a" className="text-[13px]">Answer</Label>
              <Textarea
                id="faq-a"
                placeholder="e.g. We are open Monday to Friday, 9 AM to 6 PM IST."
                value={faqAnswer}
                onChange={(e) => setFaqAnswer(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              size="sm"
              onClick={handleAddFaq}
              disabled={addingFaq || !faqQuestion.trim() || !faqAnswer.trim()}
              className="text-[13px]"
            >
              {addingFaq ? 'Adding...' : 'Add FAQ'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
