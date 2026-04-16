'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Panel } from '@/components/ui/panel'
import { avatarColor, avatarInitial } from '@/lib/utils'

// ---------------------------------------------------------------------------
// This page deliberately mirrors the left panel of /agents/[id] so the
// create flow and the edit flow share the same mental model. Once the
// agent exists we redirect into /agents/[id] where Channels and Knowledge
// Base tabs come online (those require an id to attach config to).
// ---------------------------------------------------------------------------

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

interface FormData {
  name: string
  description: string
  status: 'draft' | 'active' | 'paused'
  is_customer_facing: boolean
  escalation_email: string
  greeting_message: string
  fallback_message: string
  system_prompt: string
  model_provider: string
  model_name: string
  voice_provider: string
  voice_id: string
  language: string
  temperature: number
}

const initialForm: FormData = {
  name: '',
  description: '',
  status: 'draft',
  is_customer_facing: true,
  escalation_email: '',
  greeting_message: '',
  fallback_message: "I'm not sure about that. Let me connect you with someone who can help.",
  system_prompt: '',
  model_provider: 'sarvam',
  model_name: 'sarvam-m',
  voice_provider: 'none',
  voice_id: '',
  language: 'en',
  temperature: 0.7,
}

const MODEL_DEFAULTS: Record<string, string> = {
  sarvam: 'sarvam-m',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-pro',
}

const LANG_LABELS: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  kn: 'Kannada',
  bn: 'Bengali',
  mr: 'Marathi',
  gu: 'Gujarati',
  ml: 'Malayalam',
  pa: 'Punjabi',
}

export default function NewAgentPage() {
  const router = useRouter()
  const [form, setForm] = useState<FormData>(initialForm)
  const [activeTab, setActiveTab] = useState<'agent' | 'model'>('agent')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function handleCreate() {
    if (!form.name.trim()) {
      setError('Name is required')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description || null,
        status: form.status,
        system_prompt: form.system_prompt || null,
        model_provider: form.model_provider,
        model_name: form.model_name,
        voice_provider: form.voice_provider,
        voice_id: form.voice_id || null,
        language: form.language,
        supported_languages: [form.language],
        temperature: form.temperature,
        greeting_message: form.greeting_message || null,
        fallback_message: form.fallback_message || null,
        escalation_enabled: form.is_customer_facing,
        escalation_email: form.escalation_email || null,
        settings: { is_customer_facing: form.is_customer_facing, show_test_in_inbox: false },
      }
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to create agent')
      }
      const created = await res.json()
      // Refresh the sidebar agent list so the new row appears immediately.
      window.dispatchEvent(new CustomEvent('refresh-agents'))
      router.push(`/agents/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setSaving(false)
    }
  }

  // Deterministic avatar color seeded from the typed name so the
  // placeholder has some identity before the agent gets an id.
  const avatarSeed = form.name.trim() || 'new-agent'
  const c = avatarColor(avatarSeed)
  const initial = avatarInitial(form.name) || 'A'

  return (
    <div className="flex h-full gap-3 p-3 bg-[#f5f5f5] overflow-hidden">
      <Panel className="flex-1 min-w-0">
        {/* Header with back + avatar + name + Create */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-black/[0.04] flex-shrink-0">
          <button
            onClick={() => router.back()}
            className="rounded-md p-1 text-[#737373] hover:bg-[#f5f5f5] hover:text-[#2e2e2e]"
            title="Back"
          >
            <ArrowLeft size={16} />
          </button>
          <Avatar className="h-9 w-9">
            <AvatarFallback className={`text-sm font-semibold ${c.bg} ${c.text}`}>
              {initial}
            </AvatarFallback>
          </Avatar>
          <span className="text-base font-semibold text-[#2e2e2e] flex-1 truncate">
            {form.name.trim() || <span className="text-[#a3a3a3]">New agent</span>}
          </span>
          <Button variant="secondary" size="sm" onClick={() => router.back()} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={handleCreate} disabled={saving || !form.name.trim()}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </div>

        {/* Tabs — Channels / Knowledge Base come online post-create */}
        <div className="flex items-center gap-1 px-5 border-b border-black/[0.04] flex-shrink-0 overflow-x-auto">
          {[
            { key: 'agent', label: 'Agent' },
            { key: 'model', label: 'System Prompt' },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key as 'agent' | 'model')}
              className={`px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
                activeTab === t.key ? 'border-[#F4511E] text-[#2e2e2e]' : 'border-transparent text-[#737373] hover:text-[#2e2e2e]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto">
            {error && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
                {error}
              </div>
            )}

            {activeTab === 'agent' && (
              <div>
                <Field label="Name" description="The name of your AI agent. Visible to your team.">
                  <Input
                    placeholder="e.g. Customer Support Bot"
                    value={form.name}
                    onChange={e => update('name', e.target.value)}
                  />
                </Field>
                <Field label="Description" description="A short summary of what this agent does.">
                  <Textarea
                    placeholder="What does this agent do?"
                    value={form.description}
                    onChange={e => update('description', e.target.value)}
                  />
                </Field>
                <Field label="Status" description="Only active agents can receive messages.">
                  <Select value={form.status} onValueChange={v => v && update('status', v as FormData['status'])}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="paused">Paused</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Customer-facing" description="On = talks to your customers. Off = internal use only.">
                  <Switch
                    checked={form.is_customer_facing}
                    onCheckedChange={v => update('is_customer_facing', v)}
                  />
                </Field>
                {form.is_customer_facing && (
                  <Field label="Escalation email" description="When the AI can't help, conversations are escalated to this email.">
                    <Input
                      type="email"
                      placeholder="support@company.com"
                      value={form.escalation_email}
                      onChange={e => update('escalation_email', e.target.value)}
                    />
                  </Field>
                )}
                <Field label="Phone greeting" description="Spoken when someone calls. Chat channels start empty.">
                  <Textarea
                    placeholder="Welcome to Jordon.ai, how may I help you today?"
                    value={form.greeting_message}
                    onChange={e => update('greeting_message', e.target.value)}
                  />
                </Field>
                <Field label="Fallback message" description="Shown when the AI fails to generate a response.">
                  <Textarea
                    value={form.fallback_message}
                    onChange={e => update('fallback_message', e.target.value)}
                  />
                </Field>

                <div className="pt-6">
                  <div className="text-sm font-semibold text-[#2e2e2e]">Models</div>
                </div>
                <Field label="AI model" description="The model that powers this agent's responses.">
                  <Select
                    value={form.model_provider}
                    onValueChange={v => {
                      if (!v) return
                      update('model_provider', v)
                      update('model_name', MODEL_DEFAULTS[v] || form.model_name)
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sarvam">Sarvam 30B (Free)</SelectItem>
                      <SelectItem value="openai">OpenAI GPT-4o mini</SelectItem>
                      <SelectItem value="anthropic">Claude Sonnet 4</SelectItem>
                      <SelectItem value="gemini">Gemini Pro</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Voice provider" description="How the agent speaks on phone calls.">
                  <Select
                    value={form.voice_provider}
                    onValueChange={v => v && update('voice_provider', v)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Twilio Polly (Default)</SelectItem>
                      <SelectItem value="elevenlabs">ElevenLabs</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {form.voice_provider === 'elevenlabs' && (
                  <Field label="Voice" description="Pick a preset or paste a custom ElevenLabs voice ID.">
                    <div className="space-y-2">
                      <Select
                        value={form.voice_id}
                        onValueChange={v => v && update('voice_id', v)}
                      >
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
                      <Input
                        placeholder="Or paste a custom Voice ID"
                        value={form.voice_id}
                        onChange={e => update('voice_id', e.target.value)}
                      />
                    </div>
                  </Field>
                )}
                <Field label="Primary language" description="The language the agent primarily speaks in.">
                  <Select
                    value={form.language}
                    onValueChange={v => v && update('language', v)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(LANG_LABELS).map(([v, label]) => (
                        <SelectItem key={v} value={v}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Temperature" description="Lower = more focused and deterministic. Higher = more creative and varied.">
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Slider
                        className="grow"
                        value={[form.temperature]}
                        onValueChange={([v]) => update('temperature', Math.round(v * 100) / 100)}
                        min={0}
                        max={1}
                        step={0.01}
                      />
                      <Input
                        className="h-8 w-14 px-2 text-center text-sm"
                        type="text"
                        inputMode="decimal"
                        value={form.temperature}
                        onChange={e => {
                          const v = parseFloat(e.target.value)
                          if (!isNaN(v) && v >= 0 && v <= 1) update('temperature', v)
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

            {activeTab === 'model' && (
              <div>
                <div className="text-sm font-medium text-[#2e2e2e]">System Prompt</div>
                <p className="text-xs text-[#737373] mt-1 mb-3">
                  Instructions that define how the agent behaves, what it knows, and how it should respond.
                </p>
                <Textarea
                  value={form.system_prompt}
                  onChange={e => update('system_prompt', e.target.value)}
                  className="min-h-[500px] text-sm"
                />
              </div>
            )}
          </div>
        </div>
      </Panel>
    </div>
  )
}
