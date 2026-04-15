// ============================================================================
// POST /api/chat
// Public endpoint for the website chat widget
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { processChatMessage } from '@/lib/ai/chat-pipeline'
import { createAdminClient } from '@/lib/supabase/admin'

// CORS headers — widget lives on customer sites
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Handle preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

// TODO: Add rate limiting (in-memory or Redis-based)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { agentId, message, conversationId, visitorId } = body

    // Validate required fields
    if (!agentId || typeof agentId !== 'string') {
      return NextResponse.json(
        { error: 'agentId is required' },
        { status: 400, headers: corsHeaders }
      )
    }

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'message is required' },
        { status: 400, headers: corsHeaders }
      )
    }

    if (message.length > 4000) {
      return NextResponse.json(
        { error: 'message too long (max 4000 characters)' },
        { status: 400, headers: corsHeaders }
      )
    }

    // Validate agent exists and is active
    const supabase = createAdminClient()
    const { data: agent } = await supabase
      .from('agents')
      .select('id, status')
      .eq('id', agentId)
      .single()

    if (!agent) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404, headers: corsHeaders }
      )
    }

    if (agent.status !== 'active') {
      return NextResponse.json(
        { error: 'Agent is not active' },
        { status: 403, headers: corsHeaders }
      )
    }

    // Process through the chat pipeline
    const result = await processChatMessage({
      agentId,
      message,
      conversationId: conversationId || undefined,
      channel: 'website',
      contactInfo: visitorId
        ? { channelUserId: visitorId }
        : undefined,
    })

    return NextResponse.json(
      {
        response: result.response,
        conversationId: result.conversationId,
        messageId: result.messageId,
      },
      { status: 200, headers: corsHeaders }
    )
  } catch (error) {
    console.error('[api/chat] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    )
  }
}
