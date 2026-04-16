'use client'

import { useState, useEffect, useRef, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { avatarColor } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Panel } from '@/components/ui/panel'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  MagnifyingGlass,
  PaperPlaneTilt,
  Star,
  DotsThreeVertical,
  GearSix,
  UserCircle,
  Plus,
  CaretDown,
  CaretUp,
  Lightning,
  Paperclip,
  Smiley,
  At,
  WhatsappLogo,
  MessengerLogo,
  Globe,
  Phone as PhoneIcon,
  Check,
} from '@phosphor-icons/react'
import type {
  ConversationStatus,
  ChannelType,
  MessageRole,
  Contact,
  Message,
} from '@/types/database'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConversationItem {
  id: string
  org_id: string
  agent_id: string | null
  contact_id: string | null
  channel: ChannelType
  status: ConversationStatus
  assigned_to: string | null
  started_at: string
  resolved_at: string | null
  created_at: string
  updated_at: string
  contact: Pick<Contact, 'id' | 'name' | 'email' | 'phone' | 'channel' | 'language' | 'metadata' | 'tags'> | null
  agent: { id: string; name: string; avatar_url: string | null } | null
  last_message: { content: string; role: MessageRole; created_at: string } | null
  message_count: number
}

interface ConversationDetail extends ConversationItem {
  messages: Message[]
  conversation_count: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = Math.max(0, now - then)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(dateStr).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
}

function formatTimestamp(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getInitials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function channelIcon(channel: ChannelType, size = 14) {
  switch (channel) {
    case 'whatsapp':
      return <WhatsappLogo size={size} weight="fill" className="text-[#25D366]" />
    case 'facebook':
      return <MessengerLogo size={size} weight="fill" className="text-[#0084FF]" />
    case 'phone':
      return <PhoneIcon size={size} weight="fill" className="text-[#a855f7]" />
    case 'website':
    default:
      return <Globe size={size} weight="fill" className="text-[#f59e0b]" />
  }
}

function channelLabel(channel: ChannelType): string {
  switch (channel) {
    case 'whatsapp':
      return 'WhatsApp'
    case 'facebook':
      return 'Messenger'
    case 'phone':
      return 'Phone'
    case 'website':
    default:
      return 'Website'
  }
}

function channelBg(channel: ChannelType): string {
  switch (channel) {
    case 'whatsapp':
      return 'bg-[#e7f8f0] text-[#25D366]'
    case 'facebook':
      return 'bg-[#e5f1ff] text-[#0084FF]'
    case 'phone':
      return 'bg-[#f3e8ff] text-[#a855f7]'
    case 'website':
    default:
      return 'bg-[#fef3c7] text-[#f59e0b]'
  }
}

function truncate(str: string | undefined | null, len: number): string {
  if (!str) return ''
  return str.length > len ? str.slice(0, len) + '...' : str
}

// ---------------------------------------------------------------------------
// Collapsible section for right panel
// ---------------------------------------------------------------------------

function DetailSection({ title, children, defaultOpen = true, action }: { title: string; children: React.ReactNode; defaultOpen?: boolean; action?: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-2.5 hover:bg-[#fafafa] transition-colors"
      >
        <span className="text-[13px] font-medium text-[#2e2e2e]">{title}</span>
        <div className="flex items-center gap-1">
          {action}
          {open ? <CaretUp size={14} className="text-[#a3a3a3]" /> : <CaretDown size={14} className="text-[#a3a3a3]" />}
        </div>
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  )
}


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function InboxPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading...</div>}>
      <InboxInner />
    </Suspense>
  )
}

function InboxInner() {
  const supabase = createClient()
  const searchParams = useSearchParams()
  const agentFilter = searchParams.get('agentId')

  // State
  const [orgId, setOrgId] = useState<string | null>(null)
  const [filteredAgent, setFilteredAgent] = useState<{ id: string; name: string; avatar_url: string | null } | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [userName, setUserName] = useState<string>('')
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [tab, setTab] = useState<'all' | 'active' | 'escalated'>('all')
  const [search, setSearch] = useState('')
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [aiAutoReply, setAiAutoReply] = useState(true)
  const [contactNotes, setContactNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [rightTab, setRightTab] = useState<'details' | 'copilot'>('details')
  const [starred, setStarred] = useState<Set<string>>(new Set())

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Init
  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUserId(user.id)
      setUserName(user.user_metadata?.full_name || user.email?.split('@')[0] || 'User')
      const { data: membership } = await supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', user.id)
        .single()
      if (membership) setOrgId(membership.org_id)
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load filtered agent details for header
  useEffect(() => {
    if (!agentFilter) { setFilteredAgent(null); return }
    fetch(`/api/agents/${agentFilter}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.id) setFilteredAgent({ id: data.id, name: data.name, avatar_url: data.avatar_url }) })
      .catch(() => {})
  }, [agentFilter])

  const fetchConversations = useCallback(async () => {
    if (!orgId) return
    const params = new URLSearchParams()
    if (tab !== 'all') params.set('status', tab)
    if (search) params.set('search', search)
    if (agentFilter) params.set('agentId', agentFilter)
    const res = await fetch(`/api/inbox?${params.toString()}`)
    if (res.ok) {
      const data: ConversationItem[] = await res.json()
      setConversations(data)
    }
    setLoading(false)
  }, [orgId, tab, search, agentFilter])

  useEffect(() => {
    setLoading(true)
    fetchConversations()
  }, [fetchConversations])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    async function load() {
      setDetailLoading(true)
      const res = await fetch(`/api/inbox/${selectedId}`)
      if (res.ok) {
        const data: ConversationDetail = await res.json()
        setDetail(data)
        setAiAutoReply(!data.assigned_to)
        setContactNotes((data.contact?.metadata as Record<string, unknown>)?.notes as string || '')
      }
      setDetailLoading(false)
    }
    load()
  }, [selectedId])

  useEffect(() => {
    if (detail?.messages) setTimeout(scrollToBottom, 100)
  }, [detail?.messages, scrollToBottom])

  // Realtime
  useEffect(() => {
    if (!orgId) return
    const channel = supabase
      .channel('inbox-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `org_id=eq.${orgId}` }, (payload) => {
        const newMsg = payload.new as Message
        setDetail((prev) => {
          if (!prev || prev.id !== newMsg.conversation_id) return prev
          if (prev.messages.some((m) => m.id === newMsg.id)) return prev
          return { ...prev, messages: [...prev.messages, newMsg] }
        })
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === newMsg.conversation_id)
          if (idx === -1) { fetchConversations(); return prev }
          const updated = [...prev]
          const conv = { ...updated[idx], last_message: { content: newMsg.content, role: newMsg.role, created_at: newMsg.created_at }, message_count: (updated[idx].message_count || 0) + 1 }
          updated.splice(idx, 1)
          return [conv, ...updated]
        })
        setTimeout(scrollToBottom, 100)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [orgId, fetchConversations, scrollToBottom]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSendReply() {
    if (!replyText.trim() || !selectedId || sending) return
    setSending(true)
    try {
      const res = await fetch(`/api/inbox/${selectedId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: replyText.trim() }),
      })
      if (res.ok) {
        setReplyText('')
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
      }
    } finally {
      setSending(false)
    }
  }

  async function handleStatusChange(newStatus: ConversationStatus) {
    if (!selectedId) return
    const res = await fetch(`/api/inbox/${selectedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    if (res.ok) {
      setDetail((prev) => (prev ? { ...prev, status: newStatus } : prev))
      setConversations((prev) => prev.map((c) => (c.id === selectedId ? { ...c, status: newStatus } : c)))
    }
  }

  async function handleTakeOver() {
    if (!selectedId || !userId) return
    const res = await fetch(`/api/inbox/${selectedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_to: userId }),
    })
    if (res.ok) {
      setAiAutoReply(false)
      setDetail((prev) => (prev ? { ...prev, assigned_to: userId } : prev))
    }
  }

  async function handleSaveNotes() {
    if (!detail?.contact) return
    setSavingNotes(true)
    try {
      const currentMetadata = (detail.contact.metadata || {}) as Record<string, unknown>
      await supabase
        .from('contacts')
        .update({ metadata: { ...currentMetadata, notes: contactNotes } })
        .eq('id', detail.contact.id)
    } finally {
      setSavingNotes(false)
    }
  }

  function toggleStar(id: string) {
    setStarred(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setReplyText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendReply()
    }
  }


  return (
    <div className="flex h-full bg-[#f5f5f5] overflow-hidden gap-3 p-3 pt-3">
      {/* ============================================================= */}
      {/* LEFT: Conversation List */}
      {/* ============================================================= */}
      <Panel className="bg-[#fafafa]" resizable defaultWidth={320} minWidth={260} maxWidth={480} storageKey="inbox:list">
        {/* Header */}
        <div className="flex h-12 items-center gap-2.5 px-4 border-b border-black/[0.06] flex-shrink-0">
          {filteredAgent ? (
            <>
              {filteredAgent.avatar_url ? (
                <img src={filteredAgent.avatar_url} alt={filteredAgent.name} className="h-7 w-7 rounded-full object-cover" />
              ) : (() => { const c = avatarColor(filteredAgent.id); return (
                <div className={`h-7 w-7 rounded-full text-xs font-semibold flex items-center justify-center ${c.bg} ${c.text}`}>
                  {filteredAgent.name[0]?.toUpperCase() || 'A'}
                </div>
              ) })()}
              <span className="text-base font-semibold text-[#2e2e2e] truncate flex-1">{filteredAgent.name}</span>
              <Link href={`/agents/${filteredAgent.id}`} className="rounded-md p-1 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#2e2e2e]" title="Agent settings">
                <GearSix size={16} />
              </Link>
            </>
          ) : (
            <span className="text-base font-semibold text-[#2e2e2e]">All conversations</span>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 px-3 py-2.5 border-b border-black/[0.06]">
          {(['all', 'active', 'escalated'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                tab === t ? 'bg-[#ebebeb] text-[#2e2e2e]' : 'text-[#737373] hover:bg-[#f5f5f5]'
              }`}
            >
              {t === 'all' ? 'All' : t === 'active' ? 'Active' : 'Escalated'}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-black/[0.06]">
          <div className="relative">
            <MagnifyingGlass size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#a3a3a3]" />
            <Input
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-[13px] border-black/[0.04] bg-white focus-visible:ring-1"
            />
          </div>
        </div>

        {/* List */}
        <ScrollArea className="flex-1">
          {loading ? (
            <div className="px-2 py-1 space-y-0.5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 px-3 py-2.5">
                  <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-2.5 w-8" />
                    </div>
                    <Skeleton className="h-2.5 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6">
              <div className="h-12 w-12 rounded-full bg-[#f5f5f5] flex items-center justify-center mb-3">
                <MagnifyingGlass size={20} className="text-[#a3a3a3]" />
              </div>
              <div className="text-sm font-medium text-[#2e2e2e]">No conversations</div>
              <div className="mt-1 text-xs text-[#a3a3a3] text-center">
                {tab === 'all' ? 'Messages will appear here when customers reach out' : `No ${tab} conversations`}
              </div>
            </div>
          ) : (
            <div className="px-2 py-1 space-y-0.5">
              {conversations.map((conv) => {
                const isSelected = conv.id === selectedId
                const contactName = conv.contact?.name || conv.contact?.phone || conv.contact?.email || 'Unknown'
                return (
                  <button
                    key={conv.id}
                    onClick={() => setSelectedId(conv.id)}
                    className={`flex w-full items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                      isSelected
                        ? 'bg-white shadow-[0_2px_4px_-1px_rgba(0,0,0,0.08),0_1px_2px_-1px_rgba(0,0,0,0.04)]'
                        : 'hover:bg-white/70'
                    }`}
                  >
                    {/* Channel icon avatar */}
                    <div className={`flex-shrink-0 flex items-center justify-center h-9 w-9 rounded-full ${channelBg(conv.channel)}`}>
                      {channelIcon(conv.channel, 18)}
                    </div>
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-[#2e2e2e]">{contactName}</span>
                        <span className="flex-shrink-0 text-xs text-[#a3a3a3]">
                          {conv.last_message ? timeAgo(conv.last_message.created_at) : timeAgo(conv.updated_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="truncate text-[13px] text-[#737373]">
                          {conv.last_message ? truncate(conv.last_message.content, 45) : 'No messages yet'}
                        </span>
                        {conv.status === 'escalated' && (
                          <Badge className="h-4 flex-shrink-0 px-1 text-[9px] bg-red-50 text-red-600 hover:bg-red-50">Escalated</Badge>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </ScrollArea>

      </Panel>

      {/* ============================================================= */}
      {/* CENTER: Conversation */}
      {/* ============================================================= */}
      <Panel className="flex-1 min-w-0">
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="h-14 w-14 rounded-full bg-[#f5f5f5] flex items-center justify-center mx-auto mb-3">
                <PaperPlaneTilt size={22} className="text-[#a3a3a3]" />
              </div>
              <div className="text-sm font-medium text-[#2e2e2e]">Select a conversation</div>
              <div className="mt-1 text-[13px] text-[#a3a3a3]">Choose one from the left to view messages</div>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex flex-1 flex-col">
            <div className="flex h-12 items-center justify-between border-b border-black/[0.04] px-5 flex-shrink-0">
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-4 w-32" />
              </div>
            </div>
            <div className="flex-1 px-5 py-4 space-y-3">
              {[60, 80, 50, 90].map((w, i) => (
                <div key={i} className={i % 2 === 0 ? 'flex' : 'flex justify-end'}>
                  <Skeleton className="h-12 rounded-2xl" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
          </div>
        ) : detail ? (
          <>
            {/* Header */}
            <div className="flex h-12 items-center justify-between border-b border-black/[0.04] px-5 flex-shrink-0">
              <div className="flex items-center gap-3">
                {(() => {
                  const seed = detail.contact?.id || detail.contact?.name || ''
                  const c = avatarColor(seed)
                  return (
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className={`text-[11px] font-semibold ${c.bg} ${c.text}`}>{getInitials(detail.contact?.name)}</AvatarFallback>
                    </Avatar>
                  )
                })()}
                <span className="text-[15px] font-semibold text-[#2e2e2e]">{detail.contact?.name || detail.contact?.phone || detail.contact?.email || 'Unknown'}</span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => toggleStar(detail.id)} className="p-1.5 rounded hover:bg-[#f5f5f5]">
                  <Star size={16} weight={starred.has(detail.id) ? 'fill' : 'bold'} className={starred.has(detail.id) ? 'text-yellow-500' : 'text-[#737373]'} />
                </button>
                <Select value={detail.status} onValueChange={(v) => v && handleStatusChange(v as ConversationStatus)}>
                  <SelectTrigger className="h-8 w-[110px] text-[13px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active" className="text-[13px]">Active</SelectItem>
                    <SelectItem value="waiting" className="text-[13px]">Waiting</SelectItem>
                    <SelectItem value="resolved" className="text-[13px]">Resolved</SelectItem>
                    <SelectItem value="escalated" className="text-[13px]">Escalated</SelectItem>
                  </SelectContent>
                </Select>
                <button className="p-1.5 rounded hover:bg-[#f5f5f5]">
                  <DotsThreeVertical size={16} className="text-[#737373]" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <ScrollArea
              className="flex-1 min-h-0 px-5 bg-white"
              style={{
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)',
                maskImage: 'linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)',
              }}
            >
              <div className="mx-auto max-w-2xl space-y-3">
                {detail.messages.length === 0 ? (
                  <div className="flex items-center justify-center py-16">
                    <div className="text-[13px] text-[#a3a3a3]">No messages yet</div>
                  </div>
                ) : (
                  detail.messages.map((msg, idx) => {
                    if (msg.role === 'system') {
                      return (
                        <div key={msg.id} className="flex justify-center">
                          <span className="rounded-full bg-[#f0f0f0] px-3 py-1 text-xs text-[#737373]">{msg.content}</span>
                        </div>
                      )
                    }
                    const isUser = msg.role === 'user'
                    const isAI = msg.role === 'assistant'
                    const isHumanAgent = msg.role === 'human_agent'
                    const isOutgoing = isAI || isHumanAgent
                    const prevMsg = idx > 0 ? detail.messages[idx - 1] : null
                    const showAvatar = !prevMsg || prevMsg.role !== msg.role

                    return (
                      <div key={msg.id} className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                        {!isOutgoing && (() => {
                          const c = avatarColor(detail.contact?.id || detail.contact?.name || '')
                          return (
                            <Avatar className={`h-6 w-6 flex-shrink-0 ${showAvatar ? '' : 'invisible'}`}>
                              <AvatarFallback className={`text-[8px] font-semibold ${c.bg} ${c.text}`}>
                                {getInitials(detail.contact?.name)}
                              </AvatarFallback>
                            </Avatar>
                          )
                        })()}
                        <div className={`max-w-[75%] flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                          <div
                            className={`rounded-3xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                              isOutgoing
                                ? 'bg-[#f3f3f3] text-[#2e2e2e]'
                                : 'bg-white text-[#2e2e2e] ring-1 ring-black/[0.04]'
                            }`}
                          >
                            {msg.content}
                          </div>
                          <div className="mt-1 px-2 flex items-center gap-1 text-[10px] text-[#a3a3a3] leading-none select-none">
                            <span>{formatTimestamp(msg.created_at)}</span>
                            {isOutgoing && <Check size={10} weight="bold" className="text-[#3b82f6]" />}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            {/* Input — single bordered box with no top divider */}
            <div className="bg-white px-4 pb-4 pt-2 flex-shrink-0">
              <div className="rounded-xl border border-black/[0.04] bg-white overflow-hidden focus-within:ring-1 focus-within:ring-[#2e2e2e]/10">
                {/* Channel selector */}
                <div className="flex items-center gap-2 px-3 pt-2">
                  <button className="flex items-center gap-1.5 px-1.5 py-1 rounded-md hover:bg-[#f5f5f5] text-sm text-[#2e2e2e]">
                    {channelIcon(detail.channel, 14)}
                    <span className="font-semibold">{channelLabel(detail.channel)}</span>
                    <CaretDown size={10} />
                  </button>
                </div>
                {/* Textarea */}
                <Textarea
                  ref={textareaRef}
                  placeholder="Use ⌘K for shortcuts"
                  value={replyText}
                  onChange={handleTextareaInput}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  className="min-h-[52px] max-h-[160px] resize-none text-sm border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 px-4 py-2"
                />
                {/* Bottom toolbar */}
                <div className="flex items-center justify-between px-3 pb-2">
                  <div className="flex items-center gap-0.5">
                    <button className="p-1.5 rounded hover:bg-[#f5f5f5] text-[#2e2e2e]" title="Shortcuts"><Lightning size={16} weight="fill" /></button>
                    <button className="p-1.5 rounded hover:bg-[#f5f5f5] text-[#737373]" title="Attach"><Paperclip size={15} /></button>
                    <button className="p-1.5 rounded hover:bg-[#f5f5f5] text-[#737373]" title="Emoji"><Smiley size={15} /></button>
                    <button className="p-1.5 rounded hover:bg-[#f5f5f5] text-[#737373]" title="Mention"><At size={15} /></button>
                    <div className="h-4 w-px bg-[#ebebeb] mx-1" />
                    <div className="flex items-center gap-1.5 ml-1">
                      <Switch checked={aiAutoReply} onCheckedChange={(v) => { setAiAutoReply(v); if (!v) handleTakeOver() }} />
                      <span className="text-xs text-[#737373]">AI {aiAutoReply ? 'on' : 'off'}</span>
                    </div>
                  </div>
                  <button
                    onClick={handleSendReply}
                    disabled={!replyText.trim() || sending}
                    className="flex items-center gap-1 text-[13px] text-[#737373] hover:text-[#2e2e2e] disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1"
                  >
                    {sending ? 'Sending...' : 'Send'}
                    <CaretDown size={10} />
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </Panel>

      {/* ============================================================= */}
      {/* RIGHT: Details */}
      {/* ============================================================= */}
      {detail?.contact && (
        <Panel resizable defaultWidth={320} minWidth={260} maxWidth={480} storageKey="inbox:details">
          {/* Tabs */}
          <div className="flex h-12 bg-white border-b border-black/[0.04] flex-shrink-0">
            {(['details', 'copilot'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setRightTab(t)}
                className={`flex-1 px-4 text-[13px] font-medium transition-colors border-b-2 ${
                  rightTab === t ? 'border-[#F4511E] text-[#2e2e2e]' : 'border-transparent text-[#737373] hover:text-[#2e2e2e]'
                }`}
              >
                {t === 'details' ? 'Details' : 'Copilot'}
              </button>
            ))}
          </div>

          {rightTab === 'details' ? (
            <ScrollArea className="flex-1">
              <div className="divide-y divide-[#f0f0f0]">
                  <DetailSection title="Assignee">
                    <div className="flex items-center gap-2 py-1">
                      {(() => { const c = avatarColor(userName); return (
                      <Avatar className="h-6 w-6"><AvatarFallback className={`text-[9px] font-semibold ${c.bg} ${c.text}`}>{getInitials(userName)}</AvatarFallback></Avatar>
                      ) })()}
                      <span className="text-[13px] text-[#2e2e2e]">{userName}</span>
                    </div>
                    <button className="flex items-center gap-2 mt-2 text-xs text-[#737373] hover:text-[#2e2e2e]">
                      <UserCircle size={14} />
                      <span>Team Inbox</span>
                    </button>
                  </DetailSection>
                  <DetailSection title="Conversation">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#a3a3a3]">ID</span>
                        <span className="text-xs text-[#2e2e2e] font-mono">{detail.id.slice(0, 8)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#a3a3a3]">Channel</span>
                        <div className="flex items-center gap-1">
                          {channelIcon(detail.channel, 12)}
                          <span className="text-xs text-[#2e2e2e]">{channelLabel(detail.channel)}</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#a3a3a3]">Status</span>
                        <span className="text-xs text-[#2e2e2e] capitalize">{detail.status}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[#a3a3a3]">Started</span>
                        <span className="text-xs text-[#2e2e2e]">{timeAgo(detail.started_at)} ago</span>
                      </div>
                    </div>
                  </DetailSection>
                  <DetailSection title="Contact" action={<Plus size={12} className="text-[#a3a3a3]" />}>
                    <div className="space-y-2">
                      {detail.contact.email && (
                        <div>
                          <div className="text-[11px] text-[#a3a3a3] font-medium mb-0.5">Email</div>
                          <div className="text-[13px] text-[#2e2e2e] break-all">{detail.contact.email}</div>
                        </div>
                      )}
                      {detail.contact.phone && (
                        <div>
                          <div className="text-[11px] text-[#a3a3a3] font-medium mb-0.5">Phone</div>
                          <div className="text-[13px] text-[#2e2e2e]">{detail.contact.phone}</div>
                        </div>
                      )}
                      {detail.contact.language && (
                        <div>
                          <div className="text-[11px] text-[#a3a3a3] font-medium mb-0.5">Language</div>
                          <div className="text-[13px] text-[#2e2e2e] uppercase">{detail.contact.language}</div>
                        </div>
                      )}
                      {!detail.contact.email && !detail.contact.phone && !detail.contact.language && (
                        <span className="text-xs text-[#a3a3a3]">No contact info</span>
                      )}
                    </div>
                  </DetailSection>
                  <DetailSection title="Tags" action={<Plus size={12} className="text-[#a3a3a3]" />}>
                    {detail.contact.tags && detail.contact.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {detail.contact.tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-[11px]">{tag}</Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-[#a3a3a3]">No tags</span>
                    )}
                  </DetailSection>
                  <DetailSection title="Recent conversations" defaultOpen={false}>
                    <div className="text-xs text-[#737373]">{detail.conversation_count} total with this contact</div>
                  </DetailSection>
                  <DetailSection title="Notes">
                    <Textarea
                      placeholder="Add notes about this contact..."
                      value={contactNotes}
                      onChange={(e) => setContactNotes(e.target.value)}
                      rows={3}
                      className="text-[13px] resize-none border-black/[0.04]"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-2 h-7 w-full text-xs"
                      onClick={handleSaveNotes}
                      disabled={savingNotes}
                    >
                      {savingNotes ? 'Saving...' : 'Save notes'}
                    </Button>
                  </DetailSection>
              </div>
            </ScrollArea>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6 text-center">
              <div>
                <div className="text-sm font-medium text-[#2e2e2e] mb-1">AI Copilot</div>
                <div className="text-xs text-[#a3a3a3]">Coming soon — AI suggestions, summaries, and actions</div>
              </div>
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}
