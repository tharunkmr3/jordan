import { createAdminClient } from '@/lib/supabase/admin'

export async function checkSubscription(orgId: string): Promise<{
  isSubscribed: boolean
  plan: string | null
  status: string | null
}> {
  const supabase = createAdminClient()

  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('plan, status')
    .eq('org_id', orgId)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!subscription) {
    return { isSubscribed: false, plan: null, status: null }
  }

  return {
    isSubscribed: true,
    plan: subscription.plan,
    status: subscription.status,
  }
}
