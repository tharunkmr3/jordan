'use client'

import { useState, useEffect, useRef, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Panel } from '@/components/ui/panel'
import { Markdown } from '@/components/ui/markdown'
import { AiWidgetProvider } from '@/components/ui/ai-widget'
import { TextEffect } from '@/components/core/text-effect'
import { TextShimmerWave } from '@/components/core/text-shimmer-wave'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { AiComposer } from '@/components/ui/ai-composer'
import { AttachmentList } from '@/components/ui/attachment-preview'
import { Loader } from '@/components/ui/loader'
import { ContactAvatar } from '@/components/ui/contact-avatar'
import { ChannelIcon } from '@/components/ui/channel-icon'
import { MODEL_CATALOG } from '@/lib/ai/catalog'
import type { UploadedAttachment } from '@/lib/chat-attachments/constants'
import { Source, SourceTrigger, SourceContent } from '@/components/ui/source'
import { DocumentTypeIcon } from '@/components/ui/document-type-icon'
import { StructuredReply } from '@/components/ui/structured-reply'
import { parseStructuredReply } from '@/lib/ai/structured-output'
import type { MessageSource } from '@/types/database'
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
  PlusCircle,
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
  // First user message in the thread — used as the stable row title for
  // internal-agent chats (ChatGPT-style "name the thread by what you
  // asked first"). null until the user has sent their first message.
  first_user_message: { content: string; role: MessageRole; created_at: string } | null
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

// Capitalize the first character, leave the rest untouched. Used for
// internal-agent thread titles where the raw first user message may come
// in lowercased (voice input, quick typing) but should read as a title.
function capitalizeFirst(str: string | undefined | null): string {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Split a model response into (a) the thinking trace inside <think>...</think>
 * tags and (b) the visible prose after. Sarvam-M and other reasoning models
 * embed their chain-of-thought inline; the UI renders the thinking portion
 * as a collapsible block and the visible prose as the main message.
 *
 * If <think> is still open (no closing tag yet because we're mid-stream),
 * everything after <think> is treated as thinking and visible is empty —
 * that way the user sees "Thinking..." shimmer until the close tag arrives.
 */
function splitThinking(text: string): { thinking: string; visible: string; thinkingOpen: boolean } {
  if (!text) return { thinking: '', visible: '', thinkingOpen: false }
  const openIdx = text.indexOf('<think>')
  if (openIdx === -1) return { thinking: '', visible: text, thinkingOpen: false }
  const before = text.slice(0, openIdx)
  const afterOpen = text.slice(openIdx + '<think>'.length)
  const closeIdx = afterOpen.indexOf('</think>')
  if (closeIdx === -1) {
    // Thinking block still streaming — no close tag yet.
    return { thinking: afterOpen.trim(), visible: before.trim(), thinkingOpen: true }
  }
  const thinking = afterOpen.slice(0, closeIdx).trim()
  const afterClose = afterOpen.slice(closeIdx + '</think>'.length)
  return { thinking, visible: (before + afterClose).trim(), thinkingOpen: false }
}

// ---------------------------------------------------------------------------
// Source-citation relevance filter (client-side mirror)
//
// Retrieval pulls top-8 KB chunks per turn; the long tail has low
// hybrid scores (0.1–0.2) and is pure noise — doesn't belong on a chip.
// The server's buildMessageSources already applies this filter at save
// time, but we re-run it here so:
//   1. Older messages saved before the server filter existed also
//      display cleanly (no DB migration needed).
//   2. Future tuning of thresholds takes effect retroactively across
//      all history the next time it renders.
//
// Keep in sync with buildMessageSources in src/lib/ai/chat-pipeline.ts.
// ---------------------------------------------------------------------------

const SOURCE_MIN_ABS_SIMILARITY = 0.25
const SOURCE_MIN_REL_RATIO = 0.6
const SOURCE_MAX = 4

function isWebSource(s: MessageSource): s is Extract<MessageSource, { kind: 'web' }> {
  return s.kind === 'web'
}

function hostOfUrl(url: string): string {
  try { return new URL(url).host } catch { return url }
}

function filterRelevantSources(sources: MessageSource[]): MessageSource[] {
  if (sources.length === 0) return sources

  // Split by kind: web sources come from explicit tool calls (web_search
  // / deep_research), so every hit is already intentional — no similarity
  // score exists to filter on. Only the KB branch needs the noise filter.
  const web = sources.filter(isWebSource)
  const kb = sources.filter((s): s is Extract<MessageSource, { kind?: 'kb' }> => !isWebSource(s))

  // Collapse duplicate document_ids defensively — historical data from
  // before the server-side de-dupe might contain them.
  const byDoc = new Map<string, typeof kb[number]>()
  for (const s of kb) {
    const prev = byDoc.get(s.document_id)
    if (!prev || s.similarity > prev.similarity) byDoc.set(s.document_id, s)
  }
  const candidates = [...byDoc.values()].sort((a, b) => b.similarity - a.similarity)
  const topScore = candidates[0]?.similarity ?? 0
  const relFloor = topScore * SOURCE_MIN_REL_RATIO
  const filteredKb = candidates
    .filter((s) => s.similarity >= SOURCE_MIN_ABS_SIMILARITY && s.similarity >= relFloor)
    .slice(0, SOURCE_MAX)

  // KB chips first (usually more authoritative for the user's data),
  // web chips after.
  return [...filteredKb, ...web]
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
  onSend: (ctx: { text: string; attachments: UploadedAttachment[]; kbReferenceIds: string[] }) => void
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
  const router = useRouter()
  const agentFilter = searchParams.get('agentId')

  // The unscoped "All conversations" view was removed — the inbox is only
  // meaningful scoped to a single agent. If someone lands at /inbox with
  // no agentId (bookmark, old link), send them to the dashboard where the
  // sidebar's per-agent entries become the entry point.
  useEffect(() => {
    if (!agentFilter) router.replace('/dashboard')
  }, [agentFilter, router])

  // State
  const [orgId, setOrgId] = useState<string | null>(null)
  const [filteredAgent, setFilteredAgent] = useState<{ id: string; name: string; avatar_url: string | null; settings?: Record<string, unknown> | null } | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [userName, setUserName] = useState<string>('')
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  // When we optimistically transition a blank new-chat to a real conversation
  // id (handleInternalChatSend success path), the useEffect[selectedId] would
  // otherwise re-fetch /api/inbox/{id} and stomp the locally-correct detail
  // (skeleton flash + possible replica lag losing the just-sent assistant
  // message). Set this ref before the setSelectedId to tell the effect to
  // skip its one-shot fetch.
  const skipDetailFetchRef = useRef(false)
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

  const scrollToBottom = useCallback((mode: 'smooth' | 'instant' = 'smooth') => {
    const el = messagesEndRef.current
    if (!el) return
    // Find the nearest scrollable ancestor and set scrollTop directly,
    // instead of scrollIntoView (which defaults to block:'start' and
    // bubbles up to the window when the immediate ancestor isn't
    // overflowing). `instant` mode is used on initial conversation open
    // so the thread appears already pinned to the bottom — no visible
    // "open at top then animate down" flash.
    let node: HTMLElement | null = el.parentElement
    while (node) {
      const oy = getComputedStyle(node).overflowY
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) {
        node.scrollTo({ top: node.scrollHeight, behavior: mode })
        return
      }
      node = node.parentElement
    }
  }, [])

  // Tracks whether we've already positioned the scroll for the current
  // detail. Flips to false whenever selectedId changes; the first render
  // with messages snaps instantly (no animation), subsequent renders
  // (new tokens, new messages) animate smoothly.
  const didInitialScrollRef = useRef<string | null>(null)

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
      // Don't clobber a caller-provided blank seed (id === ''): startNewChat
      // sets detail to a blank ConversationDetail in the SAME batch as
      // setSelectedId(null), and we must preserve it. Only clear when the
      // detail still belongs to a real, previously-loaded conversation.
      setDetail(prev => (prev && prev.id === '' ? prev : null))
      return
    }
    // One-shot skip: the send pipeline already populated detail with the
    // real conversation id + both user/assistant messages; re-fetching
    // here would replace it with server state that may not yet include
    // the just-written row (and would cause a skeleton flash that the
    // user reads as "the chat jumped").
    if (skipDetailFetchRef.current) {
      skipDetailFetchRef.current = false
      return
    }
    // Guard against stale responses: if the user clicks "New chat" (or
    // switches to a different conversation) while this fetch is in flight,
    // the late response must NOT overwrite the new state.
    let cancelled = false
    const ctrl = new AbortController()
    async function load() {
      setDetailLoading(true)
      try {
        const res = await fetch(`/api/inbox/${selectedId}`, { signal: ctrl.signal })
        if (cancelled) return
        if (res.ok) {
          const data: ConversationDetail = await res.json()
          if (cancelled) return
          setDetail(data)
          setContactNotes((data.contact?.metadata as Record<string, unknown>)?.notes as string || '')
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        throw err
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
      ctrl.abort()
    }
  }, [selectedId])

  useEffect(() => {
    if (!detail?.messages) return
    const firstPaintForThisDetail = didInitialScrollRef.current !== detail.id
    if (firstPaintForThisDetail) {
      // Initial open of this conversation: snap to bottom with no
      // animation so the user lands already-at-bottom.
      didInitialScrollRef.current = detail.id
      requestAnimationFrame(() => scrollToBottom('instant'))
      return
    }
    // Subsequent updates (new tokens streaming in, realtime inserts,
    // user sends): smooth scroll.
    setTimeout(() => scrollToBottom('smooth'), 50)
  }, [detail?.messages, detail?.id, scrollToBottom])

  // Realtime: stay in sync across tabs / devices. Any client mutating a
  // conversation or message in this org should reflect instantly in every
  // other open inbox. Two separate subscriptions:
  //   - messages INSERT → append to open thread, bump list entry
  //   - conversations INSERT → pull in the new thread (re-fetch list)
  //   - conversations UPDATE → update list entry in place (status, name,
  //     first_user_message, etc. if the server ever writes those)
  useEffect(() => {
    if (!orgId) return
    const channel = supabase
      .channel(`inbox-sync-${orgId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `org_id=eq.${orgId}` }, (payload) => {
        const newMsg = payload.new as Message
        setDetail((prev) => {
          if (!prev || prev.id !== newMsg.conversation_id) return prev
          // Dedupe by exact id match (already in list) OR by optimistic
          // placeholder: when this tab sent the message, the local bubble
          // has a temp id + optimistic:true and matching content, so we
          // swap the temp row for the server-authoritative one instead
          // of appending a duplicate.
          if (prev.messages.some((m) => m.id === newMsg.id)) return prev
          const optimisticIdx = prev.messages.findIndex(m => {
            const meta = m.metadata as { optimistic?: boolean; streaming?: boolean } | null | undefined
            if (!meta?.optimistic && !meta?.streaming) return false
            if (m.role !== newMsg.role) return false
            const a = typeof m.content === 'string' ? m.content : ''
            const b = typeof newMsg.content === 'string' ? newMsg.content : ''
            return a.trim() === b.trim()
          })
          if (optimisticIdx !== -1) {
            const next = [...prev.messages]
            next[optimisticIdx] = { ...next[optimisticIdx], ...newMsg }
            return { ...prev, messages: next }
          }
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
        setTimeout(() => scrollToBottom('smooth'), 100)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations', filter: `org_id=eq.${orgId}` }, () => {
        // A new thread was created somewhere (another tab, another device,
        // a customer-channel webhook). The INSERT payload doesn't ship
        // the joined contact/agent/last_message shape we render, so just
        // re-fetch the list through the same endpoint the page uses on
        // load — keeps the shape consistent and honors the current
        // agentFilter + is_test visibility rules.
        fetchConversations()
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations', filter: `org_id=eq.${orgId}` }, (payload) => {
        const updated = payload.new as { id: string; status?: string; updated_at?: string }
        setConversations(prev => prev.map(c => c.id === updated.id
          ? { ...c, ...(updated.status ? { status: updated.status as ConversationStatus } : {}), ...(updated.updated_at ? { updated_at: updated.updated_at } : {}) }
          : c))
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [orgId, fetchConversations, scrollToBottom]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSendReply(override?: { message: string; attachments?: UploadedAttachment[]; kbReferenceIds?: string[] }) {
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
      return handleInternalChatSend({ message: content, attachments: override?.attachments, kbReferenceIds: override?.kbReferenceIds })
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

  async function handleInternalChatSend(override?: { message: string; attachments?: UploadedAttachment[]; kbReferenceIds?: string[] }) {
    if (!filteredAgent) return
    const content = (override?.message ?? replyText).trim()
    if (!content) return
    const nowIso = new Date().toISOString()
    const convId = selectedId
    const tempUserId = `temp-user-${Date.now()}`
    const tempAsstId = `temp-asst-${Date.now() + 1}`

    // Optimistic user bubble (role: 'user' for internal chats, since the
    // logged-in user IS the end user in this flow).
    const optimisticAttachments = override?.attachments ?? []
    const optimisticUser: Message = {
      id: tempUserId,
      conversation_id: convId ?? '',
      org_id: detail?.org_id ?? orgId ?? '',
      role: 'user' as MessageRole,
      content,
      channel: 'website' as ChannelType,
      // Persist attachments on the optimistic bubble so the chip/preview
      // renders immediately (AttachmentList reads from metadata.attachments).
      // Without this, the PDF the user just uploaded wouldn't appear in the
      // chat until the real server row replaced the optimistic one.
      metadata: optimisticAttachments.length > 0
        ? { optimistic: true, attachments: optimisticAttachments }
        : { optimistic: true },
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
        first_user_message: {
          content,
          role: 'user' as MessageRole,
          created_at: nowIso,
        },
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
          // Stream tokens so the UI can render them progressively with a
          // per-character fade-in instead of dropping one giant bubble
          // after the model finishes.
          stream: true,
          isTest: true,
          forceNewConversation: !convId,
          modelName: chatModel || undefined,
          attachments: override?.attachments && override.attachments.length > 0
            ? override.attachments
            : undefined,
          kbReferenceIds: override?.kbReferenceIds && override.kbReferenceIds.length > 0
            ? override.kbReferenceIds
            : undefined,
        }),
      })
      if (!res.ok || !res.body) throw new Error(await res.text().catch(() => 'Failed to send'))

      // --- Stream parsing --------------------------------------------------
      // /api/chat emits newline-framed SSE: each line is either `data: {json}`
      // or `data: [DONE]`. The pipeline yields one `meta` chunk with the real
      // conversationId/contactId up front, followed by `token` chunks whose
      // `data` is an incremental text fragment. We append tokens into local
      // state so the assistant bubble re-renders on every frame.
      let conversationIdFromMeta: string | null = null
      let accumulated = ''
      // Mount an empty assistant bubble marked streaming=true so the renderer
      // switches to the fade animation. Real content appends as tokens arrive.
      setDetail(prev => {
        if (!prev) return prev
        const streamingAsst: Message = {
          id: tempAsstId,
          conversation_id: prev.id,
          org_id: orgId ?? '',
          role: 'assistant' as MessageRole,
          content: '',
          channel: 'website' as ChannelType,
          metadata: { streaming: true },
          created_at: new Date().toISOString(),
        } as Message
        return { ...prev, messages: [...prev.messages, streamingAsst] }
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Parse complete `data: ...` frames out of buffer. SSE frames end
        // with a blank line (\n\n) but our server also emits single-\n
        // separators mid-frame — use a loose `data:` prefix scan instead.
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // keep last partial line in buffer
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload) continue
          if (payload === '[DONE]') break
          try {
            const chunk = JSON.parse(payload) as { type: string; data: string }
            if (chunk.type === 'meta') {
              try {
                const meta = JSON.parse(chunk.data) as { conversationId?: string }
                if (meta.conversationId) conversationIdFromMeta = meta.conversationId
              } catch { /* malformed meta — skip */ }
            } else if (chunk.type === 'token') {
              accumulated += chunk.data
              // Functional update so we don't depend on stale closure state.
              setDetail(prev => {
                if (!prev) return prev
                const nextMessages = prev.messages.map(m =>
                  m.id === tempAsstId ? { ...m, content: accumulated } : m,
                )
                return { ...prev, messages: nextMessages }
              })
            } else if (chunk.type === 'structured') {
              // Structured reply synthesis finished on the server. Merge the
              // Block[] payload into the in-flight assistant message so the
              // bubble swaps from streamed Markdown to the deterministic
              // block renderer. Same row, no refetch — the metadata.structured
              // field is what the inbox render checks.
              try {
                const structured = JSON.parse(chunk.data) as { blocks: unknown[] }
                setDetail(prev => {
                  if (!prev) return prev
                  const nextMessages = prev.messages.map(m =>
                    m.id === tempAsstId
                      ? { ...m, metadata: { ...(m.metadata ?? {}), structured } }
                      : m,
                  )
                  return { ...prev, messages: nextMessages }
                })
              } catch { /* malformed structured payload — keep streamed prose */ }
            }
            // 'thought' chunks (tool events) ignored in UI for now.
          } catch { /* malformed chunk — skip */ }
        }
      }

      const realConvId = conversationIdFromMeta ?? convId ?? ''
      if (!realConvId) throw new Error('Missing conversationId in stream')

      // Mark the assistant message as done (flip streaming=false) and stamp
      // the correct conversation id. Simultaneously swap the optimistic user
      // bubble to point at the real conv id.
      if (!convId) {
        skipDetailFetchRef.current = true
        setSelectedId(realConvId)
      }
      setDetail(prev => {
        if (!prev) return prev
        const withRealConv = { ...prev, id: realConvId }
        const nextMessages = withRealConv.messages.map(m => {
          if (m.id === tempUserId) return { ...m, conversation_id: realConvId }
          if (m.id === tempAsstId) return {
            ...m,
            conversation_id: realConvId,
            content: accumulated,
            metadata: { ...(m.metadata ?? {}), streaming: false },
          }
          return m
        })
        return { ...withRealConv, messages: nextMessages }
      })

      // Ensure the list reflects this conversation at the top.
      const lastMsg = { content: accumulated, role: 'assistant' as MessageRole, created_at: new Date().toISOString() }
      // Shim: below code referred to `data.conversationId` / `data.response`
      // in the old non-streaming branch. We reconstruct the same shape here
      // so the rest of the function — sidebar upsert, brand-new insert,
      // reconcile — stays unchanged.
      const data = { conversationId: realConvId, response: accumulated, messageId: '' }
      let isBrandNew = false
      setConversations(prev => {
        const existing = prev.find(c => c.id === data.conversationId)
        if (existing) {
          const rest = prev.filter(c => c.id !== data.conversationId)
          return [{ ...existing, last_message: lastMsg, updated_at: lastMsg.created_at }, ...rest]
        }
        // Brand-new conversation — insert an optimistic entry at the
        // top immediately so the sidebar shows the new thread without
        // waiting on a server round-trip. We reconcile with the
        // authoritative server shape via fetchConversations() below.
        isBrandNew = true
        const optimisticItem: ConversationItem = {
          id: data.conversationId,
          org_id: orgId ?? '',
          agent_id: filteredAgent.id,
          contact_id: null,
          channel: 'website' as ChannelType,
          status: 'active',
          assigned_to: null,
          started_at: nowIso,
          resolved_at: null,
          created_at: nowIso,
          updated_at: lastMsg.created_at,
          contact: {
            id: '',
            name: userName || 'You',
            email: null,
            phone: null,
            channel: 'website' as ChannelType,
            language: null,
            metadata: {},
            tags: [],
          },
          agent: { id: filteredAgent.id, name: filteredAgent.name, avatar_url: filteredAgent.avatar_url },
          last_message: lastMsg,
          first_user_message: {
            content,
            role: 'user' as MessageRole,
            created_at: nowIso,
          },
          message_count: 2,
        }
        return [optimisticItem, ...prev]
      })
      if (isBrandNew) {
        // Fire-and-forget re-fetch to reconcile the optimistic row with the
        // authoritative server shape (contact id, real channel_user_id, etc.)
        fetchConversations()
      }

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
      first_user_message: null,
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

  // Customer-facing agents: auto-select the first (most-recent) conversation
  // once the list has loaded, so the operator lands directly on a useful
  // view instead of the "Select a conversation" placeholder. Only runs when
  // the user hasn't already picked a thread — never steals selection away.
  useEffect(() => {
    if (isInternalAgent) return
    if (!filteredAgent) return
    if (loading) return
    if (selectedId) return
    if (conversations.length === 0) return
    setSelectedId(conversations[0].id)
  }, [isInternalAgent, filteredAgent, loading, selectedId, conversations])

  return (
    <div className="flex h-full bg-[#f5f5f5] overflow-hidden gap-3 p-3 pl-0">
      {/* ============================================================= */}
      {/* LEFT: Conversation List */}
      {/* ============================================================= */}
      <Panel className="bg-white" resizable defaultWidth={320} minWidth={260} maxWidth={480} storageKey="inbox:list">
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
          // Match the list-row metrics below: same px-3, same py-2.5, same
          // rounded-lg, same gap-3 from icon to label. Keeps the "New chat"
          // affordance and the thread rows aligned on a single grid.
          <div className="px-2 pt-1">
            <button
              onClick={startNewChat}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-sm font-medium text-[#525252] hover:bg-[#f5f5f5] hover:text-[#2e2e2e] transition-colors"
            >
              <PlusCircle size={16} weight="bold" className="flex-shrink-0 text-[#a3a3a3]" />
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
                // Internal chats use the FIRST user message as the stable
                // thread title (ChatGPT-style "name the thread by what you
                // asked first"). Falls back to 'New chat' until the user
                // sends a message. last_message would be unstable — it'd
                // rewrite itself on every new turn.
                const rowTitle = isInternalAgent
                  ? (conv.first_user_message?.content
                      ? capitalizeFirst(truncate(conv.first_user_message.content, 40))
                      : 'New chat')
                  : contactName
                return (
                  <button
                    key={conv.id}
                    onClick={() => setSelectedId(conv.id)}
                    className={`flex w-full items-center gap-3 px-3 py-1.5 rounded-lg text-left transition-colors ${
                      isSelected
                        ? 'bg-[#f0f0f0]'
                        : 'hover:bg-[#f5f5f5]'
                    }`}
                  >
                    {isInternalAgent ? (
                      <CircleDashed
                        size={16}
                        weight="bold"
                        className="flex-shrink-0 text-[#a3a3a3]"
                      />
                    ) : (
                      <ContactAvatar
                        name={contactName}
                        seed={conv.contact?.id || conv.id}
                        size={28}
                        className="flex-shrink-0"
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
          // Loading skeleton that mirrors the real conversation layout
          // so there's no visual pop when `detail` resolves. Two layouts
          // because the underlying chat UI diverges meaningfully:
          //
          //  - Internal-agent chats: title-only header (no contact
          //    avatar, because it's always "You"), and AI replies
          //    render bubble-less ChatGPT-style — so AI rows are
          //    represented as stacked text lines, not a pill bubble.
          //  - Customer-facing chats: avatar + name header, and both
          //    parties have rounded-3xl bubbles with a contact avatar
          //    on the incoming side.
          //
          // Widths, gaps, and shapes match the real render (rounded-3xl,
          // max-w-3xl column, 24px contact avatar on incoming rows).
          <div className="flex flex-1 flex-col">
            {/* Header */}
            <div className="flex h-12 items-center justify-between border-b border-black/[0.04] px-5 flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                {isInternalAgent ? (
                  <Skeleton className="h-4 w-48" />
                ) : (
                  <>
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <Skeleton className="h-4 w-32" />
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-4 rounded-sm" />
                <Skeleton className="h-4 w-4 rounded-sm" />
              </div>
            </div>
            {/* Body */}
            <div className="flex-1 min-h-0 px-5 py-4 overflow-hidden">
              {isInternalAgent ? (
                // Internal: matches the real ChatGPT-style layout —
                // right-aligned user bubbles interleaved with multi-line
                // bubble-less AI replies.
                <div className="mx-auto w-full max-w-3xl space-y-6">
                  {/* User bubble */}
                  <div className="flex justify-end">
                    <Skeleton className="h-8 w-56 rounded-3xl" />
                  </div>
                  {/* AI reply — title + paragraph + short bullet list */}
                  <div className="space-y-2.5">
                    <Skeleton className="h-5 w-48" />
                    <Skeleton className="h-3.5 w-full" />
                    <Skeleton className="h-3.5 w-[92%]" />
                    <Skeleton className="h-3.5 w-[78%]" />
                    <div className="h-1" />
                    <Skeleton className="h-3.5 w-[70%]" />
                    <Skeleton className="h-3.5 w-[60%]" />
                  </div>
                  {/* Second user bubble */}
                  <div className="flex justify-end">
                    <Skeleton className="h-8 w-40 rounded-3xl" />
                  </div>
                  {/* Second AI reply — shorter */}
                  <div className="space-y-2.5">
                    <Skeleton className="h-3.5 w-full" />
                    <Skeleton className="h-3.5 w-[85%]" />
                  </div>
                </div>
              ) : (
                // Customer-facing: alternating bubbles, 24px avatar
                // on incoming rows, max-w-[75%] to match real bubbles.
                <div className="space-y-3">
                  <div className="flex items-end gap-2 justify-start">
                    <Skeleton className="h-6 w-6 rounded-full flex-shrink-0" />
                    <Skeleton className="h-9 w-[55%] rounded-3xl" />
                  </div>
                  <div className="flex justify-end">
                    <Skeleton className="h-9 w-[45%] rounded-3xl" />
                  </div>
                  <div className="flex items-end gap-2 justify-start">
                    <Skeleton className="h-6 w-6 rounded-full flex-shrink-0" />
                    <Skeleton className="h-14 w-[65%] rounded-3xl" />
                  </div>
                  <div className="flex justify-end">
                    <Skeleton className="h-9 w-[50%] rounded-3xl" />
                  </div>
                </div>
              )}
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
            onSend={(ctx) => { void handleInternalChatSend({ message: ctx.text, attachments: ctx.attachments, kbReferenceIds: ctx.kbReferenceIds }) }}
            sending={sending}
            model={composerModel!}
          />
        ) : detail ? (
          <>
            {/* Header */}
            <div className="flex h-12 items-center justify-between border-b border-black/[0.04] px-5 flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                {isInternalAgent ? (
                  // Internal chat: the contact is always "You" (the logged-in
                  // team member), which is useless chrome. Show the thread
                  // title instead — derived from the first user message so it
                  // matches the sidebar row label.
                  (() => {
                    const firstUser = detail.messages.find(m => m.role === 'user')
                    const firstUserText = typeof firstUser?.content === 'string'
                      ? firstUser.content
                      : ''
                    const title = firstUserText
                      ? capitalizeFirst(truncate(firstUserText, 60))
                      : 'New chat'
                    return (
                      <span className="text-[15px] font-semibold text-[#2e2e2e] truncate">{title}</span>
                    )
                  })()
                ) : (
                  <>
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
                  </>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggleStar(detail.id)}
                  className="p-1.5 rounded hover:bg-[#f5f5f5]"
                  title={starred.has(detail.id) ? 'Unstar conversation' : 'Star conversation'}
                  aria-label={starred.has(detail.id) ? 'Unstar conversation' : 'Star conversation'}
                >
                  <Star size={16} weight={starred.has(detail.id) ? 'fill' : 'bold'} className={starred.has(detail.id) ? 'text-yellow-500' : 'text-[#737373]'} />
                </button>
                {/* Status dropdown (Active/Waiting/Resolved/Escalated)
                    intentionally hidden — pending a rethink of the
                    conversation lifecycle. */}
                <button
                  className="p-1.5 rounded hover:bg-[#f5f5f5]"
                  title="More"
                  aria-label="More actions"
                >
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
              {/* Message column — aligned to the same max-width as the
                  composer below so user/AI content flow in one consistent
                  column. Internal chats pin to max-w-3xl (matches the
                  wrapper around <AiComposer>); customer-facing chats let
                  both span full width, since the reply composer is
                  deliberately unwrapped to fill the panel. */}
              <div className={isInternalAgent ? 'mx-auto w-full max-w-3xl space-y-3' : 'space-y-3'}>
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
                        {/* Internal chats render AI replies bubble-less AND
                            avatar-less — the message stands on its own (ChatGPT
                            style), since there's only ever one agent in view
                            and the panel already shows its name at the top. */}
                        {!isOutgoing && !isInternalAgent && (
                          <ContactAvatar
                            name={detail.contact?.name || detail.contact?.phone || detail.contact?.email || ''}
                            seed={detail.contact?.id || detail.contact?.name || ''}
                            size={24}
                            className={`flex-shrink-0 ${showAvatar ? '' : 'invisible'}`}
                          />
                        )}
                        {/* Internal AI replies span the full column width
                            (ChatGPT-style) — they have no bubble so the
                            text benefits from the extra horizontal space
                            for headings, bullets, and tables. User
                            messages + customer-facing bubbles still
                            cap at 75% to read as chat bubbles. */}
                        <div className={`${isInternalAgent && !isOutgoing ? 'w-full' : 'max-w-[75%]'} flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                          <div
                            className={
                              // Internal agent AI replies render bubble-less
                              // (ChatGPT-style): just text on the panel, no
                              // background or ring. User-sent messages keep
                              // the bubble so the turn direction is obvious.
                              // Customer-facing chats keep bubbles on both
                              // sides since there are two real parties.
                              isInternalAgent && !isOutgoing
                                ? 'px-1 py-1 text-[14px] leading-relaxed text-[#2e2e2e]'
                                : `rounded-3xl px-3.5 py-2 text-[14px] leading-relaxed ${
                                    isOutgoing
                                      ? 'bg-[#f7f7f7] text-[#2e2e2e]'
                                      : 'bg-white text-[#2e2e2e] ring-1 ring-black/[0.04]'
                                  }`
                            }
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
                                    {/* Streaming assistant bubble: split the
                                        accumulated tokens into (a) the
                                        <think>...</think> trace — rendered as
                                        a subtle collapsible "Thinking" block
                                        with shimmer while still open — and
                                        (b) the visible response — rendered
                                        char-by-char via TextEffect so tokens
                                        fade in progressively. Once the stream
                                        marks done (metadata.streaming=false),
                                        the bubble re-renders as Markdown for
                                        full rich formatting. */}
                                    {((msg.metadata as { streaming?: boolean } | null | undefined)?.streaming) ? (() => {
                                      const raw = typeof msg.content === 'string' ? msg.content : ''
                                      const { thinking, visible, thinkingOpen } = splitThinking(raw)
                                      const hasAny = thinking.length > 0 || visible.length > 0
                                      return (
                                        <div className="flex flex-col gap-2">
                                          {/* Shimmer "Generating..." placeholder — shown only while no tokens have arrived yet. */}
                                          {!hasAny && (
                                            <TextShimmerWave
                                              className="[--base-color:#a3a3a3] [--base-gradient-color:#2e2e2e] text-[14px] font-medium"
                                              duration={1}
                                              spread={1}
                                              zDistance={1}
                                              scaleDistance={1.05}
                                              rotateYDistance={10}
                                            >
                                              Thinking...
                                            </TextShimmerWave>
                                          )}
                                          {/* Chain-of-thought: model's own <think> block. Italic, muted,
                                              with a shimmer label while still streaming. */}
                                          {thinking && (
                                            <details open={thinkingOpen} className="group/think">
                                              <summary className="cursor-pointer list-none select-none">
                                                {thinkingOpen ? (
                                                  <TextShimmerWave
                                                    as="span"
                                                    className="[--base-color:#a3a3a3] [--base-gradient-color:#2e2e2e] text-[12px] font-medium"
                                                    duration={1}
                                                    spread={1}
                                                    zDistance={1}
                                                    scaleDistance={1.05}
                                                    rotateYDistance={10}
                                                  >
                                                    Thinking...
                                                  </TextShimmerWave>
                                                ) : (
                                                  <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[#737373] hover:text-[#2e2e2e] transition-colors">
                                                    Thought for a moment
                                                    <ChevronDown size={12} strokeWidth={2.25} className="transition-transform group-open/think:hidden" />
                                                    <ChevronUp size={12} strokeWidth={2.25} className="hidden transition-transform group-open/think:inline" />
                                                  </span>
                                                )}
                                              </summary>
                                              <div className="mt-1.5 border-l-2 border-black/[0.06] pl-3 text-[13px] leading-[1.55] text-[#737373] whitespace-pre-wrap">
                                                {thinking}
                                              </div>
                                            </details>
                                          )}
                                          {/* Visible response tokens. */}
                                          {visible && (
                                            <TextEffect
                                              as="div"
                                              per="char"
                                              preset="fade"
                                              speedReveal={3.5}
                                              className="text-[14px] leading-[1.6] text-[#2e2e2e] whitespace-pre-wrap"
                                            >
                                              {capitalizeFirst(visible)}
                                            </TextEffect>
                                          )}
                                        </div>
                                      )
                                    })() : msg.content && (() => {
                                      const raw = typeof msg.content === 'string' ? msg.content : ''
                                      const { thinking, visible } = splitThinking(raw)
                                      const renderedBody = typeof msg.content === 'string' ? capitalizeFirst(visible) : msg.content
                                      // Structured-output path. When the pipeline
                                      // saved metadata.structured (website channel,
                                      // synthesis succeeded), render the typed
                                      // Block[] via the deterministic renderer so
                                      // format drift is impossible. The raw markdown
                                      // in msg.content stays as a fallback for old
                                      // rows, non-website channels, and synthesis
                                      // failures — it's what drives this same
                                      // Markdown block below.
                                      const rawStructured = (msg.metadata as { structured?: unknown } | null | undefined)?.structured
                                      const structuredReply = rawStructured
                                        ? parseStructuredReply(JSON.stringify(rawStructured))
                                        : null
                                      if (structuredReply) {
                                        return (
                                          <div className="flex flex-col gap-2">
                                            {thinking && (
                                              <details className="group/think">
                                                <summary className="cursor-pointer list-none select-none inline-flex items-center gap-1 text-[12px] font-medium text-[#737373] hover:text-[#2e2e2e] transition-colors">
                                                  Thought for a moment
                                                  <ChevronDown size={12} strokeWidth={2.25} className="transition-transform group-open/think:hidden" />
                                                  <ChevronUp size={12} strokeWidth={2.25} className="hidden transition-transform group-open/think:inline" />
                                                </summary>
                                                <div className="mt-1.5 border-l-2 border-black/[0.06] pl-3 text-[13px] leading-[1.55] text-[#737373] whitespace-pre-wrap">
                                                  {thinking}
                                                </div>
                                              </details>
                                            )}
                                            <StructuredReply reply={structuredReply} />
                                          </div>
                                        )
                                      }
                                      return (
                                        <div className="flex flex-col gap-2">
                                          {thinking && (
                                            <details className="group/think">
                                              <summary className="cursor-pointer list-none select-none inline-flex items-center gap-1 text-[12px] font-medium text-[#737373] hover:text-[#2e2e2e] transition-colors">
                                                Thought for a moment
                                                <ChevronDown size={12} strokeWidth={2.25} className="transition-transform group-open/think:hidden" />
                                                <ChevronUp size={12} strokeWidth={2.25} className="hidden transition-transform group-open/think:inline" />
                                              </summary>
                                              <div className="mt-1.5 border-l-2 border-black/[0.06] pl-3 text-[13px] leading-[1.55] text-[#737373] whitespace-pre-wrap">
                                                {thinking}
                                              </div>
                                            </details>
                                          )}
                                          <Markdown
                                            className={[
                                          'prose prose-sm max-w-none',
                                          '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
                                          // Paragraphs — generous line-height, real gap between
                                          // paragraphs so stacked content doesn't feel compressed.
                                          'prose-p:my-4 prose-p:text-[14px] prose-p:leading-[1.7]',
                                          // Lists — disc/decimal markers, clear indent, real gap
                                          // between items.
                                          'prose-ul:my-4 prose-ul:list-disc prose-ul:pl-6',
                                          'prose-ol:my-4 prose-ol:list-decimal prose-ol:pl-6',
                                          'prose-li:my-3 prose-li:pl-1 prose-li:text-[14px] prose-li:leading-[1.7] prose-li:marker:text-[#a3a3a3]',
                                          // Headings — clear top margin so the description that
                                          // follows really sits BELOW the heading, not tight against
                                          // it. Extra mt on h2/h3 opens up the section break.
                                          'prose-headings:font-semibold prose-headings:text-[#2e2e2e] prose-headings:tracking-tight',
                                          'prose-h1:text-[22px] prose-h1:mt-0 prose-h1:mb-5 prose-h1:leading-[1.25]',
                                          'prose-h2:text-[17px] prose-h2:mt-7 prose-h2:mb-3 prose-h2:leading-[1.3]',
                                          'prose-h3:text-[15px] prose-h3:mt-5 prose-h3:mb-2',
                                          'prose-h4:text-[14px] prose-h4:mt-4 prose-h4:mb-1.5',
                                          // Bold — primary text, same tone as the body so it reads as
                                          // emphasis instead of a colored accent.
                                          'prose-strong:text-[#2e2e2e] prose-strong:font-semibold',
                                          // Blockquote
                                          'prose-blockquote:border-l-2 prose-blockquote:border-black/10 prose-blockquote:pl-3 prose-blockquote:text-[#525252] prose-blockquote:not-italic prose-blockquote:my-3',
                                          // Inline code + code blocks
                                          'prose-code:text-[#2e2e2e] prose-code:bg-[#f3f3f3] prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[13px] prose-code:before:content-none prose-code:after:content-none',
                                          'prose-pre:my-3 prose-pre:bg-[#f7f7f7] prose-pre:border prose-pre:border-black/[0.04] prose-pre:rounded-lg prose-pre:text-[13px]',
                                          // Links
                                          'prose-a:text-[#2e2e2e] prose-a:underline prose-a:decoration-[#a3a3a3] hover:prose-a:decoration-[#2e2e2e]',
                                          // HR — prompt tells the model not to emit these, but when
                                          // a user forces markdown with ---, give it real breathing
                                          // room on both sides.
                                          'prose-hr:my-6 prose-hr:border-black/[0.04]',
                                          // Tables
                                          'prose-table:my-3 prose-table:text-[13px]',
                                          'prose-th:font-semibold prose-th:text-[#2e2e2e] prose-th:border-b prose-th:border-black/[0.06] prose-th:px-2 prose-th:py-1.5 prose-th:text-left',
                                          'prose-td:px-2 prose-td:py-1.5 prose-td:border-b prose-td:border-black/[0.04]',
                                        ].join(' ')}
                                          >
                                            {renderedBody}
                                          </Markdown>
                                        </div>
                                      )
                                    })()}
                                  </>
                                )
                              })()}
                            </AiWidgetProvider>
                            {/* Source citations — clickable chips for docs
                                the agent pulled in (KB deep-link) and URLs
                                it visited (web_search / deep_research). KB
                                chips first, then web. Only shown for AI
                                replies that actually cited something. */}
                            {isAI && (() => {
                              const raw = (msg.metadata as { sources?: MessageSource[] } | null | undefined)?.sources
                              if (!raw || raw.length === 0) return null
                              // Client-side relevance filter so OLD messages
                              // (saved before the server-side filter was
                              // added) also get clean chips, and so future
                              // threshold tweaks retroactively apply.
                              // Mirrors buildMessageSources in the pipeline.
                              const sources = filterRelevantSources(raw)
                              if (sources.length === 0) return null
                              return (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  <span className="text-[11px] text-[#a3a3a3] self-center mr-1">Sources</span>
                                  {sources.map((src, i) => {
                                    if (src.kind === 'web') {
                                      // Web result — external link, favicon,
                                      // hostname as label. URL itself is the
                                      // stable dedupe key.
                                      return (
                                        <Source key={`web-${src.url}-${i}`} href={src.url}>
                                          <SourceTrigger showFavicon label={src.title || hostOfUrl(src.url)} />
                                          <SourceContent title={src.title || hostOfUrl(src.url)} description={src.snippet} />
                                        </Source>
                                      )
                                    }
                                    // KB chunk — deep-link into the KB viewer
                                    // with the right doc preselected.
                                    return (
                                      <Source
                                        key={src.chunk_id}
                                        href={`/knowledge?kb=${src.kb_id}&doc=${src.document_id}`}
                                        icon={<DocumentTypeIcon name={src.document_name} size={12} />}
                                      >
                                        <SourceTrigger label={src.document_name} />
                                        <SourceContent
                                          title={src.document_name}
                                          description={src.snippet}
                                        />
                                      </Source>
                                    )
                                  })}
                                </div>
                              )
                            })()}
                            {/* Timestamp + delivery check: customer-facing
                                only. Internal chats (team-user talking to
                                their own agent) don't benefit from "08:42
                                pm ✓" chrome — it's the user's own private
                                thread, no one needs to know when they hit
                                send. */}
                            {!isInternalAgent && (
                              <div className={`mt-1 flex items-center gap-1 text-[10px] text-[#a3a3a3] leading-none select-none ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                                <span>{formatTimestamp(msg.created_at)}</span>
                                {isOutgoing && <Check size={10} weight="bold" className="text-[#3b82f6]" />}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
                {/* Typing / waiting indicator: only show the animated dots
                    when sending has started but the optimistic assistant
                    bubble hasn't been mounted yet. Once the bubble exists
                    (even empty), its internal TextShimmerWave "Thinking..."
                    carries the waiting state — showing both would duplicate. */}
                {sending && isInternalAgent && (() => {
                  const lastMsg = detail.messages[detail.messages.length - 1]
                  const hasStreamingBubble =
                    lastMsg?.role === 'assistant' &&
                    ((lastMsg.metadata as { streaming?: boolean } | null | undefined)?.streaming)
                  if (hasStreamingBubble) return null
                  if (lastMsg?.role === 'assistant') return null
                  return (
                    <div className="flex items-end gap-2 justify-start">
                      <div className="px-1 py-1">
                        <Loader variant="typing" size="sm" />
                      </div>
                    </div>
                  )
                })()}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            {/* Composer — shared <AiComposer> used by every chat
                surface. Internal chats get a model picker; customer
                chats don't (operators shouldn't swap the customer's
                agent mid-reply). Internal composer is max-width'd and
                centered (ChatGPT-style) so it aligns with the message
                column and doesn't stretch across wide screens. */}
            <div className="bg-white px-4 pb-4 pt-2 flex-shrink-0">
              <div className={isInternalAgent ? 'mx-auto w-full max-w-3xl' : ''}>
              <AiComposer
                value={replyText}
                onChange={setReplyText}
                onSubmit={(ctx) => {
                  if (isInternalAgent) {
                    void handleInternalChatSend({ message: ctx.text, attachments: ctx.attachments, kbReferenceIds: ctx.kbReferenceIds })
                  } else {
                    // Customer-facing reply: attachments now wired. Reply
                    // route persists them on the message and dispatches to
                    // the platform (WhatsApp/Messenger) as media sends.
                    // Customer-facing channels (WhatsApp/Messenger) don't
                    // forward KB references — the operator can paste context
                    // into the message directly if needed.
                    void handleSendReply({ message: ctx.text, attachments: ctx.attachments })
                  }
                }}
                sending={sending}
                model={composerModel}
                variant="inline"
                placeholder={isInternalAgent ? 'Ask anything' : `Reply on ${channelLabel(detail.channel)}`}
              />
              </div>
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
