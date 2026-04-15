'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MagnifyingGlass, PaperPlaneTilt, UserCirclePlus } from '@phosphor-icons/react'
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
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
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

function channelDotColor(channel: ChannelType): string {
  switch (channel) {
    case 'whatsapp':
      return 'bg-green-500'
    case 'facebook':
      return 'bg-blue-500'
    case 'phone':
      return 'bg-black'
    case 'website':
    default:
      return 'bg-gray-400'
  }
}

function channelLabel(channel: ChannelType): string {
  switch (channel) {
    case 'whatsapp':
      return 'WhatsApp'
    case 'facebook':
      return 'Facebook'
    case 'phone':
      return 'Phone'
    case 'website':
    default:
      return 'Website'
  }
}

function truncate(str: string | undefined | null, len: number): string {
  if (!str) return ''
  return str.length > len ? str.slice(0, len) + '...' : str
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const supabase = createClient()

  // State
  const [orgId, setOrgId] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
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

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Scroll to bottom on new messages
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // -------------------------------------------------------------------------
  // Init: load user + org
  // -------------------------------------------------------------------------
  useEffect(() => {
    async function init() {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return

      setUserId(user.id)

      const { data: membership } = await supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', user.id)
        .single()

      if (membership) {
        setOrgId(membership.org_id)
      }
    }
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Fetch conversations
  // -------------------------------------------------------------------------
  const fetchConversations = useCallback(async () => {
    if (!orgId) return
    const params = new URLSearchParams()
    if (tab !== 'all') params.set('status', tab)
    if (search) params.set('search', search)

    const res = await fetch(`/api/inbox?${params.toString()}`)
    if (res.ok) {
      const data: ConversationItem[] = await res.json()
      setConversations(data)
    }
    setLoading(false)
  }, [orgId, tab, search])

  useEffect(() => {
    setLoading(true)
    fetchConversations()
  }, [fetchConversations])

  // -------------------------------------------------------------------------
  // Fetch conversation detail
  // -------------------------------------------------------------------------
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
        setContactNotes(
          (data.contact?.metadata as Record<string, unknown>)?.notes as string || ''
        )
      }
      setDetailLoading(false)
    }
    load()
  }, [selectedId])

  // Scroll to bottom when detail loads or messages change
  useEffect(() => {
    if (detail?.messages) {
      setTimeout(scrollToBottom, 100)
    }
  }, [detail?.messages, scrollToBottom])

  // -------------------------------------------------------------------------
  // Supabase Realtime
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!orgId) return

    const channel = supabase
      .channel('inbox-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `org_id=eq.${orgId}`,
        },
        (payload) => {
          const newMsg = payload.new as Message

          // If this message is for the active conversation, append it
          setDetail((prev) => {
            if (!prev || prev.id !== newMsg.conversation_id) return prev
            // Avoid duplicates
            if (prev.messages.some((m) => m.id === newMsg.id)) return prev
            return { ...prev, messages: [...prev.messages, newMsg] }
          })

          // Update conversation list: move to top, update preview
          setConversations((prev) => {
            const idx = prev.findIndex((c) => c.id === newMsg.conversation_id)
            if (idx === -1) {
              // New conversation — refetch the list
              fetchConversations()
              return prev
            }
            const updated = [...prev]
            const conv = {
              ...updated[idx],
              last_message: {
                content: newMsg.content,
                role: newMsg.role,
                created_at: newMsg.created_at,
              },
              message_count: (updated[idx].message_count || 0) + 1,
            }
            updated.splice(idx, 1)
            return [conv, ...updated]
          })

          // Auto-scroll
          setTimeout(scrollToBottom, 100)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [orgId, fetchConversations, scrollToBottom]) // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

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
      setConversations((prev) =>
        prev.map((c) => (c.id === selectedId ? { ...c, status: newStatus } : c))
      )
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
        .update({
          metadata: { ...currentMetadata, notes: contactNotes },
        })
        .eq('id', detail.contact.id)
    } finally {
      setSavingNotes(false)
    }
  }

  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setReplyText(e.target.value)
    // Auto-grow
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

  // -------------------------------------------------------------------------
  // Filtered conversations
  // -------------------------------------------------------------------------
  const filteredConversations = conversations

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="flex h-full">
      {/* ================================================================= */}
      {/* LEFT PANEL: Conversation List */}
      {/* ================================================================= */}
      <div className="flex w-[280px] flex-shrink-0 flex-col border-r border-[#ebebeb]">
        {/* Search */}
        <div className="p-3">
          <div className="relative">
            <MagnifyingGlass
              size={15}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#a3a3a3]"
            />
            <Input
              placeholder="Search conversations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-[13px]"
            />
          </div>
        </div>

        {/* Filter tabs */}
        <div className="px-3 pb-2">
          <Tabs value={tab} onValueChange={(v) => v && setTab(v as typeof tab)}>
            <TabsList className="h-8 w-full">
              <TabsTrigger value="all" className="flex-1 text-[12px]">
                All
              </TabsTrigger>
              <TabsTrigger value="active" className="flex-1 text-[12px]">
                Active
              </TabsTrigger>
              <TabsTrigger value="escalated" className="flex-1 text-[12px]">
                Escalated
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <Separator />

        {/* Conversation list */}
        <ScrollArea className="flex-1">
          {loading ? (
            <div className="py-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 px-3 py-2.5">
                  <Skeleton className="h-8 w-8 flex-shrink-0 rounded-full" />
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
          ) : filteredConversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="text-[13px] font-medium text-[#a3a3a3]">No conversations</div>
              <div className="mt-1 text-[12px] text-[#c4c4c4]">
                {tab === 'all' ? 'Conversations will appear here' : `No ${tab} conversations`}
              </div>
            </div>
          ) : (
            <div className="py-1">
              {filteredConversations.map((conv) => {
                const isSelected = conv.id === selectedId
                const contactName = conv.contact?.name || 'Unknown'
                return (
                  <button
                    key={conv.id}
                    onClick={() => setSelectedId(conv.id)}
                    className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                      isSelected
                        ? 'bg-[#f0f0f0]'
                        : 'hover:bg-[#fafafa]'
                    }`}
                  >
                    {/* Avatar */}
                    <Avatar className="h-8 w-8 flex-shrink-0">
                      <AvatarFallback className="bg-[#0a0a0a] text-[10px] text-white">
                        {getInitials(contactName)}
                      </AvatarFallback>
                    </Avatar>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate text-[13px] font-medium text-[#0a0a0a]">
                            {contactName}
                          </span>
                          <span
                            className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${channelDotColor(conv.channel)}`}
                            title={channelLabel(conv.channel)}
                          />
                        </div>
                        <span className="flex-shrink-0 text-[11px] text-[#a3a3a3]">
                          {conv.last_message
                            ? timeAgo(conv.last_message.created_at)
                            : timeAgo(conv.updated_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="truncate text-[12px] text-[#737373]">
                          {conv.last_message
                            ? truncate(conv.last_message.content, 50)
                            : 'No messages yet'}
                        </span>
                        {conv.status === 'escalated' && (
                          <Badge
                            variant="destructive"
                            className="h-4 flex-shrink-0 px-1 text-[9px]"
                          >
                            Escalated
                          </Badge>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* ================================================================= */}
      {/* CENTER PANEL: Active Conversation */}
      {/* ================================================================= */}
      <div className="flex flex-1 flex-col">
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="text-[13px] font-medium text-[#a3a3a3]">
                Select a conversation
              </div>
              <div className="mt-1 text-[12px] text-[#c4c4c4]">
                Choose a conversation from the left to view messages
              </div>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-[#ebebeb] px-4 py-2.5">
              <div className="flex items-center gap-3">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
              </div>
            </div>
            <div className="flex-1 px-4 py-4">
              <div className="mx-auto max-w-2xl space-y-3">
                {[60, 80, 50, 90, 70].map((w, i) => (
                  <div key={i} className="flex justify-start">
                    <Skeleton className="h-14 rounded-lg" style={{ width: `${w}%` }} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : detail ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#ebebeb] px-4 py-2.5">
              <div className="flex items-center gap-3">
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="bg-[#0a0a0a] text-[9px] text-white">
                    {getInitials(detail.contact?.name)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-[#0a0a0a]">
                      {detail.contact?.name || 'Unknown'}
                    </span>
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${channelDotColor(detail.channel)}`}
                      title={channelLabel(detail.channel)}
                    />
                    <span className="text-[11px] text-[#a3a3a3]">
                      {channelLabel(detail.channel)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={detail.status}
                  onValueChange={(v) => v && handleStatusChange(v as ConversationStatus)}
                >
                  <SelectTrigger className="h-7 w-[130px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active" className="text-[12px]">Active</SelectItem>
                    <SelectItem value="waiting" className="text-[12px]">Waiting</SelectItem>
                    <SelectItem value="resolved" className="text-[12px]">Resolved</SelectItem>
                    <SelectItem value="escalated" className="text-[12px]">Escalated</SelectItem>
                  </SelectContent>
                </Select>
                {!detail.assigned_to && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-[12px]"
                    onClick={handleTakeOver}
                  >
                    <UserCirclePlus size={14} />
                    Take over
                  </Button>
                )}
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 px-4 py-4">
              <div className="mx-auto max-w-2xl space-y-3">
                {detail.messages.length === 0 ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="text-[12px] text-[#a3a3a3]">No messages yet</div>
                  </div>
                ) : (
                  detail.messages.map((msg) => {
                    if (msg.role === 'system') {
                      return (
                        <div key={msg.id} className="flex justify-center">
                          <span className="rounded-full bg-[#f5f5f5] px-3 py-1 text-[11px] text-[#a3a3a3]">
                            {msg.content}
                          </span>
                        </div>
                      )
                    }

                    const isUser = msg.role === 'user'
                    const isAI = msg.role === 'assistant'
                    const isHumanAgent = msg.role === 'human_agent'

                    return (
                      <div key={msg.id} className={`flex ${isUser ? 'justify-start' : 'justify-start'}`}>
                        <div
                          className={`max-w-[80%] rounded-lg px-3 py-2 ${
                            isUser
                              ? 'bg-[#f0f0f0] text-[#0a0a0a]'
                              : isAI
                              ? 'bg-[#f8f5ff] text-[#0a0a0a]'
                              : isHumanAgent
                              ? 'bg-[#eef6ff] text-[#0a0a0a]'
                              : 'bg-[#f5f5f5] text-[#0a0a0a]'
                          }`}
                        >
                          {/* Role badge */}
                          {(isAI || isHumanAgent) && (
                            <div className="mb-1">
                              <span
                                className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-medium ${
                                  isAI
                                    ? 'bg-[#ede5ff] text-[#7c3aed]'
                                    : 'bg-[#dbeafe] text-[#2563eb]'
                                }`}
                              >
                                {isAI ? 'AI' : 'You'}
                              </span>
                            </div>
                          )}
                          <div className="whitespace-pre-wrap text-[13px] leading-relaxed">
                            {msg.content}
                          </div>
                          <div className="mt-1 text-right text-[10px] text-[#a3a3a3]">
                            {formatTimestamp(msg.created_at)}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            {/* Input area */}
            <div className="border-t border-[#ebebeb] px-4 py-3">
              <div className="mx-auto max-w-2xl">
                <div className="flex items-end gap-2">
                  <Textarea
                    ref={textareaRef}
                    placeholder="Type your reply..."
                    value={replyText}
                    onChange={handleTextareaInput}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    className="min-h-[36px] max-h-[160px] resize-none text-[13px]"
                  />
                  <Button
                    size="sm"
                    className="h-9 w-9 flex-shrink-0 p-0"
                    onClick={handleSendReply}
                    disabled={!replyText.trim() || sending}
                  >
                    <PaperPlaneTilt size={16} weight="fill" />
                  </Button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Switch
                    checked={aiAutoReply}
                    onCheckedChange={(checked) => {
                      setAiAutoReply(checked)
                      if (!checked) handleTakeOver()
                    }}
                    className="h-4 w-7"
                  />
                  <span className="text-[11px] text-[#737373]">
                    AI auto-reply {aiAutoReply ? 'on' : 'off'}
                  </span>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* ================================================================= */}
      {/* RIGHT PANEL: Contact Details */}
      {/* ================================================================= */}
      {detail?.contact ? (
        <div className="flex w-[280px] flex-shrink-0 flex-col border-l border-[#ebebeb]">
          <div className="p-4">
            {/* Contact header */}
            <div className="flex flex-col items-center text-center">
              <Avatar className="h-12 w-12">
                <AvatarFallback className="bg-[#0a0a0a] text-sm text-white">
                  {getInitials(detail.contact.name)}
                </AvatarFallback>
              </Avatar>
              <h3 className="mt-2 text-[14px] font-medium text-[#0a0a0a]">
                {detail.contact.name || 'Unknown'}
              </h3>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${channelDotColor(detail.channel)}`}
                />
                <span className="text-[12px] text-[#737373]">
                  {channelLabel(detail.channel)}
                </span>
                {detail.contact.language && (
                  <>
                    <span className="text-[12px] text-[#d4d4d4]">|</span>
                    <span className="text-[12px] text-[#737373]">
                      {detail.contact.language.toUpperCase()}
                    </span>
                  </>
                )}
              </div>
            </div>

            <Separator className="my-4" />

            {/* Contact info */}
            <div className="space-y-3">
              {detail.contact.email && (
                <div>
                  <div className="text-[11px] font-medium text-[#a3a3a3] uppercase tracking-wider">
                    Email
                  </div>
                  <div className="mt-0.5 text-[13px] text-[#0a0a0a] break-all">
                    {detail.contact.email}
                  </div>
                </div>
              )}
              {detail.contact.phone && (
                <div>
                  <div className="text-[11px] font-medium text-[#a3a3a3] uppercase tracking-wider">
                    Phone
                  </div>
                  <div className="mt-0.5 text-[13px] text-[#0a0a0a]">
                    {detail.contact.phone}
                  </div>
                </div>
              )}
              <div>
                <div className="text-[11px] font-medium text-[#a3a3a3] uppercase tracking-wider">
                  Conversations
                </div>
                <div className="mt-0.5 text-[13px] text-[#0a0a0a]">
                  {detail.conversation_count}
                </div>
              </div>

              {detail.contact.tags && detail.contact.tags.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-[#a3a3a3] uppercase tracking-wider">
                    Tags
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {detail.contact.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <Separator className="my-4" />

            {/* Notes */}
            <div>
              <div className="text-[11px] font-medium text-[#a3a3a3] uppercase tracking-wider mb-1.5">
                Notes
              </div>
              <Textarea
                placeholder="Add notes about this contact..."
                value={contactNotes}
                onChange={(e) => setContactNotes(e.target.value)}
                rows={4}
                className="text-[12px] resize-none"
              />
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7 w-full text-[11px]"
                onClick={handleSaveNotes}
                disabled={savingNotes}
              >
                {savingNotes ? 'Saving...' : 'Save notes'}
              </Button>
            </div>
          </div>
        </div>
      ) : selectedId && detail ? (
        <div className="flex w-[280px] flex-shrink-0 items-center justify-center border-l border-[#ebebeb]">
          <div className="text-[12px] text-[#a3a3a3]">No contact info</div>
        </div>
      ) : null}
    </div>
  )
}
