// ============================================================================
// POST /api/chat
// Public endpoint for the website chat widget — supports streaming
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { processChatMessage, streamChatMessage } from '@/lib/ai/chat-pipeline'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { providerForModelName } from '@/lib/ai/catalog'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { agentId, message, conversationId, visitorId, visitorName, stream, isTest, modelName } = body

    if (!agentId || typeof agentId !== 'string') {
      return NextResponse.json({ error: 'agentId is required' }, { status: 400, headers: corsHeaders })
    }
    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'message is required' }, { status: 400, headers: corsHeaders })
    }
    if (message.length > 4000) {
      return NextResponse.json({ error: 'message too long (max 4000 characters)' }, { status: 400, headers: corsHeaders })
    }

    // Validate agent exists
    const supabase = createAdminClient()
    const { data: agent } = await supabase
      .from('agents')
      .select('id, status')
      .eq('id', agentId)
      .single()

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404, headers: corsHeaders })
    }

    // Check for an authenticated Jordon team member. When present we
    // scope the conversation to THEIR user id (private per-user test
    // chat) AND relax the agent.status gate — team members need to be
    // able to chat with draft/paused agents while iterating on them.
    //
    // Unauthenticated callers (the public widget on a customer's site)
    // still require an active agent AND fall through to whatever
    // visitorId / visitorName the client provided.
    const serverSupabase = await createClient()
    const { data: { user: teamUser } } = await serverSupabase.auth.getUser()

    if (!teamUser && agent.status !== 'active') {
      return NextResponse.json({ error: 'Agent is not active' }, { status: 403, headers: corsHeaders })
    }

    let effectiveVisitorId: string | undefined = visitorId
    let effectiveVisitorName: string | undefined = visitorName
    let effectiveIsTest = Boolean(isTest) || (typeof visitorId === 'string' && visitorId.startsWith('test-'))

    if (teamUser) {
      effectiveVisitorId = `test-${teamUser.id}`
      effectiveVisitorName =
        (teamUser.user_metadata?.full_name as string | undefined) ||
        teamUser.email?.split('@')[0] ||
        'You'
      effectiveIsTest = true
    }

    // Per-turn model override — only accept a model the catalog knows
    // about AND only honor it for authenticated team members. Public
    // widget requests can't switch models (that would be a cost /
    // capability-escalation vector).
    let modelOverride: { name: string; provider: 'openai' | 'anthropic' | 'sarvam' | 'gemini' } | undefined
    if (teamUser && typeof modelName === 'string' && modelName.length > 0) {
      const provider = providerForModelName(modelName)
      if (provider) modelOverride = { name: modelName, provider }
    }

    const pipelineInput = {
      agentId,
      message,
      conversationId: conversationId || undefined,
      channel: 'website' as const,
      isTest: effectiveIsTest,
      modelOverride,
      contactInfo: effectiveVisitorId
        ? { channelUserId: effectiveVisitorId, name: effectiveVisitorName || undefined }
        : undefined,
    }

    // Streaming mode — Server-Sent Events
    if (stream) {
      const encoder = new TextEncoder()
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of streamChatMessage(pipelineInput)) {
              const data = JSON.stringify(chunk) + '\n'
              controller.enqueue(encoder.encode(`data: ${data}\n`))
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          } catch (err) {
            console.error('[api/chat] Stream error:', err)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'token', data: 'Sorry, something went wrong.' })}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        },
      })

      return new Response(readable, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

    // Non-streaming mode (for Facebook, WhatsApp, etc.)
    const result = await processChatMessage(pipelineInput)

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
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders })
  }
}
