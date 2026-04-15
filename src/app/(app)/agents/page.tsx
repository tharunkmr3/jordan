'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import type { Agent } from '@/types/database'
import { Plus, Robot } from '@phosphor-icons/react'

const statusStyles: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  draft: 'bg-neutral-50 text-neutral-500 border-neutral-200',
  paused: 'bg-amber-50 text-amber-700 border-amber-200',
}

const providerLabels: Record<string, string> = {
  sarvam: 'Sarvam',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchAgents() {
      try {
        const res = await fetch('/api/agents')
        if (!res.ok) throw new Error('Failed to load agents')
        const data = await res.json()
        setAgents(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong')
      } finally {
        setLoading(false)
      }
    }
    fetchAgents()
  }, [])

  return (
    <div className="p-6">
      {loading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="border-[#e5e5e5]">
              <CardContent className="p-5">
                <Skeleton className="h-5 w-32 mb-3" />
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && agents.length === 0 && (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-[#d4d4d4] bg-[#fafafa] py-24">
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#f0f0f0]">
              <Robot size={20} weight="duotone" className="text-[#737373]" />
            </div>
            <div className="text-[13px] font-medium text-[#525252]">No agents yet</div>
            <div className="text-[12px] text-[#a3a3a3] mt-1 mb-4">Create your first AI agent to get started</div>
            <Link href="/agents/new" className={cn(buttonVariants({ size: "sm" }), "h-8 gap-1.5 text-[13px]")}>
                <Plus size={14} weight="bold" />
                Create Agent
            </Link>
          </div>
        </div>
      )}

      {!loading && !error && agents.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Link key={agent.id} href={`/agents/${agent.id}`}>
              <Card className="border-[#e5e5e5] transition-colors hover:border-[#c4c4c4] cursor-pointer">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="text-[14px] font-semibold text-[#0a0a0a] truncate pr-2">
                      {agent.name}
                    </h3>
                    <Badge
                      variant="outline"
                      className={`text-[11px] shrink-0 ${statusStyles[agent.status] || ''}`}
                    >
                      {agent.status}
                    </Badge>
                  </div>
                  {agent.description && (
                    <p className="text-[12px] text-[#737373] line-clamp-2 mb-3">
                      {agent.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[11px] font-normal">
                      {providerLabels[agent.model_provider] || agent.model_provider}
                    </Badge>
                    <span className="text-[11px] text-[#a3a3a3]">{agent.model_name}</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
