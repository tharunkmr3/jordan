// ============================================================================
// GET /api/chat/history?conversationId=xxx
// Load conversation history for the widget
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const conversationId = searchParams.get('conversationId')
    const agentId = searchParams.get('agentId')

    const supabase = createAdminClient()

    // ------------------------------------------------------------------
    // Mode A — explicit conversationId (widget embed fetching its
    // own thread from localStorage). No auth required.
    // ------------------------------------------------------------------
    if (conversationId) {
      const { data: conversation } = await supabase
        .from('conversations')
        .select('id')
        .eq('id', conversationId)
        .single()

      if (!conversation) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404, headers: corsHeaders }
        )
      }

      const { data: messages, error } = await supabase
        .from('messages')
        .select('id, role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(100)

      if (error) {
        console.error('[api/chat/history] DB error:', error)
        return NextResponse.json(
          { error: 'Failed to load messages' },
          { status: 500, headers: corsHeaders }
        )
      }

      return NextResponse.json(
        { conversationId, messages: messages || [] },
        { status: 200, headers: corsHeaders }
      )
    }

    // ------------------------------------------------------------------
    // Mode B — authenticated team member fetching their own test-chat
    // thread with a specific agent (GET /api/chat/history?agentId=xxx).
    // Returns the latest per-user conversation (or empty on first visit).
    // ------------------------------------------------------------------
    if (agentId) {
      const serverSupabase = await createClient()
      const { data: { user } } = await serverSupabase.auth.getUser()
      if (!user) {
        return NextResponse.json(
          { error: 'agentId mode requires authentication' },
          { status: 401, headers: corsHeaders }
        )
      }

      // Find the user's contact for this agent's org (channel_user_id = test-<userId>).
      const { data: contact } = await supabase
        .from('contacts')
        .select('id')
        .eq('channel_user_id', `test-${user.id}`)
        .limit(1)
        .maybeSingle()

      if (!contact) {
        return NextResponse.json({ conversationId: null, messages: [] }, { status: 200, headers: corsHeaders })
      }

      // Latest conversation with this (agent, contact) pair.
      const { data: conversation } = await supabase
        .from('conversations')
        .select('id')
        .eq('agent_id', agentId)
        .eq('contact_id', contact.id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!conversation) {
        return NextResponse.json({ conversationId: null, messages: [] }, { status: 200, headers: corsHeaders })
      }

      const { data: messages } = await supabase
        .from('messages')
        .select('id, role, content, created_at')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true })
        .limit(100)

      return NextResponse.json(
        { conversationId: conversation.id, messages: messages || [] },
        { status: 200, headers: corsHeaders }
      )
    }

    return NextResponse.json(
      { error: 'conversationId or agentId is required' },
      { status: 400, headers: corsHeaders }
    )
  } catch (error) {
    console.error('[api/chat/history] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    )
  }
}
