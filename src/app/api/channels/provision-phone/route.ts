// ============================================================================
// Jordon AI Platform — Auto-provision Twilio Phone Number
// Buys a number, sets voice webhook, saves to agent_channels
// ============================================================================

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID!
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN!

async function twilioFetch(path: string, body?: Record<string, string>) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  })
  return res.json()
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) return NextResponse.json({ error: 'No organization found' }, { status: 403 })

  const { agentId, country } = await request.json()

  // Verify agent
  const { data: agent } = await supabase
    .from('agents')
    .select('id, name')
    .eq('id', agentId)
    .eq('org_id', membership.org_id)
    .single()

  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  try {
    // 1. Search for available numbers
    const countryCode = country || 'US'
    const available = await twilioFetch(
      `/AvailablePhoneNumbers/${countryCode}/Local.json?VoiceEnabled=true&PageSize=1`
    )

    if (!available.available_phone_numbers || available.available_phone_numbers.length === 0) {
      return NextResponse.json({ error: `No phone numbers available in ${countryCode}. Try a different country.` }, { status: 400 })
    }

    const phoneNumber = available.available_phone_numbers[0].phone_number

    // 2. Buy the number and set webhook
    const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://app.jordon.ai'}/api/webhooks/twilio-voice?agentId=${agentId}`
    const purchased = await twilioFetch('/IncomingPhoneNumbers.json', {
      PhoneNumber: phoneNumber,
      VoiceUrl: webhookUrl,
      VoiceMethod: 'POST',
      FriendlyName: `Jordon - ${agent.name}`,
    })

    if (purchased.code) {
      return NextResponse.json({ error: purchased.message || 'Failed to purchase number' }, { status: 400 })
    }

    // 3. Save to agent_channels
    const config = {
      twilio_phone_number: purchased.phone_number,
      twilio_phone_sid: purchased.sid,
      friendly_name: purchased.friendly_name,
      country: countryCode,
    }

    const { data: existing } = await supabase
      .from('agent_channels')
      .select('id')
      .eq('agent_id', agentId)
      .eq('channel_type', 'phone')
      .single()

    if (existing) {
      await supabase
        .from('agent_channels')
        .update({ channel_config: config, is_active: true, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    } else {
      await supabase
        .from('agent_channels')
        .insert({ agent_id: agentId, org_id: membership.org_id, channel_type: 'phone', channel_config: config, is_active: true })
    }

    return NextResponse.json({
      phoneNumber: purchased.phone_number,
      sid: purchased.sid,
    })
  } catch (err) {
    console.error('[provision-phone] Error:', err)
    return NextResponse.json({ error: 'Failed to provision phone number' }, { status: 500 })
  }
}
