'use client'

import { useState, useEffect, useRef, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Panel } from '@/components/ui/panel'
import { Markdown } from '@/components/ui/markdown'
import { AiWidgetProvider } from '@/components/ui/ai-widget'
import { AiComposer } from '@/components/ui/ai-composer'
import { AttachmentList } from '@/components/ui/attachment-preview'
import { Loader } from '@/components/ui/loader'
import { ContactAvatar } from '@/components/ui/contact-avatar'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { MODEL_CATALOG } from '@/lib/ai/catalog'
import type { UploadedAttachment } from '@/lib/chat-attachments/constants'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import {
  MagnifyingGlass,
  PaperPlaneTilt,
  Star,
  DotsThreeVertical,
  GearSix,
  UserCircle,
  Plus,
  CircleDashed,
  CaretDown,
  CaretUp,
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

function channelIcon(channel: ChannelType, size = 14) {
  switch (channel) {
    case 'whatsapp':
      return <ChannelIcon kind="whatsapp" size={size} className="text-[#25D366]" />
    case 'facebook':
      return <ChannelIcon kind="messenger" size={size} className="text-[#0084FF]" />
    case 'phone':
      return <ChannelIcon kind="phone" size={size} className="text-[#a855f7]" />
    case 'website':
    default:
      return <ChannelIcon kind="website" size={size} className="text-[#f59e0b]" />
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

/**
 * Empty-state for an internal agent chat with no messages yet —
 * shown when the user clicks "+ New chat" in the sidebar, or when
 * they first open an internal agent they've never spoken to.
 *
 * Centered hero prompt + the shared <AiComposer> in hero variant.
 * Once the first message is sent the normal message-list layout
 * takes over.
 */
function InternalNewChatHero({
  agentName,
  replyText,
  onChangeValue,
  onSend,
  sending,
  model,
}: {
  agentName: string
  replyText: string
  onChangeValue: (next: string) => void
  onSend: (ctx: { text: string; attachments: UploadedAttachment[] }) => void
  sending: boolean
  model: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }
}) {
  return (
    <div className="flex flex-1 flex-col bg-[#fafafa]">
      <div className="flex flex-1 flex-col items-center justify-center px-6 -mt-8">
        <h1 className="text-2xl font-semibold text-[#2e2e2e] tracking-tight text-center">
          What can I do for you?
        </h1>
        <p className="mt-2 text-[13px] text-[#a3a3a3] text-center">
          Ask {agentName} anything — a fresh conversation starts with your first message.
        </p>

        <div className="mt-8 w-full max-w-2xl">
          <AiComposer
            value={replyText}
            onChange={onChangeValue}
            onSubmit={onSend}
            sending={sending}
            variant="hero"
            placeholder="Ask anything"
            model={model}
          />
        </div>
      </div>
    </div>
  )
}

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
  const [filteredAgent, setFilteredAgent] = useState<{ id: string; name: string; avatar_url: string | null; settings?: Record<string, unknown> | null } | null>(null)
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
  const [contactNotes, setContactNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [rightTab, setRightTab] = useState<'details' | 'copilot'>('details')
  const [starred, setStarred] = useState<Set<string>>(new Set())
  /**
   * Per-turn model override for internal-agent chats. Persisted per
   * (user, agent) in localStorage so switching conversations or
   * reloading keeps the pick — sending nothing (null) falls back to
   * the agent's configured model.
   */
  const [chatModel, setChatModelState] = useState<string | null>(null)
  useEffect(() => {
    if (!agentFilter || typeof window === 'undefined') return
    const raw = window.localStorage.getItem(`inbox:chat-model:${agentFilter}`)
    setChatModelState(raw)
  }, [agentFilter])
  function setChatModel(name: string) {
    setChatModelState(name)
    if (agentFilter && typeof window !== 'undefined') {
      window.localStorage.setItem(`inbox:chat-model:${agentFilter}`, name)
    }
  }

  const messagesEndRef = useRef<HTMLDivElement>(null)

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
      .then(data => { if (data?.id) setFilteredAgent({ id: data.id, name: data.name, avatar_url: data.avatar_url, settings: data.settings ?? null }) })
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

  async function handleSendReply(override?: { message: string; attachments?: UploadedAttachment[] }) {
    // Internal agent mode: ChatGPT-style. Send via /api/chat which
    // handles auth-based visitor scoping, may create the conversation
    // if selectedId is null, and generates an AI response.
    const fromOverride = override?.message?.trim() ?? ''
    const typed = replyText.trim()
    const content = fromOverride || typed
    const attachmentsPayload = override?.attachments ?? []
    const hasAttachments = attachmentsPayload.length > 0

    if (isInternalAgent && filteredAgent) {
      if ((!content && !hasAttachments) || sending) return
      return handleInternalChatSend({ message: content, attachments: override?.attachments })
    }
    if ((!content && !hasAttachments) || !selectedId || sending) return
    const convId = selectedId
    const tempId = `temp-${Date.now()}`
    const nowIso = new Date().toISOString()

    // Build optimistic message matching the Message shape. id is a temp
    // placeholder; we'll swap for the server-authoritative row on success.
    const optimistic: Message = {
      id: tempId,
      conversation_id: convId,
      org_id: detail?.org_id ?? '',
      role: 'human_agent' as MessageRole,
      content,
      channel: detail?.channel ?? null,
      metadata: {
        optimistic: true,
        sent_by: userId ?? null,
        ...(hasAttachments ? { attachments: attachmentsPayload } : {}),
      },
      created_at: nowIso,
    } as Message

    // 1) Append to the open conversation view so the bubble appears now.
    setDetail(prev => prev && prev.id === convId
      ? { ...prev, messages: [...prev.messages, optimistic] }
      : prev)

    // 2) Update the list: bump this conversation to the top with the
    //    new last-message preview.
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === convId)
      if (idx === -1) return prev
      const updated = [...prev]
      const preview = content
        || (hasAttachments
          ? `📎 ${attachmentsPayload.length} attachment${attachmentsPayload.length === 1 ? '' : 's'}`
          : '')
      const conv = {
        ...updated[idx],
        last_message: { content: preview, role: 'human_agent' as MessageRole, created_at: nowIso },
        message_count: (updated[idx].message_count || 0) + 1,
        updated_at: nowIso,
      }
      updated.splice(idx, 1)
      return [conv, ...updated]
    })

    // 3) Clear input + snap scroll to the new bubble.
    setReplyText('')
    setTimeout(scrollToBottom, 50)

    setSending(true)
    try {
      const res = await fetch(`/api/inbox/${convId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          attachments: hasAttachments ? attachmentsPayload : undefined,
        }),
      })
      if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to send'))
      const saved = (await res.json()) as Message

      // Replace the optimistic row with the server-authoritative one so
      // the realtime event (when it arrives) dedupes by real id and is
      // a no-op.
      setDetail(prev => prev && prev.id === convId
        ? { ...prev, messages: prev.messages.map(m => m.id === tempId ? saved : m) }
        : prev)
    } catch (err) {
      // Roll back the optimistic additions.
      setDetail(prev => prev && prev.id === convId
        ? { ...prev, messages: prev.messages.filter(m => m.id !== tempId) }
        : prev)
      // Put the draft back so the user can retry.
      setReplyText(content)
      console.error('Failed to send reply:', err)
    } finally {
      setSending(false)
    }
  }

  async function handleInternalChatSend(override?: { message: string; attachments?: UploadedAttachment[] }) {
    if (!filteredAgent) return
    const content = (override?.message ?? replyText).trim()
    if (!content) return
    const nowIso = new Date().toISOString()
    const convId = selectedId
    const tempUserId = `temp-user-${Date.now()}`
    const tempAsstId = `temp-asst-${Date.now() + 1}`

    // Optimistic user bubble (role: 'user' for internal chats, since the
    // logged-in user IS the end user in this flow).
    const optimisticUser: Message = {
      id: tempUserId,
      conversation_id: convId ?? '',
      org_id: detail?.org_id ?? orgId ?? '',
      role: 'user' as MessageRole,
      content,
      channel: 'website' as ChannelType,
      metadata: { optimistic: true },
      created_at: nowIso,
    } as Message

    if (convId) {
      setDetail(prev => prev && prev.id === convId
        ? { ...prev, messages: [...prev.messages, optimisticUser] }
        : prev)
    } else {
      // No conversation yet — synthesize a placeholder detail so the UI
      // switches out of the empty state and shows the bubble immediately.
      setDetail({
        id: '',
        org_id: orgId ?? '',
        agent_id: filteredAgent.id,
        contact_id: null,
        channel: 'website' as ChannelType,
        status: 'active',
        assigned_to: null,
        started_at: nowIso,
        resolved_at: null,
        created_at: nowIso,
        updated_at: nowIso,
        contact: null,
        agent: { id: filteredAgent.id, name: filteredAgent.name, avatar_url: filteredAgent.avatar_url },
        last_message: null,
        message_count: 1,
        messages: [optimisticUser],
        conversation_count: 0,
      } as ConversationDetail)
    }

    if (!override) {
      setReplyText('')
    }
    setTimeout(scrollToBottom, 50)

    setSending(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: filteredAgent.id,
          message: content,
          conversationId: convId ?? undefined,
          stream: false,
          isTest: true,
          modelName: chatModel || undefined,
          attachments: override?.attachments && override.attachments.length > 0
            ? override.attachments
            : undefined,
        }),
      })
      if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to send'))
      const data = (await res.json()) as { response: string; conversationId: string; messageId: string }

      const assistantMsg: Message = {
        id: data.messageId,
        conversation_id: data.conversationId,
        org_id: orgId ?? '',
        role: 'assistant' as MessageRole,
        content: data.response,
        channel: 'website' as ChannelType,
        metadata: {},
        created_at: new Date().toISOString(),
      } as Message

      // Swap optimistic user bubble (if no convId yet) with the real
      // conversation id, and append the assistant reply.
      if (!convId) {
        setSelectedId(data.conversationId)
      }
      setDetail(prev => {
        if (!prev) return prev
        const withRealConv = { ...prev, id: data.conversationId }
        const nextMessages = [
          ...withRealConv.messages.map(m => m.id === tempUserId ? { ...m, conversation_id: data.conversationId } : m),
          { ...assistantMsg, id: tempAsstId }, // keep a stable temp id locally so realtime INSERT can dedupe by data.messageId
        ]
        return { ...withRealConv, messages: nextMessages }
      })

      // Ensure the list reflects this conversation at the top.
      setConversations(prev => {
        const existing = prev.find(c => c.id === data.conversationId)
        const lastMsg = { content: data.response, role: 'assistant' as MessageRole, created_at: new Date().toISOString() }
        if (existing) {
          const rest = prev.filter(c => c.id !== data.conversationId)
          return [{ ...existing, last_message: lastMsg, updated_at: lastMsg.created_at }, ...rest]
        }
        // Brand-new conversation — fetch the list so the server provides a
        // well-formed ConversationItem (avoids drift between client shape
        // and API shape).
        fetchConversations()
        return prev
      })

      setTimeout(scrollToBottom, 100)
    } catch (err) {
      console.error('Internal chat send failed:', err)
      // Roll back optimistic bubble.
      setDetail(prev => prev
        ? { ...prev, messages: prev.messages.filter(m => m.id !== tempUserId) }
        : prev)
      setReplyText(content)
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

  const isInternalAgent = filteredAgent?.settings
    ? (filteredAgent.settings as { is_customer_facing?: boolean }).is_customer_facing === false
    : false

  /**
   * Model picker slot for <AiComposer>. Only shown on internal-agent
   * chats — operators shouldn't swap the customer's agent mid-reply.
   * Default value falls back to the agent's configured model_name (we
   * read it off filteredAgent.settings when present, but
   * /api/agents/:id.settings doesn't include model_name; so the fallback
   * is the first catalog entry). User's pick overrides per-agent via
   * localStorage.
   */
  const composerModel = isInternalAgent
    ? {
        value: chatModel || (filteredAgent?.settings as { model_name?: string } | null)?.model_name || MODEL_CATALOG[0].name,
        options: MODEL_CATALOG.map(m => ({ value: m.name, label: m.short ?? m.label })),
        onChange: setChatModel,
      }
    : undefined

  function seedBlankInternalDetail(): ConversationDetail | null {
    if (!filteredAgent) return null
    const nowIso = new Date().toISOString()
    return {
      id: '',
      org_id: orgId ?? '',
      agent_id: filteredAgent.id,
      contact_id: null,
      channel: 'website' as ChannelType,
      status: 'active',
      assigned_to: null,
      started_at: nowIso,
      resolved_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      contact: null,
      agent: { id: filteredAgent.id, name: filteredAgent.name, avatar_url: filteredAgent.avatar_url },
      last_message: null,
      message_count: 0,
      messages: [],
      conversation_count: 0,
    } as ConversationDetail
  }

  function startNewChat() {
    setSelectedId(null)
    setDetail(seedBlankInternalDetail())
    setReplyText('')
  }

  // Auto-enter new-chat mode when landing on an internal agent with no
  // selection — keeps the composer visible so the user can start typing.
  useEffect(() => {
    if (!isInternalAgent || !filteredAgent) return
    if (selectedId || detail) return
    setDetail(seedBlankInternalDetail())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInternalAgent, filteredAgent, selectedId, detail])

  return (
    <div className="flex h-full bg-[#f5f5f5] overflow-hidden gap-3 p-3 pt-3">
      {/* ============================================================= */}
      {/* LEFT: Conversation List */}
      {/* ============================================================= */}
      <Panel className="bg-[#fafafa]" resizable defaultWidth={320} minWidth={260} maxWidth={480} storageKey="inbox:list">
        {/* Header */}
        <div className="flex h-12 items-center gap-2.5 px-4 border-b border-black/[0.04] flex-shrink-0">
          {filteredAgent ? (
            <>
              <ContactAvatar
                src={filteredAgent.avatar_url}
                name={filteredAgent.name}
                seed={filteredAgent.id}
                size={28}
              />
              <span className="text-base font-semibold text-[#2e2e2e] truncate flex-1">{filteredAgent.name}</span>
              <Link href={`/agents/${filteredAgent.id}`} className="rounded-md p-1 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#2e2e2e]" title="Agent settings">
                <GearSix size={16} />
              </Link>
            </>
          ) : (
            <span className="text-base font-semibold text-[#2e2e2e]">All conversations</span>
          )}
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-black/[0.04]">
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

        {/* New chat CTA (internal agents only). Conversation-level
            status filters (All / Active / Escalated) are intentionally
            hidden for now — the whole status model is pending a
            redesign; every conversation stays "active" in the mean time. */}
        {isInternalAgent && (
          <div className="px-3 pt-2">
            <button
              onClick={startNewChat}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-[#2e2e2e] hover:bg-white transition-colors"
            >
              <Plus size={14} weight="bold" />
              New chat
            </button>
          </div>
        )}

        {/* List */}
        <ScrollArea className="flex-1">
          {loading ? (
            <div className="px-2 py-1 space-y-0.5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 px-3 py-2.5">
                  <Skeleton className="h-7 w-7 flex-shrink-0 rounded-full" />
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
                // Internal chats use last-message content as the row title
                // (ChatGPT-style). Contact name here would just be the
                // logged-in user on every row, which is noise.
                const rowTitle = isInternalAgent
                  ? (conv.last_message?.content ? truncate(conv.last_message.content, 40) : 'New chat')
                  : contactName
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
                    {isInternalAgent ? (
                      <CircleDashed
                        size={16}
                        weight="bold"
                        className="mt-0.5 flex-shrink-0 text-[#a3a3a3]"
                      />
                    ) : (
                      <ContactAvatar
                        name={contactName}
                        seed={conv.contact?.id || conv.id}
                        size={28}
                        className="mt-0.5 flex-shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`truncate text-sm text-[#2e2e2e] ${isInternalAgent ? 'font-medium' : 'font-semibold'}`}>{rowTitle}</span>
                        <span className="flex-shrink-0 text-xs text-[#a3a3a3]">
                          {conv.last_message ? timeAgo(conv.last_message.created_at) : timeAgo(conv.updated_at)}
                        </span>
                      </div>
                      {!isInternalAgent && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="truncate text-[13px] text-[#737373]">
                            {conv.last_message ? truncate(conv.last_message.content, 45) : 'No messages yet'}
                          </span>
                        </div>
                      )}
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
        {!detail ? (
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
        ) : isInternalAgent && detail.messages.length === 0 ? (
          // Internal-agent new-chat hero: empty conversation (either
          // freshly created via "+ New chat" or a brand-new landing
          // on an agent the user hasn't spoken to yet). Centered
          // prompt + single composer — the normal message-list
          // layout would leave a huge empty column otherwise.
          <InternalNewChatHero
            agentName={filteredAgent?.name ?? 'agent'}
            replyText={replyText}
            onChangeValue={setReplyText}
            onSend={(ctx) => { void handleInternalChatSend({ message: ctx.text, attachments: ctx.attachments }) }}
            sending={sending}
            model={composerModel!}
          />
        ) : detail ? (
          <>
            {/* Header */}
            <div className="flex h-12 items-center justify-between border-b border-black/[0.04] px-5 flex-shrink-0">
              <div className="flex items-center gap-3">
                {(() => {
                  const name = detail.contact?.name || detail.contact?.phone || detail.contact?.email || ''
                  return (
                    <ContactAvatar
                      name={name}
                      seed={detail.contact?.id || name}
                      size={32}
                    />
                  )
                })()}
                <span className="text-[15px] font-semibold text-[#2e2e2e]">{detail.contact?.name || detail.contact?.phone || detail.contact?.email || 'Unknown'}</span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => toggleStar(detail.id)} className="p-1.5 rounded hover:bg-[#f5f5f5]">
                  <Star size={16} weight={starred.has(detail.id) ? 'fill' : 'bold'} className={starred.has(detail.id) ? 'text-yellow-500' : 'text-[#737373]'} />
                </button>
                {/* Status dropdown (Active/Waiting/Resolved/Escalated)
                    intentionally hidden — pending a rethink of the
                    conversation lifecycle. */}
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
                    // In internal-agent mode the logged-in user IS the
                    // "user", so flip: user→right (outgoing), assistant→left.
                    // In customer-facing mode, the customer is "user"
                    // (left) and assistant/human_agent are outgoing (right).
                    const isOutgoing = isInternalAgent ? isUser : (isAI || isHumanAgent)
                    const prevMsg = idx > 0 ? detail.messages[idx - 1] : null
                    const showAvatar = !prevMsg || prevMsg.role !== msg.role

                    return (
                      <div key={msg.id} className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                        {!isOutgoing && (
                          isInternalAgent ? (
                            <ContactAvatar
                              src={filteredAgent?.avatar_url}
                              name={filteredAgent?.name || 'Assistant'}
                              seed={filteredAgent?.id || 'agent'}
                              size={24}
                              className={`flex-shrink-0 ${showAvatar ? '' : 'invisible'}`}
                            />
                          ) : (
                            <ContactAvatar
                              name={detail.contact?.name || detail.contact?.phone || detail.contact?.email || ''}
                              seed={detail.contact?.id || detail.contact?.name || ''}
                              size={24}
                              className={`flex-shrink-0 ${showAvatar ? '' : 'invisible'}`}
                            />
                          )
                        )}
                        <div className={`max-w-[75%] flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                          <div
                            className={`rounded-3xl px-3.5 py-2 text-[13px] leading-relaxed ${
                              isOutgoing
                                ? 'bg-[#f7f7f7] text-[#2e2e2e]'
                                : 'bg-white text-[#2e2e2e] ring-1 ring-black/[0.04]'
                            }`}
                          >
                            {/* Wrap every bubble in AiWidgetProvider so fenced
                                ```ui blocks inside the message render as
                                interactive widgets. Interactive only when:
                                - This is an internal-agent chat (operator IS
                                  the user and their submits drive the agent)
                                - AND the message is the most recent one
                                Customer-facing conversations show widgets
                                read-only so team members don't submit on the
                                customer's behalf. */}
                            <AiWidgetProvider
                              submit={(message) => { void handleInternalChatSend({ message }) }}
                              disabled={!isInternalAgent || idx !== detail.messages.length - 1}
                            >
                              {(() => {
                                const attachmentsOnMsg = (msg.metadata as { attachments?: UploadedAttachment[] } | null | undefined)?.attachments
                                return (
                                  <>
                                    {attachmentsOnMsg && attachmentsOnMsg.length > 0 && (
                                      <div className={msg.content ? 'mb-2' : ''}>
                                        <AttachmentList attachments={attachmentsOnMsg} />
                                      </div>
                                    )}
                                    {msg.content && (
                                      <Markdown className="prose prose-sm max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-a:text-[#2e2e2e] prose-a:underline prose-code:text-[#2e2e2e] prose-code:bg-[#f3f3f3] prose-code:rounded prose-code:px-1 prose-pre:my-1.5">
                                        {msg.content}
                                      </Markdown>
                                    )}
                                  </>
                                )
                              })()}
                            </AiWidgetProvider>
                            <div className={`mt-1 flex items-center gap-1 text-[10px] text-[#a3a3a3] leading-none select-none ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                              <span>{formatTimestamp(msg.created_at)}</span>
                              {isOutgoing && <Check size={10} weight="bold" className="text-[#3b82f6]" />}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
                {/* Typing indicator — only for internal-agent mode,
                    where an AI reply is expected after the user's
                    send. Customer-facing handleSendReply posts a
                    human_agent message with no AI follow-up, so no
                    typing indicator there. */}
                {sending && isInternalAgent && (
                  <div className="flex items-end gap-2 justify-start">
                    <ContactAvatar
                      src={filteredAgent?.avatar_url}
                      name={filteredAgent?.name || 'Assistant'}
                      seed={filteredAgent?.id || 'agent'}
                      size={24}
                      className="flex-shrink-0"
                    />
                    <div className="bg-white rounded-3xl px-4 py-3 ring-1 ring-black/[0.04]">
                      <Loader variant="typing" size="sm" />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            {/* Composer — shared <AiComposer> used by every chat
                surface. Internal chats get a model picker; customer
                chats don't (operators shouldn't swap the customer's
                agent mid-reply). */}
            <div className="bg-white px-4 pb-4 pt-2 flex-shrink-0">
              <AiComposer
                value={replyText}
                onChange={setReplyText}
                onSubmit={(ctx) => {
                  if (isInternalAgent) {
                    void handleInternalChatSend({ message: ctx.text, attachments: ctx.attachments })
                  } else {
                    // Customer-facing reply: attachments now wired. Reply
                    // route persists them on the message and dispatches to
                    // the platform (WhatsApp/Messenger) as media sends.
                    void handleSendReply({ message: ctx.text, attachments: ctx.attachments })
                  }
                }}
                sending={sending}
                model={composerModel}
                variant="inline"
                placeholder={isInternalAgent ? 'Ask anything' : `Reply on ${channelLabel(detail.channel)}`}
              />
            </div>
          </>
        ) : null}
      </Panel>

      {/* ============================================================= */}
      {/* RIGHT: Details — hidden for internal agents (no customer to show) */}
      {/* ============================================================= */}
      {detail?.contact && !isInternalAgent && (
        <Panel resizable resizeFrom="left" defaultWidth={320} minWidth={260} maxWidth={480} storageKey="inbox:details">
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
                      <ContactAvatar name={userName} size={24} />
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
