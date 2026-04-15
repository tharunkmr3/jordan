// Save a Facebook/WhatsApp connection after OAuth flow
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
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

  const { agentId, channelType, config } = await request.json()

  // Verify agent
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('org_id', membership.org_id)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  // Auto-subscribe Facebook page to our webhook so messages flow in
  if (channelType === 'facebook' && config.page_id && config.page_access_token) {
    try {
      const subRes = await fetch(
        `https://graph.facebook.com/v21.0/${config.page_id}/subscribed_apps`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscribed_fields: 'messages,messaging_postbacks',
            access_token: config.page_access_token,
          }),
        }
      )
      const subData = await subRes.json()
      if (!subData.success) {
        console.error('[save-connection] Failed to subscribe page:', subData)
      }
    } catch (err) {
      console.error('[save-connection] Page subscription error:', err)
    }
  }

  // Upsert channel
  const { data: existing } = await supabase
    .from('agent_channels')
    .select('id')
    .eq('agent_id', agentId)
    .eq('channel_type', channelType)
    .single()

  if (existing) {
    const { data, error } = await supabase
      .from('agent_channels')
      .update({ channel_config: config, is_active: true, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  }

  const { data, error } = await supabase
    .from('agent_channels')
    .insert({ agent_id: agentId, org_id: membership.org_id, channel_type: channelType, channel_config: config, is_active: true })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
