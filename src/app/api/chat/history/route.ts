// ============================================================================
// GET /api/chat/history?conversationId=xxx
// Load conversation history for the widget
// ============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

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

    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversationId is required' },
        { status: 400, headers: corsHeaders }
      )
    }

    const supabase = createAdminClient()

    // Verify conversation exists
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

    // Load messages
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
      { messages: messages || [] },
      { status: 200, headers: corsHeaders }
    )
  } catch (error) {
    console.error('[api/chat/history] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    )
  }
}
