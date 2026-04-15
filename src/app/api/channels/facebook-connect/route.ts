// ============================================================================
// Jordon AI Platform — Facebook OAuth Connect
// Exchanges Facebook auth code for page tokens and connects channels
// ============================================================================

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

const FB_APP_ID = process.env.NEXT_PUBLIC_FACEBOOK_APP_ID!
const FB_APP_SECRET = process.env.FACEBOOK_APP_SECRET!

// ---------------------------------------------------------------------------
// POST — Exchange short-lived token for long-lived token, fetch pages
// Body: { accessToken, agentId, channelType: 'facebook' | 'whatsapp' }
// ---------------------------------------------------------------------------

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

  const body = await request.json()
  const { accessToken, agentId, channelType } = body as {
    accessToken: string
    agentId: string
    channelType: 'facebook' | 'whatsapp'
  }

  if (!accessToken || !agentId) {
    return NextResponse.json({ error: 'accessToken and agentId required' }, { status: 400 })
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

  try {
    // 1. Exchange for long-lived token
    const longLivedRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&fb_exchange_token=${accessToken}`
    )
    const longLivedData = await longLivedRes.json()

    if (!longLivedData.access_token) {
      return NextResponse.json({ error: 'Failed to get long-lived token', details: longLivedData }, { status: 400 })
    }

    const longLivedToken = longLivedData.access_token

    if (channelType === 'facebook') {
      // 2. Get user's pages
      const pagesRes = await fetch(
        `https://graph.facebook.com/v21.0/me/accounts?access_token=${longLivedToken}&fields=id,name,access_token`
      )
      const pagesData = await pagesRes.json()

      if (!pagesData.data || pagesData.data.length === 0) {
        return NextResponse.json({ error: 'No Facebook pages found for this account' }, { status: 400 })
      }

      return NextResponse.json({
        pages: pagesData.data.map((page: { id: string; name: string; access_token: string }) => ({
          id: page.id,
          name: page.name,
          access_token: page.access_token,
        })),
      })
    }

    if (channelType === 'whatsapp') {
      // Get WhatsApp Business Accounts
      const wabaRes = await fetch(
        `https://graph.facebook.com/v21.0/me?fields=businesses{owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}}&access_token=${longLivedToken}`
      )
      const wabaData = await wabaRes.json()

      // Extract phone numbers from all WABAs
      const phoneNumbers: { phone_number_id: string; display_phone_number: string; verified_name: string; waba_id: string }[] = []
      const businesses = wabaData.businesses?.data || []
      for (const biz of businesses) {
        const wabas = biz.owned_whatsapp_business_accounts?.data || []
        for (const waba of wabas) {
          const phones = waba.phone_numbers?.data || []
          for (const phone of phones) {
            phoneNumbers.push({
              phone_number_id: phone.id,
              display_phone_number: phone.display_phone_number,
              verified_name: phone.verified_name || waba.name,
              waba_id: waba.id,
            })
          }
        }
      }

      if (phoneNumbers.length === 0) {
        return NextResponse.json({ error: 'No WhatsApp phone numbers found for this account' }, { status: 400 })
      }

      return NextResponse.json({ phoneNumbers, accessToken: longLivedToken })
    }

    return NextResponse.json({ error: 'Invalid channelType' }, { status: 400 })
  } catch (err) {
    console.error('[facebook-connect] Error:', err)
    return NextResponse.json({ error: 'Failed to connect' }, { status: 500 })
  }
}
