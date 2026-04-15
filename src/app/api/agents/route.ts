import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { AgentInsert } from '@/types/database'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const { data: agents, error } = await supabase
    .from('agents')
    .select('*')
    .eq('org_id', membership.org_id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(agents)
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 403 })
  }

  const body = await request.json()

  const agentData: AgentInsert = {
    org_id: membership.org_id,
    name: body.name,
    description: body.description || null,
    avatar_url: body.avatar_url || null,
    system_prompt: body.system_prompt || null,
    model_provider: body.model_provider || 'sarvam',
    model_name: body.model_name || 'sarvam-m1',
    voice_provider: body.voice_provider || 'none',
    voice_id: body.voice_id || null,
    language: body.language || 'en',
    supported_languages: body.supported_languages || ['en'],
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 1024,
    greeting_message: body.greeting_message || null,
    fallback_message: body.fallback_message || null,
    escalation_enabled: body.escalation_enabled ?? false,
    escalation_email: body.escalation_email || null,
    status: body.status || 'draft',
    settings: body.settings || {},
  }

  const { data: agent, error } = await supabase
    .from('agents')
    .insert(agentData)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(agent, { status: 201 })
}
