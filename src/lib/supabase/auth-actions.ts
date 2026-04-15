'use server'

import { redirect } from 'next/navigation'
import { createClient } from './server'

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}

export async function getCurrentUser() {
  const supabase = await createClient()

  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('*, organizations(*)')
    .eq('user_id', user.id)
    .single()

  return {
    ...user,
    membership: membership ?? null,
  }
}

export async function getCurrentOrg() {
  const supabase = await createClient()

  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) return null

  const { data: org } = await supabase
    .from('organizations')
    .select('*')
    .eq('id', membership.org_id)
    .single()

  return org
}
