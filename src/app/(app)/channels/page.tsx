'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { MessageSquare, Phone, Globe, MessageCircle, Copy, Check, Loader2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'

interface Agent {
  id: string
  name: string
  status: string
}

interface AgentChannel {
  id: string
  agent_id: string
  channel_type: 'whatsapp' | 'facebook' | 'website' | 'phone'
  channel_config: Record<string, string>
  is_active: boolean
}

interface ChannelCardConfig {
  type: 'whatsapp' | 'facebook' | 'website' | 'phone'
  title: string
  description: string
  icon: React.ReactNode
  fields: { key: string; label: string; placeholder: string; type?: string }[]
}

const CHANNEL_CONFIGS: ChannelCardConfig[] = [
  {
    type: 'whatsapp',
    title: 'WhatsApp',
    description: 'Connect your WhatsApp Business account to receive and respond to messages.',
    icon: <MessageSquare className="h-5 w-5" />,
    fields: [
      { key: 'phone_number_id', label: 'Phone Number ID', placeholder: 'e.g. 1234567890' },
      { key: 'waba_id', label: 'Business Account ID', placeholder: 'e.g. 9876543210' },
      { key: 'access_token', label: 'Access Token', placeholder: 'Your WhatsApp access token', type: 'password' },
      { key: 'verify_token', label: 'Verify Token', placeholder: 'Webhook verify token' },
    ],
  },
  {
    type: 'facebook',
    title: 'Facebook Messenger',
    description: 'Connect your Facebook Page to handle Messenger conversations.',
    icon: <MessageCircle className="h-5 w-5" />,
    fields: [
      { key: 'page_id', label: 'Page ID', placeholder: 'Your Facebook Page ID' },
      { key: 'page_access_token', label: 'Page Token', placeholder: 'Page access token', type: 'password' },
      { key: 'verify_token', label: 'Verify Token', placeholder: 'Webhook verify token' },
    ],
  },
  {
    type: 'phone',
    title: 'Phone (Twilio)',
    description: 'Enable voice calls through Twilio for phone-based customer support.',
    icon: <Phone className="h-5 w-5" />,
    fields: [
      { key: 'twilio_sid', label: 'Account SID', placeholder: 'Your Twilio Account SID' },
      { key: 'twilio_auth_token', label: 'Auth Token', placeholder: 'Your Twilio Auth Token', type: 'password' },
      { key: 'twilio_phone_number', label: 'Phone Number', placeholder: '+1234567890' },
    ],
  },
  {
    type: 'website',
    title: 'Website Widget',
    description: 'Add a chat widget to your website with a single line of code.',
    icon: <Globe className="h-5 w-5" />,
    fields: [],
  },
]

export default function ChannelsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [channels, setChannels] = useState<AgentChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [configDialog, setConfigDialog] = useState<ChannelCardConfig | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState(false)

  // Fetch agents
  useEffect(() => {
    async function fetchAgents() {
      try {
        const res = await fetch('/api/agents')
        if (res.ok) {
          const data = await res.json()
          setAgents(data)
          if (data.length > 0 && !selectedAgentId) {
            setSelectedAgentId(data[0].id)
          }
        }
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
    fetchAgents()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch channels when agent changes
  const fetchChannels = useCallback(async () => {
    if (!selectedAgentId) return
    try {
      const res = await fetch(`/api/channels?agentId=${selectedAgentId}`)
      if (res.ok) {
        const data = await res.json()
        setChannels(data)
      }
    } catch {
      // ignore
    }
  }, [selectedAgentId])

  useEffect(() => {
    fetchChannels()
  }, [fetchChannels])

  function getChannel(type: string): AgentChannel | undefined {
    return channels.find((c) => c.channel_type === type)
  }

  async function toggleChannel(type: 'whatsapp' | 'facebook' | 'website' | 'phone', active: boolean) {
    setSaving(type)
    const existing = getChannel(type)

    try {
      if (existing) {
        await fetch(`/api/channels/${existing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: active }),
        })
      } else {
        await fetch('/api/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: selectedAgentId,
            channelType: type,
            config: {},
            isActive: active,
          }),
        })
      }
      await fetchChannels()
    } catch {
      // ignore
    } finally {
      setSaving(null)
    }
  }

  async function saveConfig() {
    if (!configDialog) return
    setSaving(configDialog.type)

    try {
      await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgentId,
          channelType: configDialog.type,
          config: configValues,
          isActive: true,
        }),
      })
      await fetchChannels()
      setConfigDialog(null)
    } catch {
      // ignore
    } finally {
      setSaving(null)
    }
  }

  async function disconnectChannel(type: string) {
    const existing = getChannel(type)
    if (!existing) return
    setSaving(type)

    try {
      await fetch(`/api/channels/${existing.id}`, { method: 'DELETE' })
      await fetchChannels()
    } catch {
      // ignore
    } finally {
      setSaving(null)
    }
  }

  function openConfigDialog(config: ChannelCardConfig) {
    const existing = getChannel(config.type)
    setConfigValues(existing?.channel_config || {})
    setConfigDialog(config)
  }

  function copyEmbedCode() {
    const code = `<script src="${window.location.origin}/widget.js" data-agent-id="${selectedAgentId}"></script>`
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="mb-6 space-y-1">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-64" />
        </div>
        <div className="grid gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                  <Skeleton className="h-6 w-11 rounded-full" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[15px] font-semibold text-[#2e2e2e]">Channels</h1>
          <p className="text-[12px] text-[#a3a3a3] mt-1">
            Connect your agent to messaging platforms and your website.
          </p>
        </div>
      </div>

      {/* Agent Selector */}
      <div className="mb-6">
        <Label className="text-[12px] text-[#737373] mb-1.5 block">Select Agent</Label>
        <Select value={selectedAgentId} onValueChange={(v) => v && setSelectedAgentId(v)}>
          <SelectTrigger className="w-[280px]">
            <SelectValue placeholder="Select an agent" />
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

      {!selectedAgentId ? (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-[#d4d4d4] bg-[#fafafa] py-24">
          <div className="text-center">
            <div className="text-[13px] font-medium text-[#a3a3a3]">No agent selected</div>
            <div className="text-[12px] text-[#c4c4c4] mt-1">
              Select an agent above to configure channels.
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {CHANNEL_CONFIGS.map((config) => {
            const channel = getChannel(config.type)
            const isActive = channel?.is_active ?? false
            const isConnected = !!channel
            const isSaving = saving === config.type

            return (
              <Card key={config.type} className="relative">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f5f5f5] text-[#737373]">
                        {config.icon}
                      </div>
                      <div>
                        <CardTitle className="text-[14px] font-medium">
                          {config.title}
                        </CardTitle>
                        <div className="flex items-center gap-2 mt-0.5">
                          {isConnected ? (
                            <Badge
                              variant={isActive ? 'default' : 'secondary'}
                              className="text-[10px] px-1.5 py-0"
                            >
                              {isActive ? 'Active' : 'Inactive'}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                              Not connected
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <Switch
                      checked={isActive}
                      disabled={isSaving}
                      onCheckedChange={(checked) => toggleChannel(config.type, checked)}
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-[12px] mb-4">
                    {config.description}
                  </CardDescription>

                  {/* Website-specific: embed code */}
                  {config.type === 'website' && isConnected && isActive && (
                    <div className="mb-4">
                      <Label className="text-[11px] text-[#737373] mb-1 block">
                        Embed Code
                      </Label>
                      <div className="relative">
                        <pre className="bg-[#fafafa] border border-[#e5e5e5] rounded-lg p-3 text-[11px] font-mono text-[#525252] overflow-x-auto">
{`<script src="${typeof window !== 'undefined' ? window.location.origin : ''}/widget.js" data-agent-id="${selectedAgentId}"></script>`}
                        </pre>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="absolute top-1.5 right-1.5 h-7 w-7 p-0"
                          onClick={copyEmbedCode}
                        >
                          {copied ? (
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    {config.fields.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-[12px]"
                        onClick={() => openConfigDialog(config)}
                      >
                        {isConnected ? 'Edit Config' : 'Configure'}
                      </Button>
                    )}
                    {isConnected && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[12px] text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => disconnectChannel(config.type)}
                        disabled={isSaving}
                      >
                        Disconnect
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Config Dialog */}
      <Dialog open={!!configDialog} onOpenChange={() => setConfigDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-[14px]">
              Configure {configDialog?.title}
            </DialogTitle>
            <DialogDescription className="text-[12px]">
              Enter your {configDialog?.title} credentials to connect this channel.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {configDialog?.fields.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label className="text-[12px]">{field.label}</Label>
                <Input
                  type={field.type || 'text'}
                  placeholder={field.placeholder}
                  value={configValues[field.key] || ''}
                  onChange={(e) =>
                    setConfigValues((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  className="text-[13px]"
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfigDialog(null)}
              className="text-[12px]"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={saveConfig}
              disabled={saving !== null}
              className="text-[12px]"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : null}
              Save & Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
