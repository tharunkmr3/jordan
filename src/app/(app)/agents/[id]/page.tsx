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
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message"
import { PromptInput, PromptInputTextarea, PromptInputActions, PromptInputAction } from "@/components/ui/prompt-input"
import { Loader } from "@/components/ui/loader"
import { ArrowUp, Copy, Check, Trash2, Pencil, Phone, Mail, Globe, Upload, FileText, X, Plus } from "lucide-react"
import { WhatsappLogo, MessengerLogo } from "@phosphor-icons/react"

interface Agent {
  id: string; name: string; description: string; system_prompt: string
  model_provider: string; model_name: string; voice_provider: string
  voice_id: string; language: string; supported_languages: string[]
  temperature: number; max_tokens: number; greeting_message: string
  fallback_message: string; escalation_enabled: boolean; escalation_email: string
  status: string; created_at: string
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

interface ChatMsg { role: "user" | "assistant"; content: string }

const modelLabels: Record<string, string> = { sarvam: "Sarvam 30B", openai: "GPT-4o", anthropic: "Claude 3.5", gemini: "Gemini Pro" }
const statusColors: Record<string, string> = { active: "bg-green-50 text-green-700", draft: "bg-gray-100 text-gray-600", paused: "bg-yellow-50 text-yellow-700" }

const channelMeta: Record<string, { label: string; icon: React.ReactNode; description: string; connectedLabel: (config: Record<string, unknown>) => string }> = {
  website: { label: "Website", icon: <Globe size={18} />, description: "Chat widget on your site", connectedLabel: () => "Embed code ready" },
  whatsapp: { label: "WhatsApp", icon: <WhatsappLogo size={18} weight="fill" />, description: "Receive messages on WhatsApp", connectedLabel: (c) => c.phone_number ? `${c.phone_number}` : "Connected" },
  facebook: { label: "Messenger", icon: <MessengerLogo size={18} weight="fill" />, description: "Facebook page messages", connectedLabel: (c) => c.page_name ? `${c.page_name}` : "Connected" },
  phone: { label: "Phone", icon: <Phone size={18} />, description: "Receive voice calls", connectedLabel: (c) => c.twilio_phone_number ? `${c.twilio_phone_number}` : "Connected" },
}

export default function AgentViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [editData, setEditData] = useState<Partial<Agent>>({})
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

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
    fetch(`/api/agents/${id}`).then(r => r.json()).then(data => {
      setAgent(data)
      setEditData(data)
      if (data.greeting_message) setMessages([{ role: "assistant", content: data.greeting_message }])
      setLoading(false)
    })
    loadChannels()
    loadKnowledgeBases()
  }, [id, loadChannels, loadKnowledgeBases])

  async function handleSave() {
    setSaving(true)
    const res = await fetch(`/api/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editData) })
    if (res.ok) { const updated = await res.json(); setAgent(updated); setEditing(false) }
    setSaving(false)
  }

  async function handleDelete() { await fetch(`/api/agents/${id}`, { method: "DELETE" }); router.push("/agents") }

  async function sendChat() {
    if (!chatInput.trim() || chatLoading) return
    const msg = chatInput.trim(); setChatInput("")
    setMessages(prev => [...prev, { role: "user", content: msg }])
    setChatLoading(true)
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: id, message: msg, conversationId, stream: true }),
      })
      if (!res.body) throw new Error("No stream")
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantMsg = ""
      setMessages(prev => [...prev, { role: "assistant", content: "" }])
      setChatLoading(false)

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
              setMessages(prev => {
                const updated = [...prev]
                updated[updated.length - 1] = { role: "assistant", content: assistantMsg }
                return updated
              })
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

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }) }, [messages, chatLoading])

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

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  if (!agent) return <div className="p-6 text-sm text-red-600">Agent not found</div>

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Left: Agent details */}
      <div className="flex-1 overflow-y-auto border-r border-[#ebebeb] p-6">
        <div className="max-w-xl mx-auto space-y-5">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold">{agent.name}</h1>
                <Badge className={statusColors[agent.status] || ""}>{agent.status}</Badge>
              </div>
              {agent.description && <p className="text-sm text-muted-foreground mt-1">{agent.description}</p>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(!editing)}>
                <Pencil size={14} className="mr-1.5" />{editing ? "Cancel" : "Edit"}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
                <Trash2 size={14} />
              </Button>
            </div>
          </div>

          {editing ? (
            <Card>
              <CardContent className="p-5 space-y-5">
                <Tabs defaultValue="general">
                  <TabsList><TabsTrigger value="general">General</TabsTrigger><TabsTrigger value="model">AI Model</TabsTrigger><TabsTrigger value="voice">Voice</TabsTrigger><TabsTrigger value="escalation">Escalation</TabsTrigger></TabsList>
                  <TabsContent value="general" className="space-y-4 pt-4">
                    <div><Label>Name</Label><Input value={editData.name || ""} onChange={e => setEditData({...editData, name: e.target.value})} className="mt-1.5" /></div>
                    <div><Label>Description</Label><Textarea value={editData.description || ""} onChange={e => setEditData({...editData, description: e.target.value})} className="mt-1.5" /></div>
                    <div><Label>Greeting Message</Label><Textarea value={editData.greeting_message || ""} onChange={e => setEditData({...editData, greeting_message: e.target.value})} className="mt-1.5" /></div>
                    <div><Label>Fallback Message</Label><Textarea value={editData.fallback_message || ""} onChange={e => setEditData({...editData, fallback_message: e.target.value})} className="mt-1.5" /></div>
                    <div><Label>Status</Label><Select value={editData.status} onValueChange={v => v && setEditData({...editData, status: v})}><SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">Draft</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="paused">Paused</SelectItem></SelectContent></Select></div>
                  </TabsContent>
                  <TabsContent value="model" className="space-y-4 pt-4">
                    <div><Label>Model Provider</Label><Select value={editData.model_provider} onValueChange={v => {
                      if (!v) return
                      const defaults: Record<string, string> = { openai: "gpt-4o-mini", anthropic: "claude-sonnet-4-20250514", sarvam: "sarvam-m", gemini: "gemini-pro" }
                      setEditData({...editData, model_provider: v, model_name: defaults[v] || editData.model_name})
                    }}><SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="sarvam">Sarvam 30B (Free)</SelectItem><SelectItem value="openai">OpenAI GPT-4o mini</SelectItem><SelectItem value="anthropic">Claude Sonnet 4</SelectItem><SelectItem value="gemini">Gemini Pro</SelectItem></SelectContent></Select></div>
                    <div><Label>System Prompt</Label><Textarea value={editData.system_prompt || ""} onChange={e => setEditData({...editData, system_prompt: e.target.value})} className="mt-1.5 min-h-[120px]" /></div>
                    <div><Label>Temperature ({editData.temperature ?? 0.7})</Label><Input type="range" min={0} max={1} step={0.1} value={editData.temperature ?? 0.7} onChange={e => setEditData({...editData, temperature: parseFloat(e.target.value)})} className="mt-1.5" /></div>
                  </TabsContent>
                  <TabsContent value="voice" className="space-y-4 pt-4">
                    <div><Label>Voice Provider</Label><Select value={editData.voice_provider || "none"} onValueChange={v => v && setEditData({...editData, voice_provider: v})}><SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">None</SelectItem><SelectItem value="sarvam">Sarvam Bulbul</SelectItem><SelectItem value="elevenlabs">ElevenLabs</SelectItem></SelectContent></Select></div>
                    <div><Label>Primary Language</Label><Select value={editData.language || "en"} onValueChange={v => v && setEditData({...editData, language: v})}><SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger><SelectContent>{["en","hi","ta","te","kn","bn","mr","gu","ml","pa"].map(l => <SelectItem key={l} value={l}>{({en:"English",hi:"Hindi",ta:"Tamil",te:"Telugu",kn:"Kannada",bn:"Bengali",mr:"Marathi",gu:"Gujarati",ml:"Malayalam",pa:"Punjabi"} as Record<string,string>)[l]}</SelectItem>)}</SelectContent></Select></div>
                  </TabsContent>
                  <TabsContent value="escalation" className="space-y-4 pt-4">
                    <div className="flex items-center justify-between"><Label>Enable Escalation</Label><Switch checked={editData.escalation_enabled || false} onCheckedChange={v => setEditData({...editData, escalation_enabled: v})} /></div>
                    {editData.escalation_enabled && <div><Label>Escalation Email</Label><Input type="email" value={editData.escalation_email || ""} onChange={e => setEditData({...editData, escalation_email: e.target.value})} className="mt-1.5" /></div>}
                  </TabsContent>
                </Tabs>
                <div className="flex gap-2 pt-2">
                  <Button onClick={handleSave} disabled={saving} size="sm">{saving ? "Saving..." : "Save Changes"}</Button>
                  <Button variant="outline" size="sm" onClick={() => { setEditing(false); setEditData(agent) }}>Cancel</Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="group cursor-pointer hover:border-[#ccc] transition-colors" onClick={() => setEditing(true)}>
                <CardHeader className="pb-2"><div className="flex items-center justify-between"><CardTitle className="text-sm">AI Model</CardTitle><Pencil size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" /></div></CardHeader>
                <CardContent className="space-y-2.5">
                  <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Provider</span><Badge variant="secondary">{modelLabels[agent.model_provider] || agent.model_provider}</Badge></div>
                  <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Temperature</span><span className="text-sm font-medium">{agent.temperature}</span></div>
                  <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Language</span><span className="text-sm font-medium">{agent.language}</span></div>
                </CardContent>
              </Card>
              <Card className="group cursor-pointer hover:border-[#ccc] transition-colors" onClick={() => setEditing(true)}>
                <CardHeader className="pb-2"><div className="flex items-center justify-between"><CardTitle className="text-sm">System Prompt</CardTitle><Pencil size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" /></div></CardHeader>
                <CardContent><p className="text-sm whitespace-pre-wrap text-muted-foreground">{agent.system_prompt || "No system prompt set"}</p></CardContent>
              </Card>
              <Card className="group cursor-pointer hover:border-[#ccc] transition-colors" onClick={() => setEditing(true)}>
                <CardHeader className="pb-2"><div className="flex items-center justify-between"><CardTitle className="text-sm">Escalation</CardTitle><Pencil size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" /></div></CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Enabled</span><span className="text-sm font-medium">{agent.escalation_enabled ? "Yes" : "No"}</span></div>
                  {agent.escalation_enabled && agent.escalation_email && <div className="flex items-center justify-between mt-2"><span className="text-xs text-muted-foreground">Email</span><span className="text-sm">{agent.escalation_email}</span></div>}
                </CardContent>
              </Card>

              {/* Channels */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Channels</CardTitle>
                  <p className="text-xs text-muted-foreground">How customers reach this agent</p>
                </CardHeader>
                <CardContent className="space-y-1">
                  {Object.entries(channelMeta).map(([type, meta]) => {
                    const ch = channels.find(c => c.channel_type === type)
                    const isActive = ch?.is_active ?? false
                    const config = (ch?.channel_config || {}) as Record<string, unknown>
                    const configured = isChannelConfigured(type, config)
                    return (
                      <div key={type}>
                        <div className="flex items-center justify-between py-2.5 px-1 rounded-lg hover:bg-muted/50 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${isActive && configured ? "bg-green-50 text-green-700" : "bg-muted text-muted-foreground"}`}>{meta.icon}</div>
                            <div>
                              <span className="text-sm font-medium">{meta.label}</span>
                              <div className="text-xs text-muted-foreground">
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
                              <code className="flex-1 rounded-md bg-muted px-3 py-2 text-[11px] font-mono break-all">
                                {`<script src="${typeof window !== "undefined" ? window.location.origin : ""}/widget.js" data-agent-id="${id}"></script>`}
                              </code>
                              <Button variant="outline" size="icon-sm" onClick={copyWidget}>
                                {copied ? <Check size={14} /> : <Copy size={14} />}
                              </Button>
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1">Paste this in your website&apos;s HTML</p>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </CardContent>
              </Card>

              {/* Channel setup wizard */}
              <Dialog open={!!setupChannel} onOpenChange={(open) => { if (!open) { setSetupChannel(null); setSetupStep(0); setFbPages([]); setWaNumbers([]) } }}>
                <DialogContent className="max-w-md">
                  {/* Facebook — step 0: connecting, step 1: pick page */}
                  {setupChannel === "facebook" && (
                    <>
                      <DialogHeader>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-50 text-blue-600"><MessengerLogo size={18} weight="fill" /></div>
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
                                <MessengerLogo size={16} weight="fill" className="mr-2" />Connect with Facebook
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
                          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-green-50 text-green-700"><WhatsappLogo size={18} weight="fill" /></div>
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
                                <WhatsappLogo size={16} weight="fill" className="mr-2" />Connect with WhatsApp
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
                            <Button variant="outline" onClick={() => setSetupChannel(null)}>Cancel</Button>
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

              {/* Knowledge Base */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Knowledge Base</CardTitle>
                  <p className="text-xs text-muted-foreground">Documents the agent uses to answer questions</p>
                </CardHeader>
                <CardContent>
                  {kbLoading ? (
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
                                <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 shrink-0 ${doc.status === "ready" ? "bg-green-50 text-green-700" : doc.status === "error" ? "bg-red-50 text-red-700" : "bg-yellow-50 text-yellow-700"}`}>
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
                      <input ref={fileInputRef} type="file" className="hidden" accept=".txt,.csv,.pdf,.docx" onChange={e => { if (e.target.files?.[0]) uploadDocument(e.target.files[0]); e.target.value = "" }} />
                      <Button variant="outline" size="sm" className="w-full" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
                        <Upload size={14} className="mr-1.5" />{uploading ? "Uploading..." : "Upload Document"}
                      </Button>
                      <p className="text-[10px] text-muted-foreground text-center">Supports .txt, .csv, .pdf, .docx</p>
                    </div>
                  ) : (
                    <div className="space-y-3 py-2">
                      <p className="text-xs text-muted-foreground text-center">No knowledge base linked to this agent</p>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" className="flex-1" onClick={createAndLinkKb}>
                          <Plus size={14} className="mr-1.5" />Create New
                        </Button>
                        <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowKbPicker(true)}>
                          Link Existing
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

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
                    <Button variant="outline" onClick={() => setShowKbPicker(false)}>Cancel</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>
      </div>

      {/* Right: Chat test panel */}
      <div className="w-[400px] flex flex-col bg-white">
        <div className="h-12 flex items-center justify-between px-4 border-b border-[#ebebeb]">
          <span className="text-sm font-medium">Test Chat</span>
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => { setMessages(agent?.greeting_message ? [{ role: "assistant", content: agent.greeting_message }] : []); setConversationId(null) }}>Clear</Button>
        </div>
        <ScrollArea className="flex-1 p-4" ref={scrollRef}>
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <Message key={i} className={msg.role === "user" ? "flex-row-reverse" : ""}>
                <MessageAvatar src="" alt={msg.role === "assistant" ? "AI" : "You"} fallback={msg.role === "assistant" ? "J" : "Y"} className={msg.role === "assistant" ? "bg-[#0a0a0a] text-white" : "bg-[#ebebeb]"} />
                <MessageContent className={msg.role === "user" ? "bg-[#0a0a0a] text-white rounded-2xl rounded-tr-sm px-4 py-2.5" : "bg-[#f5f5f5] rounded-2xl rounded-tl-sm px-4 py-2.5"}>{msg.content}</MessageContent>
              </Message>
            ))}
            {chatLoading && (
              <Message>
                <MessageAvatar src="" alt="AI" fallback="J" className="bg-[#0a0a0a] text-white" />
                <div className="bg-[#f5f5f5] rounded-2xl rounded-tl-sm px-4 py-3"><Loader variant="typing" size="sm" /></div>
              </Message>
            )}
          </div>
        </ScrollArea>
        <div className="p-3 border-t border-[#ebebeb]">
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
                <Button size="icon" className="rounded-full" onClick={sendChat} disabled={chatLoading || !chatInput.trim()}>
                  <ArrowUp size={16} />
                </Button>
              </PromptInputAction>
            </PromptInputActions>
          </PromptInput>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent><DialogHeader><DialogTitle>Delete Agent</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">Are you sure you want to delete &quot;{agent.name}&quot;? This cannot be undone.</p><DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="destructive" onClick={handleDelete}>Delete</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  )
}
