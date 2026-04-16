// ============================================================================
// POST /api/chat
// Public endpoint for the website chat widget — supports streaming
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { processChatMessage, streamChatMessage } from '@/lib/ai/chat-pipeline'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

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
    const { agentId, message, conversationId, visitorId, visitorName, stream, isTest } = body

    if (!agentId || typeof agentId !== 'string') {
      return NextResponse.json({ error: 'agentId is required' }, { status: 400, headers: corsHeaders })
    }
    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'message is required' }, { status: 400, headers: corsHeaders })
    }
    if (message.length > 4000) {
      return NextResponse.json({ error: 'message too long (max 4000 characters)' }, { status: 400, headers: corsHeaders })
    }

    // Validate agent exists and is active
    const supabase = createAdminClient()
    const { data: agent } = await supabase
      .from('agents')
      .select('id, status')
      .eq('id', agentId)
      .single()

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404, headers: corsHeaders })
    }
    if (agent.status !== 'active') {
      return NextResponse.json({ error: 'Agent is not active' }, { status: 403, headers: corsHeaders })
    }

    // If an authenticated Jordon team member is hitting this endpoint,
    // scope the conversation to THEIR user id. That way two operators
    // testing the same agent — or any chat from a logged-in user with
    // an internal agent — each get their own private history instead
    // of mingling into a shared "Test" contact.
    //
    // Unauthenticated callers (the public widget on a customer's site)
    // fall through to using whatever visitorId / visitorName the client
    // provided, which is the real end-customer identifier.
    const serverSupabase = await createClient()
    const { data: { user: teamUser } } = await serverSupabase.auth.getUser()

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

    const pipelineInput = {
      agentId,
      message,
      conversationId: conversationId || undefined,
      channel: 'website' as const,
      isTest: effectiveIsTest,
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
