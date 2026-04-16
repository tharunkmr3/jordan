'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const MODEL_OPTIONS = [
  { provider: 'sarvam', name: 'sarvam-m1', label: 'Sarvam M1 — 30B (Free)' },
  { provider: 'sarvam', name: 'sarvam-m4', label: 'Sarvam M4 — 105B (Free)' },
  { provider: 'openai', name: 'gpt-4o', label: 'OpenAI GPT-4o' },
  { provider: 'anthropic', name: 'claude-3.5-sonnet', label: 'Anthropic Claude 3.5' },
  { provider: 'gemini', name: 'gemini-pro', label: 'Google Gemini Pro' },
] as const

const VOICE_OPTIONS = [
  { provider: 'sarvam', label: 'Sarvam Bulbul' },
  { provider: 'elevenlabs', label: 'ElevenLabs' },
  { provider: 'none', label: 'None' },
] as const

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ta', label: 'Tamil' },
  { value: 'te', label: 'Telugu' },
  { value: 'kn', label: 'Kannada' },
  { value: 'bn', label: 'Bengali' },
  { value: 'mr', label: 'Marathi' },
  { value: 'gu', label: 'Gujarati' },
  { value: 'ml', label: 'Malayalam' },
  { value: 'pa', label: 'Punjabi' },
] as const

interface FormData {
  name: string
  description: string
  greeting_message: string
  fallback_message: string
  model_provider: string
  model_name: string
  system_prompt: string
  temperature: number
  max_tokens: number
  voice_provider: string
  voice_id: string
  language: string
  supported_languages: string[]
  escalation_enabled: boolean
  escalation_email: string
}

const initialFormData: FormData = {
  name: '',
  description: '',
  greeting_message: '',
  fallback_message: '',
  model_provider: 'sarvam',
  model_name: 'sarvam-m1',
  system_prompt: '',
  temperature: 0.7,
  max_tokens: 1024,
  voice_provider: 'none',
  voice_id: '',
  language: 'en',
  supported_languages: ['en'],
  escalation_enabled: false,
  escalation_email: '',
}

export default function NewAgentPage() {
  const router = useRouter()
  const [form, setForm] = useState<FormData>(initialFormData)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleModelChange(value: string | null) {
    if (!value) return;
    const opt = MODEL_OPTIONS.find((m) => `${m.provider}:${m.name}` === value)
    if (opt) {
      update('model_provider', opt.provider)
      update('model_name', opt.name)
    }
  }

  function toggleLanguage(lang: string) {
    setForm((prev) => {
      const langs = prev.supported_languages.includes(lang)
        ? prev.supported_languages.filter((l) => l !== lang)
        : [...prev.supported_languages, lang]
      return { ...prev, supported_languages: langs }
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) {
      setError('Agent name is required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create agent')
      }

      router.push('/agents')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-[15px] font-semibold text-[#2e2e2e]">Create Agent</h1>
        <p className="text-[12px] text-[#a3a3a3] mt-1">Configure your new AI agent</p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <Tabs defaultValue="general" className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger value="general" className="text-[13px]">General</TabsTrigger>
            <TabsTrigger value="model" className="text-[13px]">AI Model</TabsTrigger>
            <TabsTrigger value="voice" className="text-[13px]">Voice</TabsTrigger>
            <TabsTrigger value="escalation" className="text-[13px]">Escalation</TabsTrigger>
          </TabsList>

          <TabsContent value="general">
            <Card className="border-[#e5e5e5]">
              <CardHeader className="pb-4">
                <CardTitle className="text-[14px]">General Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-[13px]">Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g. Customer Support Bot"
                    value={form.name}
                    onChange={(e) => update('name', e.target.value)}
                    className="text-[13px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="description" className="text-[13px]">Description</Label>
                  <Textarea
                    id="description"
                    placeholder="What does this agent do?"
                    value={form.description}
                    onChange={(e) => update('description', e.target.value)}
                    rows={3}
                    className="text-[13px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="greeting" className="text-[13px]">Greeting Message</Label>
                  <Textarea
                    id="greeting"
                    placeholder="The first message the agent sends to users"
                    value={form.greeting_message}
                    onChange={(e) => update('greeting_message', e.target.value)}
                    rows={2}
                    className="text-[13px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fallback" className="text-[13px]">Fallback Message</Label>
                  <Textarea
                    id="fallback"
                    placeholder="Message shown when the agent can't answer"
                    value={form.fallback_message}
                    onChange={(e) => update('fallback_message', e.target.value)}
                    rows={2}
                    className="text-[13px]"
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="model">
            <Card className="border-[#e5e5e5]">
              <CardHeader className="pb-4">
                <CardTitle className="text-[14px]">AI Model Configuration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-[13px]">Model Provider</Label>
                  <Select
                    value={`${form.model_provider}:${form.model_name}`}
                    onValueChange={handleModelChange}
                  >
                    <SelectTrigger className="text-[13px]">
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS.map((m) => (
                        <SelectItem
                          key={`${m.provider}:${m.name}`}
                          value={`${m.provider}:${m.name}`}
                          className="text-[13px]"
                        >
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="system_prompt" className="text-[13px]">System Prompt</Label>
                  <Textarea
                    id="system_prompt"
                    placeholder="Instructions for how the agent should behave..."
                    value={form.system_prompt}
                    onChange={(e) => update('system_prompt', e.target.value)}
                    rows={8}
                    className="text-[13px] font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="temperature" className="text-[13px]">
                    Temperature: {form.temperature}
                  </Label>
                  <input
                    id="temperature"
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={form.temperature}
                    onChange={(e) => update('temperature', parseFloat(e.target.value))}
                    className="w-full accent-[#2e2e2e]"
                  />
                  <div className="flex justify-between text-[11px] text-[#a3a3a3]">
                    <span>Precise</span>
                    <span>Creative</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="max_tokens" className="text-[13px]">Max Tokens</Label>
                  <Input
                    id="max_tokens"
                    type="number"
                    min={1}
                    max={8192}
                    value={form.max_tokens}
                    onChange={(e) => update('max_tokens', parseInt(e.target.value) || 1024)}
                    className="text-[13px]"
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="voice">
            <Card className="border-[#e5e5e5]">
              <CardHeader className="pb-4">
                <CardTitle className="text-[14px]">Voice & Language</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-[13px]">Voice Provider</Label>
                  <Select
                    value={form.voice_provider}
                    onValueChange={(v) => v && update('voice_provider', v)}
                  >
                    <SelectTrigger className="text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VOICE_OPTIONS.map((v) => (
                        <SelectItem key={v.provider} value={v.provider} className="text-[13px]">
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {form.voice_provider !== 'none' && (
                  <div className="space-y-1.5">
                    <Label htmlFor="voice_id" className="text-[13px]">Voice ID</Label>
                    <Input
                      id="voice_id"
                      placeholder="Enter voice ID"
                      value={form.voice_id}
                      onChange={(e) => update('voice_id', e.target.value)}
                      className="text-[13px]"
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label className="text-[13px]">Primary Language</Label>
                  <Select
                    value={form.language}
                    onValueChange={(v) => v && update('language', v)}
                  >
                    <SelectTrigger className="text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map((l) => (
                        <SelectItem key={l.value} value={l.value} className="text-[13px]">
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-[13px]">Supported Languages</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {LANGUAGES.map((l) => (
                      <label
                        key={l.value}
                        className="flex items-center gap-2 rounded-md border border-[#e5e5e5] px-3 py-2 text-[13px] cursor-pointer hover:bg-[#fafafa]"
                      >
                        <Checkbox
                          checked={form.supported_languages.includes(l.value)}
                          onCheckedChange={() => toggleLanguage(l.value)}
                        />
                        {l.label}
                      </label>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="escalation">
            <Card className="border-[#e5e5e5]">
              <CardHeader className="pb-4">
                <CardTitle className="text-[14px]">Escalation Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-[13px]">Enable Escalation</Label>
                    <p className="text-[12px] text-[#a3a3a3] mt-0.5">
                      Allow the agent to escalate conversations to a human
                    </p>
                  </div>
                  <Switch
                    checked={form.escalation_enabled}
                    onCheckedChange={(v) => update('escalation_enabled', v)}
                  />
                </div>
                {form.escalation_enabled && (
                  <div className="space-y-1.5">
                    <Label htmlFor="escalation_email" className="text-[13px]">Escalation Email</Label>
                    <Input
                      id="escalation_email"
                      type="email"
                      placeholder="support@company.com"
                      value={form.escalation_email}
                      onChange={(e) => update('escalation_email', e.target.value)}
                      className="text-[13px]"
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <div className="flex items-center gap-3 mt-6">
          <Button type="submit" disabled={saving} className="text-[13px]">
            {saving ? 'Creating...' : 'Create Agent'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="text-[13px]"
            onClick={() => router.push('/agents')}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}
