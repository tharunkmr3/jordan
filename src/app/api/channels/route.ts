import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import type { AgentChannelInsert, ChannelType } from '@/types/database'

export async function GET(request: NextRequest) {
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

  const agentId = request.nextUrl.searchParams.get('agentId')
  if (!agentId) {
    return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
  }

  // Verify agent belongs to user's org
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('org_id', membership.org_id)
    .single()

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const { data: channels, error } = await supabase
    .from('agent_channels')
    .select('*')
    .eq('agent_id', agentId)
    .eq('org_id', membership.org_id)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(channels)
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
  const { agentId, channelType, config, isActive } = body as {
    agentId: string
    channelType: ChannelType
    config: Record<string, unknown>
    isActive: boolean
  }

  if (!agentId || !channelType) {
    return NextResponse.json({ error: 'agentId and channelType are required' }, { status: 400 })
  }

  // Verify agent belongs to user's org
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('org_id', membership.org_id)
    .single()

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Check if channel already exists for this agent + type — upsert
  const { data: existing } = await supabase
    .from('agent_channels')
    .select('id')
    .eq('agent_id', agentId)
    .eq('channel_type', channelType)
    .single()

  if (existing) {
    // Update existing channel
    const { data: channel, error } = await supabase
      .from('agent_channels')
      .update({
        channel_config: config || {},
        is_active: isActive ?? true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(channel)
  }

  // Create new channel
  const channelData: AgentChannelInsert = {
    agent_id: agentId,
    org_id: membership.org_id,
    channel_type: channelType,
    channel_config: config || {},
    is_active: isActive ?? true,
  }

  const { data: channel, error } = await supabase
    .from('agent_channels')
    .insert(channelData)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(channel, { status: 201 })
}
