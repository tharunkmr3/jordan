import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  // Verify channel belongs to user's org
  const { data: existing } = await supabase
    .from('agent_channels')
    .select('id')
    .eq('id', id)
    .eq('org_id', membership.org_id)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
  }

  const body = await request.json()
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }

  if (body.config !== undefined) updateData.channel_config = body.config
  if (body.isActive !== undefined) updateData.is_active = body.isActive

  const { data: channel, error } = await supabase
    .from('agent_channels')
    .update(updateData)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(channel)
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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

  // Verify channel belongs to user's org
  const { data: existing } = await supabase
    .from('agent_channels')
    .select('id')
    .eq('id', id)
    .eq('org_id', membership.org_id)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
  }

  const { error } = await supabase
    .from('agent_channels')
    .delete()
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
