"use client"

import { useState, useEffect, useRef, use, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Panel } from "@/components/ui/panel"
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message"
import { Markdown } from "@/components/ui/markdown"
import { ChainOfThought, ChainOfThoughtStep, ChainOfThoughtTrigger, ChainOfThoughtContent, ChainOfThoughtItem } from "@/components/ui/chain-of-thought"
import { AiWidgetProvider } from "@/components/ui/ai-widget"
import { PromptInput, PromptInputTextarea, PromptInputActions, PromptInputAction } from "@/components/ui/prompt-input"
import { Loader } from "@/components/ui/loader"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { avatarColor, avatarInitial, cn } from "@/lib/utils"
import { Slider } from "@/components/ui/slider"
import { useSliderWithInput } from "@/hooks/use-slider-with-input"
import { ArrowUp, ArrowLeft, Copy, Check, Trash2, Pencil, Phone, Mail, Globe, Upload, FileText, X, Plus, Camera } from "lucide-react"
import { ChannelIcon } from "@/components/ui/channel-icon"
import { AgentIntegrationsTab } from "@/components/app/agent-integrations"

interface Agent {
  id: string; name: string; description: string; system_prompt: string
  avatar_url: string | null
  model_provider: string; model_name: string; voice_provider: string
  voice_id: string; language: string; supported_languages: string[]
  temperature: number; max_tokens: number; greeting_message: string
  fallback_message: string; escalation_enabled: boolean; escalation_email: string
  status: string; created_at: string
  settings?: Record<string, unknown>
}

interface AgentChannel {
  id: string; agent_id: string; channel_type: string
  channel_config: Record<string, unknown>; is_active: boolean
}

interface KnowledgeBase {
  id: string; name: string; description: string | null; agent_id: string | null
  kb_documents?: KbDocument[]
}

interface KbDocument {
  id: string; name: string; status: string; file_type: string | null
  char_count: number; created_at: string
}

/** Tool-call step in the agent's chain of thought, as streamed by the pipeline. */
export type ThoughtStep =
  | { kind: "thinking"; id: string; trigger: string; items: string[] }
  | { kind: "tool_call"; id: string; tool: string; args: Record<string, unknown>; status: "running" }
  | { kind: "tool_done"; id: string; tool: string; resultPreview: string }

interface ChatMsg {
  role: "user" | "assistant"
  content: string
  /** Chain-of-thought steps that accumulated during tool calling. */
  thoughts?: ThoughtStep[]
}

const modelLabels: Record<string, string> = { sarvam: "Sarvam 30B", openai: "GPT-4o", anthropic: "Claude 3.5", gemini: "Gemini Pro" }
const statusColors: Record<string, string> = { active: "bg-green-50 text-green-700", draft: "bg-gray-100 text-gray-600", paused: "bg-yellow-50 text-yellow-700" }

const channelMeta: Record<string, { label: string; icon: React.ReactNode; description: string; connectedLabel: (config: Record<string, unknown>) => string }> = {
  website: { label: "Website", icon: <ChannelIcon kind="website" size={18} />, description: "Chat widget on your site", connectedLabel: () => "Embed code ready" },
  whatsapp: { label: "WhatsApp", icon: <ChannelIcon kind="whatsapp" size={18} />, description: "Receive messages on WhatsApp", connectedLabel: (c) => c.phone_number ? `${c.phone_number}` : "Connected" },
  facebook: { label: "Messenger", icon: <ChannelIcon kind="messenger" size={18} />, description: "Facebook page messages", connectedLabel: (c) => c.page_name ? `${c.page_name}` : "Connected" },
  phone: { label: "Phone", icon: <ChannelIcon kind="phone" size={18} />, description: "Receive voice calls", connectedLabel: (c) => c.twilio_phone_number ? `${c.twilio_phone_number}` : "Connected" },
}

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[1fr_1.2fr] gap-6 py-4 border-b border-black/[0.04] last:border-0">
      <div>
        <div className="text-sm font-medium text-[#2e2e2e]">{label}</div>
        {description && <p className="text-xs text-[#737373] mt-1 leading-relaxed">{description}</p>}
      </div>
      <div>{children}</div>
    </div>
  )
}

// Defaults used when this page is rendered at /agents/new (create mode).
// Keep in sync with what /api/agents POST treats as unset.
const NEW_AGENT_DEFAULTS: Partial<Agent> = {
  name: "",
  description: "",
  status: "active",
  system_prompt: "",
  model_provider: "sarvam",
  model_name: "sarvam-m",
  voice_provider: "none",
  voice_id: "",
  language: "en",
  supported_languages: ["en"],
  temperature: 0.7,
  greeting_message: "",
  fallback_message: "I'm not sure about that. Let me connect you with someone who can help.",
  escalation_enabled: true,
  escalation_email: "",
  avatar_url: null,
  settings: { is_customer_facing: true, show_test_in_inbox: false },
}

export default function AgentViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  // /agents/new is routed to this same component via the dynamic segment.
  // In create mode we skip the fetch, seed defaults, disable Channels/KB
  // tabs, swap Save→Create, and redirect to /agents/<newId> on success.
  const isNew = id === "new"
  const [agent, setAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(!isNew)
  const [editData, setEditData] = useState<Partial<Agent>>(isNew ? NEW_AGENT_DEFAULTS : {})
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [activeTab, setActiveTab] = useState("agent")
  const [copied, setCopied] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Channels state
  const [channels, setChannels] = useState<AgentChannel[]>([])
  const [channelSaving, setChannelSaving] = useState<string | null>(null)
  const [setupChannel, setSetupChannel] = useState<string | null>(null)
  const [setupStep, setSetupStep] = useState(0)
  const [setupData, setSetupData] = useState<Record<string, string>>({})
  const [fbPages, setFbPages] = useState<{ id: string; name: string; access_token: string }[]>([])
  const [waNumbers, setWaNumbers] = useState<{ phone_number_id: string; display_phone_number: string; verified_name: string; waba_id: string }[]>([])
  const [fbConnecting, setFbConnecting] = useState(false)

  // Knowledge base state
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [linkedKb, setLinkedKb] = useState<KnowledgeBase | null>(null)
  const [kbLoading, setKbLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [showKbPicker, setShowKbPicker] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)

  const loadChannels = useCallback(() => {
    fetch(`/api/channels?agentId=${id}`).then(r => r.json()).then(data => {
      if (Array.isArray(data)) setChannels(data)
    })
  }, [id])

  const loadKnowledgeBases = useCallback(() => {
    setKbLoading(true)
    fetch("/api/knowledge-base").then(r => r.json()).then((data: KnowledgeBase[]) => {
      if (Array.isArray(data)) {
        setKnowledgeBases(data)
        const linked = data.find(kb => kb.agent_id === id)
        setLinkedKb(linked || null)
      }
      setKbLoading(false)
    })
  }, [id])

  useEffect(() => {
    if (isNew) return // create mode: no record to fetch yet
    fetch(`/api/agents/${id}`).then(r => r.json()).then(data => {
      setAgent(data)
      setEditData(data)
      // Chat starts empty — greeting only used for phone calls
      setLoading(false)
    })
    loadChannels()
    loadKnowledgeBases()
  }, [id, isNew, loadChannels, loadKnowledgeBases])

  // Auto-load the current user's prior test chat with this agent so
  // history persists across sessions instead of starting fresh each
  // time the Test Chat panel opens. The /api/chat/history?agentId
  // endpoint scopes by the authenticated user, so two operators see
  // separate threads. Skipped in create mode — no agent id yet.
  useEffect(() => {
    if (isNew) return
    let cancelled = false
    fetch(`/api/chat/history?agentId=${id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data) return
        if (data.conversationId) setConversationId(data.conversationId)
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          type HistoryMsg = { role: 'user' | 'assistant' | string; content: string }
          setMessages(
            (data.messages as HistoryMsg[])
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
          )
        }
      })
      .catch(() => { /* fresh start on failure — non-critical */ })
    return () => { cancelled = true }
  }, [id, isNew])

  async function handleCreate() {
    if (!editData.name?.trim()) return
    setSaving(true)
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editData),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to create agent')
      }
      const created = (await res.json()) as Agent
      // Refresh the sidebar list so the new agent row appears in the
      // right bucket (customer-facing vs internal) immediately.
      window.dispatchEvent(new CustomEvent('refresh-agents'))
      // Replace the URL so the back button doesn't bounce to /agents/new.
      router.replace(`/agents/${created.id}`)
    } catch (err) {
      console.error('[agents/new] create failed:', err)
      setSaving(false)
    }
  }

  async function handleSave() {
    // Optimistic: update UI + sidebar immediately
    setAgent(prev => prev ? { ...prev, ...editData } as Agent : prev)
    window.dispatchEvent(new CustomEvent("agent-updated", { detail: { id, name: editData.name, status: editData.status, avatar_url: editData.avatar_url } }))

    setSaving(true)
    const res = await fetch(`/api/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editData) })
    if (res.ok) { const updated = await res.json(); setAgent(updated); window.dispatchEvent(new CustomEvent("agent-updated", { detail: { id, name: updated.name, status: updated.status, avatar_url: updated.avatar_url } })) }
    setSaving(false)
  }

  async function handleDelete() {
    // Optimistic removal from sidebar
    window.dispatchEvent(new CustomEvent("refresh-agents"))
    await fetch(`/api/agents/${id}`, { method: "DELETE" })
    router.push("/dashboard")
  }

  async function sendChat(override?: { message: string }) {
    const incoming = override?.message ?? chatInput.trim()
    if (!incoming || chatLoading) return
    const msg = incoming
    if (!override) setChatInput("")
    setMessages(prev => [...prev, { role: "user", content: msg }])
    setChatLoading(true)
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: id, message: msg, conversationId, stream: true, isTest: true, visitorId: `test-${id}`, visitorName: "Test" }),
      })
      if (!res.body) throw new Error("No stream")
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantMsg = ""
      const thoughts: ThoughtStep[] = []
      setMessages(prev => [...prev, { role: "assistant", content: "", thoughts: [] }])
      setChatLoading(false)

      const updateLastAssistant = (patch: (prev: ChatMsg) => ChatMsg) => {
        setMessages(prev => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          if (!last || last.role !== "assistant") return prev
          updated[updated.length - 1] = patch(last)
          return updated
        })
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue
          const payload = line.slice(6).trim()
          if (payload === "[DONE]") break
          try {
            const parsed = JSON.parse(payload)
            if (parsed.type === "token") {
              assistantMsg += parsed.data
              updateLastAssistant(prev => ({ ...prev, content: assistantMsg }))
            } else if (parsed.type === "thought") {
              // Collapse by id: 'tool_done' upgrades the matching
              // 'tool_call' step in place instead of appending a new row.
              const ev = JSON.parse(parsed.data) as ThoughtStep
              if (ev.kind === "tool_done") {
                const idx = thoughts.findIndex(t => t.kind === "tool_call" && t.id === ev.id)
                if (idx >= 0) thoughts[idx] = ev
                else thoughts.push(ev)
              } else {
                thoughts.push(ev)
              }
              updateLastAssistant(prev => ({ ...prev, thoughts: [...thoughts] }))
            } else if (parsed.type === "meta") {
              const meta = JSON.parse(parsed.data)
              if (meta.conversationId) setConversationId(meta.conversationId)
            }
          } catch { /* skip malformed lines */ }
        }
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Failed to get response" }])
      setChatLoading(false)
    }
  }

  // Scroll the test-chat viewport to the latest message. Uses a
  // bottom-sentinel ref + scrollIntoView — base-ui's ScrollArea Root
  // is not itself scrollable (the inner Viewport is), so scrollTo on
  // the Root would no-op. scrollIntoView walks up to whichever
  // ancestor actually scrolls. requestAnimationFrame waits for React
  // to flush the new message into the DOM before we measure.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    })
    return () => cancelAnimationFrame(raf)
  }, [messages, chatLoading])

  async function toggleChannel(channelType: string, active: boolean) {
    if (active && channelType !== "website") {
      const existing = channels.find(c => c.channel_type === channelType)
      const config = existing?.channel_config as Record<string, string> | undefined
      if (!config || !isChannelConfigured(channelType, config)) {
        if (channelType === "facebook" || channelType === "whatsapp") {
          connectWithFacebook(channelType)
        } else {
          setSetupChannel(channelType)
          setSetupStep(0)
          setSetupData({})
        }
        return
      }
    }
    setChannelSaving(channelType)
    const existing = channels.find(c => c.channel_type === channelType)
    await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, channelType, config: existing?.channel_config || {}, isActive: active }),
    })
    loadChannels()
    setChannelSaving(null)
  }

  function isChannelConfigured(type: string, config: Record<string, unknown>): boolean {
    if (type === "website") return true
    if (type === "whatsapp") return !!(config.phone_number_id)
    if (type === "facebook") return !!(config.page_id && config.page_access_token)
    if (type === "phone") return !!(config.twilio_phone_number)
    return false
  }

  function connectWithFacebook(channelType: "facebook" | "whatsapp") {
    setFbConnecting(true)
    setSetupChannel(channelType)
    setSetupStep(0)
    setFbPages([])
    setWaNumbers([])

    const appId = "3857136404420755"
    const scopes = channelType === "facebook"
      ? "pages_messaging,pages_show_list,pages_manage_metadata"
      : "whatsapp_business_management,whatsapp_business_messaging,business_management"

    // Load Facebook SDK and trigger login
    const script = document.getElementById("fb-sdk") || document.createElement("script")
    if (!document.getElementById("fb-sdk")) {
      script.id = "fb-sdk"
      ;(script as HTMLScriptElement).src = "https://connect.facebook.net/en_US/sdk.js"
      script.setAttribute("crossorigin", "anonymous")
      document.body.appendChild(script)
    }

    const doLogin = () => {
      const FB = (window as unknown as Record<string, unknown>).FB as {
        init: (opts: Record<string, unknown>) => void
        login: (cb: (res: { authResponse?: { accessToken: string } }) => void, opts: Record<string, unknown>) => void
      }
      FB.init({ appId, cookie: true, xfbml: false, version: "v21.0" })
      FB.login((response) => {
        if (response.authResponse?.accessToken) {
          const token = response.authResponse.accessToken
          // Handle async work outside the callback
          fetch("/api/channels/facebook-connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken: token, agentId: id, channelType }),
          })
            .then(res => res.json())
            .then(data => {
              if (channelType === "facebook" && data.pages) {
                setFbPages(data.pages)
                setSetupStep(1)
              } else if (channelType === "whatsapp" && data.phoneNumbers) {
                setWaNumbers(data.phoneNumbers)
                setSetupStep(1)
              } else {
                alert(data.error || "No accounts found. Make sure you have a Facebook Page or WhatsApp Business number.")
                setSetupChannel(null)
              }
              setFbConnecting(false)
            })
            .catch(() => { setSetupChannel(null); setFbConnecting(false) })
        } else {
          setSetupChannel(null)
          setFbConnecting(false)
        }
      }, { scope: scopes, auth_type: "rerequest" })
    }

    if ((window as unknown as Record<string, unknown>).FB) {
      doLogin()
    } else {
      script.addEventListener("load", doLogin)
    }
  }

  async function selectFacebookPage(page: { id: string; name: string; access_token: string }) {
    setChannelSaving("facebook")
    await fetch("/api/channels/save-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: id,
        channelType: "facebook",
        config: { page_id: page.id, page_name: page.name, page_access_token: page.access_token },
      }),
    })
    loadChannels()
    setChannelSaving(null)
    setSetupChannel(null)
    setFbPages([])
  }

  async function selectWhatsAppNumber(num: { phone_number_id: string; display_phone_number: string; verified_name: string; waba_id: string }) {
    setChannelSaving("whatsapp")
    await fetch("/api/channels/save-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: id,
        channelType: "whatsapp",
        config: { phone_number_id: num.phone_number_id, phone_number: num.display_phone_number, waba_id: num.waba_id, verified_name: num.verified_name },
      }),
    })
    loadChannels()
    setChannelSaving(null)
    setSetupChannel(null)
    setWaNumbers([])
  }

  async function completeSetup() {
    if (!setupChannel) return
    setChannelSaving(setupChannel)
    await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, channelType: setupChannel, config: setupData, isActive: true }),
    })
    loadChannels()
    setChannelSaving(null)
    setSetupChannel(null)
    setSetupStep(0)
  }

  async function createAndLinkKb() {
    if (!agent) return
    setKbLoading(true)
    const res = await fetch("/api/knowledge-base", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${agent.name} KB`, agent_id: id }),
    })
    if (res.ok) loadKnowledgeBases()
    setKbLoading(false)
  }

  async function linkExistingKb(kbId: string) {
    setKbLoading(true)
    await fetch(`/api/knowledge-base/${kbId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: id }),
    })
    loadKnowledgeBases()
    setShowKbPicker(false)
    setKbLoading(false)
  }

  async function unlinkKb() {
    if (!linkedKb) return
    setKbLoading(true)
    await fetch(`/api/knowledge-base/${linkedKb.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: null }),
    })
    loadKnowledgeBases()
    setKbLoading(false)
  }

  async function uploadAvatar(file: File) {
    // Optimistic: show local preview immediately
    const localUrl = URL.createObjectURL(file)
    setAgent(prev => prev ? { ...prev, avatar_url: localUrl } : prev)
    setEditData(prev => ({ ...prev, avatar_url: localUrl }))
    window.dispatchEvent(new CustomEvent("agent-updated", { detail: { id, avatar_url: localUrl } }))

    setUploadingAvatar(true)
    const formData = new FormData()
    formData.append("file", file)
    try {
      const res = await fetch(`/api/agents/${id}/avatar`, { method: "POST", body: formData })
      const data = await res.json()
      if (data.avatar_url) {
        // Replace blob URL with real URL
        setAgent(prev => prev ? { ...prev, avatar_url: data.avatar_url } : prev)
        setEditData(prev => ({ ...prev, avatar_url: data.avatar_url }))
        window.dispatchEvent(new CustomEvent("agent-updated", { detail: { id, avatar_url: data.avatar_url } }))
      }
    } finally {
      setUploadingAvatar(false)
      URL.revokeObjectURL(localUrl)
    }
  }

  async function removeAvatar() {
    // Optimistic
    setAgent(prev => prev ? { ...prev, avatar_url: null } : prev)
    setEditData(prev => ({ ...prev, avatar_url: null }))
    window.dispatchEvent(new CustomEvent("agent-updated", { detail: { id, avatar_url: null } }))

    await fetch(`/api/agents/${id}/avatar`, { method: "DELETE" })
  }

  async function uploadDocument(file: File) {
    if (!linkedKb) return
    setUploading(true)
    const formData = new FormData()
    formData.append("file", file)
    await fetch(`/api/knowledge-base/${linkedKb.id}/upload`, { method: "POST", body: formData })
    loadKnowledgeBases()
    setUploading(false)
  }

  async function deleteDocument(docId: string) {
    if (!linkedKb) return
    await fetch(`/api/knowledge-base/${linkedKb.id}/documents/${docId}`, { method: "DELETE" })
    loadKnowledgeBases()
  }

  function copyWidget() {
    navigator.clipboard.writeText(`<script src="${window.location.origin}/widget.js" data-agent-id="${id}"></script>`)
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }

  if (loading) return (
    <div className="flex h-full gap-3 p-3 bg-[#f5f5f5] overflow-hidden">
      <Panel className="flex-1 min-w-0" bodyClassName="overflow-y-auto p-6">
        <div className="max-w-xl mx-auto space-y-5">
          <div className="flex items-start gap-4">
            <Skeleton className="h-14 w-14 rounded-full" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
          {[1, 2, 3, 4].map(i => (
            <Card key={i}>
              <CardHeader className="pb-2"><Skeleton className="h-4 w-32" /></CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
              </CardContent>
            </Card>
          ))}
        </div>
      </Panel>
      <Panel
        resizable
        defaultWidth={400}
        minWidth={320}
        maxWidth={640}
        storageKey="agent:test-chat"
        header={<Skeleton className="h-4 w-20" />}
      >
        <div className="flex-1 p-4 space-y-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-16 rounded-2xl" />
          ))}
        </div>
      </Panel>
    </div>
  )
  if (!isNew && !agent) return <div className="p-6 text-sm text-red-600">Agent not found</div>

  // Avatar seed: real agent id when editing, typed name when creating so
  // the placeholder has some identity before the DB row exists.
  const avatarSeed = isNew ? (editData.name?.trim() || 'new-agent') : (agent?.id ?? id)
  const displayName = isNew
    ? (editData.name?.trim() || '')
    : (agent?.name ?? '')

  return (
    <div className="flex h-full gap-3 p-3 bg-[#f5f5f5] overflow-hidden">
      {/* Left: Agent details */}
      <Panel className="flex-1 min-w-0">
        {/* Header with avatar + name + save */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-black/[0.04] flex-shrink-0">
          <button
            onClick={() => isNew ? router.back() : router.push(`/inbox?agentId=${id}`)}
            className="rounded-md p-1 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#2e2e2e]"
            title={isNew ? "Back" : "Back to conversations"}
          >
            <ArrowLeft size={16} />
          </button>
          <div className="relative group shrink-0">
            <Avatar className="h-9 w-9">
              {!isNew && agent?.avatar_url && <AvatarImage src={agent.avatar_url} alt={agent.name} />}
              {(() => { const c = avatarColor(avatarSeed); return (
                <AvatarFallback className={`text-sm font-semibold ${c.bg} ${c.text}`}>
                  {avatarInitial(displayName) || 'A'}
                </AvatarFallback>
              ) })()}
            </Avatar>
            {!isNew && (
              <>
                <input ref={avatarInputRef} type="file" className="hidden" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e => { if (e.target.files?.[0]) uploadAvatar(e.target.files[0]); e.target.value = "" }} />
                <button onClick={() => avatarInputRef.current?.click()} disabled={uploadingAvatar} className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" title="Upload avatar">
                  {uploadingAvatar ? <Loader variant="circular" size="sm" /> : <Camera size={14} className="text-white" />}
                </button>
              </>
            )}
          </div>
          <span className="text-base font-semibold text-[#2e2e2e] flex-1 truncate">
            {displayName || <span className="text-[#a3a3a3]">New agent</span>}
          </span>
          {isNew ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => router.back()} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={handleCreate} disabled={saving || !editData.name?.trim()}>
                {saving ? "Creating…" : "Create"}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
              <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}><Trash2 size={14} /></Button>
            </>
          )}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-5 border-b border-black/[0.04] flex-shrink-0 overflow-x-auto">
          {[
            { key: "agent", label: "Agent" },
            { key: "model", label: "System Prompt" },
            { key: "channels", label: "Channels" },
            { key: "integrations", label: "Integrations" },
            { key: "knowledge", label: "Knowledge Base" },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
                activeTab === t.key ? "border-[#F4511E] text-[#2e2e2e]" : "border-transparent text-[#737373] hover:text-[#2e2e2e]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto">

            {/* Agent tab */}
            {activeTab === "agent" && (
              <div>
                <Field label="Name" description="The name of your AI agent. Visible to your team.">
                  <Input value={editData.name || ""} onChange={e => setEditData({...editData, name: e.target.value})} />
                </Field>
                <Field label="Description" description="A short summary of what this agent does.">
                  <Textarea value={editData.description || ""} onChange={e => setEditData({...editData, description: e.target.value})} />
                </Field>
                <Field label="Status" description="Only active agents can receive messages.">
                  <Select value={editData.status} onValueChange={v => v && setEditData({...editData, status: v})}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">Draft</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="paused">Paused</SelectItem></SelectContent></Select>
                </Field>
                <Field label="Customer-facing" description="On = talks to your customers. Off = internal use only.">
                  <Switch
                    checked={(editData.settings as Record<string, unknown> | undefined)?.is_customer_facing !== false}
                    onCheckedChange={v => {
                      const isCF = v
                      setEditData({...editData, settings: { ...(editData.settings as object || {}), is_customer_facing: isCF }, escalation_enabled: isCF ? true : editData.escalation_enabled })
                    }}
                  />
                </Field>
                <Field label="Show test chats in conversations" description="Include conversations from this agent's Test Chat panel in the main conversations list. Off by default — keeps the list focused on real customer conversations.">
                  <Switch
                    checked={(editData.settings as Record<string, unknown> | undefined)?.show_test_in_inbox === true}
                    onCheckedChange={v => {
                      setEditData({...editData, settings: { ...(editData.settings as object || {}), show_test_in_inbox: v }})
                    }}
                  />
                </Field>
                {(editData.settings as Record<string, unknown> | undefined)?.is_customer_facing !== false && (
                  <Field label="Escalation email" description="When the AI can't help, conversations are escalated to this email.">
                    <Input type="email" placeholder="support@company.com" value={editData.escalation_email || ""} onChange={e => setEditData({...editData, escalation_email: e.target.value})} />
                  </Field>
                )}
                <Field label="Phone greeting" description="Spoken when someone calls. Chat channels start empty.">
                  <Textarea placeholder="Welcome to Jordon.ai, how may I help you today?" value={editData.greeting_message || ""} onChange={e => setEditData({...editData, greeting_message: e.target.value})} />
                </Field>
                <Field label="Fallback message" description="Shown when the AI fails to generate a response.">
                  <Textarea value={editData.fallback_message || ""} onChange={e => setEditData({...editData, fallback_message: e.target.value})} />
                </Field>

                {/* Models section */}
                <div className="pt-6">
                  <div className="text-sm font-semibold text-[#2e2e2e]">Models</div>
                </div>
                <Field label="AI model" description="The model that powers this agent's responses.">
                  {/* Select value is the model_name so we can offer multiple
                      models per provider (Sonnet vs Opus) under one dropdown.
                      onValueChange derives the provider. */}
                  <Select
                    value={editData.model_name || 'sarvam-m'}
                    onValueChange={v => {
                      if (!v) return
                      const providerFor: Record<string, string> = {
                        'sarvam-m': 'sarvam',
                        'gpt-5.4': 'openai',
                        'claude-sonnet-4-6': 'anthropic',
                        'claude-opus-4-7': 'anthropic',
                        'gemini-pro': 'gemini',
                      }
                      setEditData({ ...editData, model_name: v, model_provider: providerFor[v] || editData.model_provider })
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sarvam-m">Sarvam 30B (Free)</SelectItem>
                      <SelectItem value="gpt-5.4">OpenAI GPT-5.4</SelectItem>
                      <SelectItem value="claude-sonnet-4-6">Claude Sonnet 4.6</SelectItem>
                      <SelectItem value="claude-opus-4-7">Claude Opus 4.7</SelectItem>
                      <SelectItem value="gemini-pro">Gemini Pro</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Voice provider" description="How the agent speaks on phone calls.">
                  <Select value={editData.voice_provider || "none"} onValueChange={v => v && setEditData({...editData, voice_provider: v})}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Twilio Polly (Default)</SelectItem><SelectItem value="elevenlabs">ElevenLabs</SelectItem></SelectContent></Select>
                </Field>
                {editData.voice_provider === "elevenlabs" && (
                  <Field label="Voice" description="Pick a preset or paste a custom ElevenLabs voice ID.">
                    <div className="space-y-2">
                      <Select value={editData.voice_id || ""} onValueChange={v => v && setEditData({...editData, voice_id: v})}>
                        <SelectTrigger><SelectValue placeholder="Select a voice" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="21m00Tcm4TlvDq8ikWAM">Rachel — Calm, Narration</SelectItem>
                          <SelectItem value="EXAVITQu4vr4xnSDxMaL">Sarah — Mature, Reassuring</SelectItem>
                          <SelectItem value="FGY2WhTYpPnrIDTdsKH5">Laura — Enthusiast, Quirky</SelectItem>
                          <SelectItem value="IKne3meq5aSn9XLyUdCD">Charlie — Deep, Confident</SelectItem>
                          <SelectItem value="JBFqnCBsd6RMkjVDRZzb">George — Warm Storyteller</SelectItem>
                          <SelectItem value="TX3LPaxmHKxFdv7VOQHJ">Liam — Energetic Creator</SelectItem>
                          <SelectItem value="Xb7hH8MSUJpSbSDYk0k2">Alice — Clear Educator</SelectItem>
                          <SelectItem value="pFZP5JQG7iQjIQuC4Bku">Lily — Warm, Calm</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input placeholder="Or paste a custom Voice ID" value={editData.voice_id || ""} onChange={e => setEditData({...editData, voice_id: e.target.value})} />
                    </div>
                  </Field>
                )}
                <Field label="Primary language" description="The language the agent primarily speaks in.">
                  <Select value={editData.language || "en"} onValueChange={v => v && setEditData({...editData, language: v})}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["en","hi","ta","te","kn","bn","mr","gu","ml","pa"].map(l => <SelectItem key={l} value={l}>{({en:"English",hi:"Hindi",ta:"Tamil",te:"Telugu",kn:"Kannada",bn:"Bengali",mr:"Marathi",gu:"Gujarati",ml:"Malayalam",pa:"Punjabi"} as Record<string,string>)[l]}</SelectItem>)}</SelectContent></Select>
                </Field>
                <Field label="Temperature" description="Lower = more focused and deterministic. Higher = more creative and varied.">
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Slider
                        className="grow"
                        value={[editData.temperature ?? 0.7]}
                        onValueChange={([v]) => setEditData({...editData, temperature: Math.round(v * 100) / 100})}
                        min={0}
                        max={1}
                        step={0.01}
                      />
                      <Input
                        className="h-8 w-14 px-2 text-center text-sm"
                        type="text"
                        inputMode="decimal"
                        value={editData.temperature ?? 0.7}
                        onChange={e => {
                          const v = parseFloat(e.target.value)
                          if (!isNaN(v) && v >= 0 && v <= 1) setEditData({...editData, temperature: v})
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] text-[#a3a3a3]">
                      <span>Precise</span>
                      <span>Creative</span>
                    </div>
                  </div>
                </Field>
              </div>
            )}

            {/* System Prompt tab */}
            {activeTab === "model" && (
              <div>
                <div className="text-sm font-medium text-[#2e2e2e]">System Prompt</div>
                <p className="text-xs text-[#737373] mt-1 mb-3">Instructions that define how the agent behaves, what it knows, and how it should respond.</p>
                <Textarea value={editData.system_prompt || ""} onChange={e => setEditData({...editData, system_prompt: e.target.value})} className="min-h-[500px] text-sm" />
              </div>
            )}

            {/* Channels tab */}
            {activeTab === "channels" && (
              <div>
                {isNew && (
                  <div className="opacity-60 pointer-events-none select-none mb-4">
                    {Object.entries(channelMeta).map(([type, meta]) => (
                      <div key={type} className="py-4 border-b border-black/[0.04] last:border-0 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-muted text-muted-foreground">{meta.icon}</div>
                          <div>
                            <span className="text-sm font-medium text-[#2e2e2e]">{meta.label}</span>
                            <div className="text-xs text-[#737373]">{meta.description}</div>
                          </div>
                        </div>
                        <Switch checked={false} disabled />
                      </div>
                    ))}
                  </div>
                )}
                {isNew && (
                  <PostCreateNudge
                    title="Connect channels after creating"
                    body="Channels attach to an agent id — tokens, webhooks, and the website embed snippet all need the agent to exist first. Save the agent and you'll land right back on this tab."
                    canCreate={Boolean(editData.name?.trim())}
                    saving={saving}
                    onCreate={handleCreate}
                  />
                )}
                {!isNew && Object.entries(channelMeta).map(([type, meta]) => {
                    const ch = channels.find(c => c.channel_type === type)
                    const isActive = ch?.is_active ?? false
                    const config = (ch?.channel_config || {}) as Record<string, unknown>
                    const configured = isChannelConfigured(type, config)
                    return (
                      <div key={type} className="py-4 border-b border-black/[0.04] last:border-0">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${isActive && configured ? "bg-green-50 text-green-700" : "bg-muted text-muted-foreground"}`}>{meta.icon}</div>
                            <div>
                              <span className="text-sm font-medium text-[#2e2e2e]">{meta.label}</span>
                              <div className="text-xs text-[#737373]">
                                {isActive && configured ? meta.connectedLabel(config) : meta.description}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {isActive && type !== "website" && (
                              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => {
                                setSetupChannel(type)
                                setSetupStep(0)
                                setSetupData(Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v || "")])))
                              }}>
                                Edit
                              </Button>
                            )}
                            <Switch
                              checked={isActive}
                              disabled={channelSaving === type}
                              onCheckedChange={(v: boolean) => void toggleChannel(type, v)}
                            />
                          </div>
                        </div>
                        {type === "website" && isActive && (
                          <div className="ml-11 mt-1 mb-2">
                            <div className="flex items-center gap-2">
                              <code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
                                {`<script src="${typeof window !== "undefined" ? window.location.origin : ""}/widget.js" data-agent-id="${id}"></script>`}
                              </code>
                              <Button variant="secondary" size="icon-sm" onClick={copyWidget}>
                                {copied ? <Check size={14} /> : <Copy size={14} />}
                              </Button>
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-1">Paste this in your website&apos;s HTML</p>
                          </div>
                        )}
                      </div>
                    )
                  })}
              {/* Channel setup wizard */}
              <Dialog open={!!setupChannel} onOpenChange={(open) => { if (!open) { setSetupChannel(null); setSetupStep(0); setFbPages([]); setWaNumbers([]) } }}>
                <DialogContent className="max-w-md">
                  {/* Facebook — step 0: connecting, step 1: pick page */}
                  {setupChannel === "facebook" && (
                    <>
                      <DialogHeader>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-50 text-blue-600"><ChannelIcon kind="messenger" size={18} /></div>
                          <DialogTitle>Connect Facebook Messenger</DialogTitle>
                        </div>
                      </DialogHeader>
                      {setupStep === 0 ? (
                        <div className="flex flex-col items-center py-8 gap-3">
                          {fbConnecting ? (
                            <>
                              <Loader variant="circular" size="sm" />
                              <p className="text-sm text-muted-foreground">Connecting to Facebook...</p>
                            </>
                          ) : (
                            <>
                              <p className="text-sm text-muted-foreground text-center">Log in with Facebook to connect your page</p>
                              <Button onClick={() => connectWithFacebook("facebook")} className="bg-[#1877F2] hover:bg-[#166FE5] text-white">
                                <ChannelIcon kind="messenger" size={16} className="mr-2" />Connect with Facebook
                              </Button>
                            </>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-3 py-2">
                          <p className="text-sm text-muted-foreground">Select a page to connect:</p>
                          {fbPages.map(page => (
                            <button key={page.id} className="w-full flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left" onClick={() => selectFacebookPage(page)} disabled={channelSaving !== null}>
                              <div>
                                <div className="text-sm font-medium">{page.name}</div>
                                <div className="text-xs text-muted-foreground">ID: {page.id}</div>
                              </div>
                              <Badge variant="secondary" className="text-xs">Select</Badge>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* WhatsApp — step 0: connecting, step 1: pick number */}
                  {setupChannel === "whatsapp" && (
                    <>
                      <DialogHeader>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-green-50 text-green-700"><ChannelIcon kind="whatsapp" size={18} /></div>
                          <DialogTitle>Connect WhatsApp</DialogTitle>
                        </div>
                      </DialogHeader>
                      {setupStep === 0 ? (
                        <div className="flex flex-col items-center py-8 gap-3">
                          {fbConnecting ? (
                            <>
                              <Loader variant="circular" size="sm" />
                              <p className="text-sm text-muted-foreground">Connecting to WhatsApp...</p>
                            </>
                          ) : (
                            <>
                              <p className="text-sm text-muted-foreground text-center">Log in with Facebook to connect your WhatsApp Business number</p>
                              <Button onClick={() => connectWithFacebook("whatsapp")} className="bg-[#25D366] hover:bg-[#20BD5A] text-white">
                                <ChannelIcon kind="whatsapp" size={16} className="mr-2" />Connect with WhatsApp
                              </Button>
                            </>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-3 py-2">
                          <p className="text-sm text-muted-foreground">Select a phone number to connect:</p>
                          {waNumbers.map(num => (
                            <button key={num.phone_number_id} className="w-full flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left" onClick={() => selectWhatsAppNumber(num)} disabled={channelSaving !== null}>
                              <div>
                                <div className="text-sm font-medium">{num.display_phone_number}</div>
                                <div className="text-xs text-muted-foreground">{num.verified_name}</div>
                              </div>
                              <Badge variant="secondary" className="text-xs">Select</Badge>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* Phone — auto-provision */}
                  {setupChannel === "phone" && (
                    <>
                      <DialogHeader>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-purple-50 text-purple-600"><Phone size={18} /></div>
                          <DialogTitle>Get a Phone Number</DialogTitle>
                        </div>
                      </DialogHeader>
                      {setupStep === 0 ? (
                        <div className="space-y-4 py-2">
                          <p className="text-sm text-muted-foreground">We&apos;ll generate a phone number for your agent. Customers can call it and talk to your AI.</p>
                          <div>
                            <Label className="text-xs">Country</Label>
                            <Select value={setupData.country || "US"} onValueChange={v => v && setSetupData({ ...setupData, country: v })}>
                              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="US">United States (+1)</SelectItem>
                                <SelectItem value="GB">United Kingdom (+44)</SelectItem>
                                <SelectItem value="IN">India (+91)</SelectItem>
                                <SelectItem value="CA">Canada (+1)</SelectItem>
                                <SelectItem value="AU">Australia (+61)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <DialogFooter>
                            <Button variant="secondary" onClick={() => setSetupChannel(null)}>Cancel</Button>
                            <Button disabled={channelSaving !== null} onClick={async () => {
                              setChannelSaving("phone")
                              setSetupStep(1)
                              try {
                                const res = await fetch("/api/channels/provision-phone", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ agentId: id, country: setupData.country || "US" }),
                                })
                                const data = await res.json()
                                if (data.phoneNumber) {
                                  setSetupData({ ...setupData, phoneNumber: data.phoneNumber })
                                  setSetupStep(2)
                                  loadChannels()
                                } else {
                                  alert(data.error || "Failed to get phone number")
                                  setSetupStep(0)
                                }
                              } catch {
                                alert("Failed to provision number")
                                setSetupStep(0)
                              }
                              setChannelSaving(null)
                            }}>
                              Generate Number
                            </Button>
                          </DialogFooter>
                        </div>
                      ) : setupStep === 1 ? (
                        <div className="flex flex-col items-center py-8 gap-3">
                          <Loader variant="circular" size="sm" />
                          <p className="text-sm text-muted-foreground">Getting your phone number...</p>
                        </div>
                      ) : (
                        <div className="space-y-4 py-2">
                          <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-center">
                            <p className="text-xs text-green-700 font-medium mb-1">Your agent&apos;s phone number</p>
                            <p className="text-xl font-bold text-green-800">{setupData.phoneNumber}</p>
                          </div>
                          <p className="text-xs text-muted-foreground text-center">Call this number to talk to your AI agent. Share it with your customers.</p>
                          <DialogFooter>
                            <Button onClick={() => { setSetupChannel(null); setSetupStep(0) }}>Done</Button>
                          </DialogFooter>
                        </div>
                      )}
                    </>
                  )}
                </DialogContent>
              </Dialog>

              </div>
            )}

            {/* Integrations tab */}
            {activeTab === "integrations" && (
              <div>
                {isNew ? (
                  <div className="flex flex-col items-center justify-center py-10 border border-dashed border-[#d4d4d4] rounded-xl bg-[#fafafa]">
                    <div className="h-12 w-12 rounded-full bg-[#f0f0f0] flex items-center justify-center mb-3">
                      <FileText size={22} className="text-[#a3a3a3]" />
                    </div>
                    <div className="text-sm font-medium text-[#525252]">Integrations available after creating the agent</div>
                    <div className="text-xs text-[#a3a3a3] mt-1 text-center max-w-sm">
                      Save this agent first, then connect Gmail, Slack, Notion, and 1000+ other services so it can take real actions in conversations.
                    </div>
                  </div>
                ) : agent ? (
                  <AgentIntegrationsTab agentId={agent.id} />
                ) : null}
              </div>
            )}

            {/* Knowledge Base tab */}
            {activeTab === "knowledge" && (
              <div>
                  {isNew ? (
                    <>
                      <div className="flex flex-col items-center justify-center py-10 border border-dashed border-[#d4d4d4] rounded-xl bg-[#fafafa] mb-4">
                        <div className="h-12 w-12 rounded-full bg-[#f0f0f0] flex items-center justify-center mb-3">
                          <FileText size={22} className="text-[#a3a3a3]" />
                        </div>
                        <div className="text-sm font-medium text-[#525252]">No knowledge base linked</div>
                        <div className="text-xs text-[#a3a3a3] mt-1">Upload documents or link an existing knowledge base after creating.</div>
                      </div>
                      <PostCreateNudge
                        title="Link a knowledge base after creating"
                        body="Documents and FAQs attach to an agent's id. Create the agent and come back to upload files or link an existing knowledge base."
                        canCreate={Boolean(editData.name?.trim())}
                        saving={saving}
                        onCreate={handleCreate}
                      />
                    </>
                  ) : kbLoading ? (
                    <div className="flex items-center justify-center py-6"><Loader variant="circular" size="sm" /></div>
                  ) : linkedKb ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs">{linkedKb.name}</Badge>
                          <span className="text-xs text-muted-foreground">{linkedKb.kb_documents?.length || 0} docs</span>
                        </div>
                        <Button variant="ghost" size="sm" className="text-xs h-7 text-muted-foreground" onClick={unlinkKb}>Unlink</Button>
                      </div>

                      {/* Document list */}
                      {linkedKb.kb_documents && linkedKb.kb_documents.length > 0 && (
                        <div className="space-y-1.5">
                          {linkedKb.kb_documents.map(doc => (
                            <div key={doc.id} className="flex items-center justify-between py-1.5 px-2 rounded-md bg-muted/50 group">
                              <div className="flex items-center gap-2 min-w-0">
                                <FileText size={14} className="shrink-0 text-muted-foreground" />
                                <span className="text-xs truncate">{doc.name}</span>
                                <Badge variant="secondary" className={`text-[11px] px-1.5 py-0 shrink-0 ${doc.status === "ready" ? "bg-green-50 text-green-700" : doc.status === "error" ? "bg-red-50 text-red-700" : "bg-yellow-50 text-yellow-700"}`}>
                                  {doc.status}
                                </Badge>
                              </div>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => deleteDocument(doc.id)}>
                                <X size={12} />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Upload button */}
                      <input ref={fileInputRef} type="file" className="hidden" accept=".txt,.md,.markdown,.csv,.pdf,.docx" onChange={e => { if (e.target.files?.[0]) uploadDocument(e.target.files[0]); e.target.value = "" }} />
                      <Button variant="secondary" size="sm" className="w-full" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                        <Upload size={14} className="mr-1.5" />{uploading ? "Uploading..." : "Upload Document"}
                      </Button>
                      <p className="text-[11px] text-muted-foreground text-center">Supports .txt, .md, .csv, .pdf, .docx</p>
                    </div>
                  ) : (
                    <div className="space-y-3 py-2">
                      <p className="text-xs text-muted-foreground text-center">No knowledge base linked to this agent</p>
                      <div className="flex gap-2">
                        <Button variant="secondary" size="sm" className="flex-1" onClick={createAndLinkKb}>
                          <Plus size={14} className="mr-1.5" />Create New
                        </Button>
                        <Button variant="secondary" size="sm" className="flex-1" onClick={() => setShowKbPicker(true)}>
                          Link Existing
                        </Button>
                      </div>
                    </div>
                  )}
              {/* KB picker dialog */}
              <Dialog open={showKbPicker} onOpenChange={setShowKbPicker}>
                <DialogContent>
                  <DialogHeader><DialogTitle>Link Knowledge Base</DialogTitle></DialogHeader>
                  <div className="space-y-2 py-2">
                    {knowledgeBases.filter(kb => !kb.agent_id).length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">No unlinked knowledge bases available</p>
                    ) : (
                      knowledgeBases.filter(kb => !kb.agent_id).map(kb => (
                        <button key={kb.id} className="w-full flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left" onClick={() => linkExistingKb(kb.id)}>
                          <div>
                            <div className="text-sm font-medium">{kb.name}</div>
                            {kb.description && <div className="text-xs text-muted-foreground">{kb.description}</div>}
                          </div>
                          <span className="text-xs text-muted-foreground">{kb.kb_documents?.length || 0} docs</span>
                        </button>
                      ))
                    )}
                  </div>
                  <DialogFooter>
                    <Button variant="secondary" onClick={() => setShowKbPicker(false)}>Cancel</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              </div>
            )}


          </div>
        </div>
      </Panel>

      {/* Right: Chat test panel — hidden in create mode (no agent to test yet) */}
      {!isNew && (
      <Panel
        resizable
        defaultWidth={400}
        minWidth={320}
        maxWidth={640}
        storageKey="agent:test-chat"
        header={
          <>
            <span className="text-sm font-medium text-[#2e2e2e]">Test Chat</span>
            <Button variant="ghost" size="sm" className="ml-auto text-xs" onClick={async () => {
              // Optimistic UI: clear immediately.
              const idToResolve = conversationId
              setMessages([])
              setConversationId(null)
              // End the server-side thread so the next send opens a
              // fresh conversation instead of re-finding the active one.
              if (idToResolve) {
                fetch(`/api/inbox/${idToResolve}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status: 'resolved' }),
                }).catch(() => { /* non-critical; a new conversation will still be created on next send */ })
              }
            }}>Clear</Button>
          </>
        }
      >
        <ScrollArea className="flex-1 min-h-0 p-4" ref={scrollRef}>
          <div className="space-y-4">
            {messages.map((msg, i) => {
              // Only widgets in the latest assistant message are interactive;
              // older submits would fire stale payloads into a fresh context.
              const isLatestAssistant =
                msg.role === "assistant" &&
                i === messages.length - 1 &&
                !chatLoading
              return (
                <Message key={i} className={msg.role === "user" ? "flex-row-reverse" : ""}>
                  <MessageAvatar src={msg.role === "assistant" ? (agent?.avatar_url || "") : ""} alt={msg.role === "assistant" ? (agent?.name || "Assistant") : "You"} fallback={msg.role === "assistant" ? (agent?.name?.[0]?.toUpperCase() || "J") : "Y"} className={msg.role === "assistant" ? "bg-[#2e2e2e] text-white" : "bg-[#ebebeb]"} />
                  <AiWidgetProvider
                    submit={(message) => { void sendChat({ message }) }}
                    disabled={!isLatestAssistant}
                  >
                    <AssistantBubble msg={msg} />
                  </AiWidgetProvider>
                </Message>
              )
            })}
            {chatLoading && (
              <Message>
                <MessageAvatar src={agent?.avatar_url || ""} alt={agent?.name || "Assistant"} fallback={agent?.name?.[0]?.toUpperCase() || "J"} className="bg-[#2e2e2e] text-white" />
                <div className="bg-white rounded-3xl px-4 py-3 ring-1 ring-black/[0.04]"><Loader variant="typing" size="sm" /></div>
              </Message>
            )}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>
        <div className="p-3 border-t border-black/[0.04]">
          <PromptInput>
            <PromptInputTextarea
              placeholder="Type a message..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat() } }}
            />
            <PromptInputActions>
              <div />
              <PromptInputAction tooltip="Send">
                <Button size="icon" className="rounded-full" onClick={() => sendChat()} disabled={chatLoading || !chatInput.trim()}>
                  <ArrowUp size={16} />
                </Button>
              </PromptInputAction>
            </PromptInputActions>
          </PromptInput>
        </div>
      </Panel>
      )}

      {!isNew && (
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent><DialogHeader><DialogTitle>Delete Agent</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">Are you sure you want to delete &quot;{agent?.name}&quot;? This cannot be undone.</p><DialogFooter><Button variant="secondary" onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="destructive" onClick={handleDelete}>Delete</Button></DialogFooter></DialogContent>
      </Dialog>
      )}
    </div>
  )
}

/**
 * Renders a single chat bubble — user messages stay plain-text, assistant
 * messages mount a ChainOfThought (if tool steps exist) above the final
 * markdown content. Empty assistant content with no thoughts yet shows
 * a typing indicator so there's never a blank bubble during tool calls.
 */
function AssistantBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user"
  const bubble = isUser
    ? "bg-[#f7f7f7] text-[#2e2e2e] rounded-3xl px-3.5 py-2 text-[13px] leading-relaxed"
    : "bg-white text-[#2e2e2e] rounded-3xl px-3.5 py-2 text-[13px] leading-relaxed ring-1 ring-black/[0.04]"

  if (isUser) {
    return <MessageContent className={bubble}>{msg.content}</MessageContent>
  }

  const hasContent = msg.content.trim().length > 0

  // The CoT rail is a live progress indicator, not a permanent log.
  // Once the final answer is here, drop every step — thinking,
  // tool_call, tool_done — so the chat history is just messages.
  const visibleThoughts = hasContent ? [] : (msg.thoughts ?? [])
  const hasVisibleThoughts = visibleThoughts.length > 0

  return (
    // Stack the CoT rail (quiet, no bubble) above the actual reply
    // bubble so the two read as distinct blocks — reasoning on top,
    // final answer below.
    <div className="flex flex-col gap-2 min-w-[220px] max-w-[640px]">
      {hasVisibleThoughts && (
        <ChainOfThought className="px-1 py-1">
          {visibleThoughts.map((t, idx) => <ThoughtRow key={`${t.kind}-${('id' in t ? t.id : idx)}-${idx}`} step={t} />)}
        </ChainOfThought>
      )}
      {hasContent ? (
        <div className={bubble}>
          <Markdown className="prose prose-sm max-w-none text-[#2e2e2e] prose-headings:mt-3 prose-headings:mb-1 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0 prose-a:text-[#2e2e2e] prose-a:underline prose-code:text-[#2e2e2e] prose-code:bg-[#f3f3f3] prose-code:rounded prose-code:px-1">
            {msg.content}
          </Markdown>
        </div>
      ) : (
        // No final text yet — typing indicator sits by itself (no
        // bubble) so the CoT above doesn't look attached to an empty
        // shape.
        <div className="px-2 py-1"><Loader variant="typing" size="md" /></div>
      )}
    </div>
  )
}

function ThoughtRow({ step }: { step: ThoughtStep }) {
  if (step.kind === "thinking") {
    const hasItems = step.items.length > 0
    return (
      <ChainOfThoughtStep>
        <ChainOfThoughtTrigger collapsible={hasItems}>{step.trigger}</ChainOfThoughtTrigger>
        {hasItems && (
          <ChainOfThoughtContent>
            {step.items.map((it, i) => <ChainOfThoughtItem key={i}>{it}</ChainOfThoughtItem>)}
          </ChainOfThoughtContent>
        )}
      </ChainOfThoughtStep>
    )
  }
  if (step.kind === "tool_call") {
    const argPreview = Object.keys(step.args).length === 0
      ? null
      : JSON.stringify(step.args)
    return (
      <ChainOfThoughtStep>
        <ChainOfThoughtTrigger collapsible={Boolean(argPreview)}>
          <span className="inline-flex items-center gap-1.5">
            <Loader variant="typing" size="sm" />
            Calling <code className="text-[11px] font-mono text-[#737373]">{step.tool}</code>
          </span>
        </ChainOfThoughtTrigger>
        {argPreview && (
          <ChainOfThoughtContent>
            <ChainOfThoughtItem>
              <code className="text-[11px] font-mono break-all">{argPreview}</code>
            </ChainOfThoughtItem>
          </ChainOfThoughtContent>
        )}
      </ChainOfThoughtStep>
    )
  }
  // tool_done — always has a resultPreview so always collapsible
  return (
    <ChainOfThoughtStep>
      <ChainOfThoughtTrigger>
        <span className="inline-flex items-center gap-1.5">
          <Check size={12} className="text-emerald-600" />
          <code className="text-[11px] font-mono text-[#737373]">{step.tool}</code>
        </span>
      </ChainOfThoughtTrigger>
      <ChainOfThoughtContent>
        <ChainOfThoughtItem>{step.resultPreview}</ChainOfThoughtItem>
      </ChainOfThoughtContent>
    </ChainOfThoughtStep>
  )
}

function PostCreateNudge({
  title,
  body,
  canCreate,
  saving,
  onCreate,
}: {
  title: string
  body: string
  canCreate: boolean
  saving: boolean
  onCreate: () => void
}) {
  return (
    <div className="mt-6 rounded-xl border border-black/[0.04] bg-[#fafafa] p-5">
      <div className="text-sm font-medium text-[#2e2e2e]">{title}</div>
      <p className="text-xs text-[#737373] mt-1 leading-relaxed">{body}</p>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={onCreate} disabled={saving || !canCreate}>
          {saving ? 'Creating…' : 'Create agent'}
        </Button>
        {!canCreate && (
          <span className="text-xs text-[#a3a3a3]">Add a name in the Agent tab first.</span>
        )}
      </div>
    </div>
  )
}
