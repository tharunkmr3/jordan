// ============================================================================
// Jordon AI Platform — Setup Organization on Signup
// Uses service role to bypass RLS — called after auth.signUp succeeds
// ============================================================================

import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const { userId, fullName, email } = await request.json()

  if (!userId || !email) {
    return NextResponse.json({ error: 'userId and email are required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Check if user already has an org (idempotent)
  const { data: existingMember } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle()

  if (existingMember) {
    return NextResponse.json({ orgId: existingMember.org_id, message: 'Organization already exists' })
  }

  // Create organization
  const slug = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString(36)
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .insert({
      name: fullName ? `${fullName}'s Organization` : 'My Organization',
      slug,
    })
    .select('id')
    .single()

  if (orgError) {
    console.error('[setup-org] Failed to create org:', orgError)
    return NextResponse.json({ error: 'Failed to create organization' }, { status: 500 })
  }

  // Add user as owner
  const { error: memberError } = await supabase
    .from('org_members')
    .insert({
      org_id: org.id,
      user_id: userId,
      role: 'owner',
    })

  if (memberError) {
    console.error('[setup-org] Failed to add member:', memberError)
    // Clean up the org we just created
    await supabase.from('organizations').delete().eq('id', org.id)
    return NextResponse.json({ error: 'Failed to set up membership' }, { status: 500 })
  }

  return NextResponse.json({ orgId: org.id }, { status: 201 })
}
