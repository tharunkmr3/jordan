'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PLANS, type PlanKey } from '@/lib/stripe'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { Subscription } from '@/types/database'

interface OrgData {
  id: string
  name: string
  plan: string
  stripe_customer_id: string | null
}

export default function BillingPage() {
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [org, setOrg] = useState<OrgData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  useEffect(() => {
    async function fetchBillingData() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: membership } = await supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', user.id)
        .single()

      if (!membership) return

      const { data: orgData } = await supabase
        .from('organizations')
        .select('id, name, plan, stripe_customer_id')
        .eq('id', membership.org_id)
        .single()

      if (orgData) setOrg(orgData as OrgData)

      const { data: sub } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('org_id', membership.org_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (sub) setSubscription(sub as Subscription)
      setLoading(false)
    }

    fetchBillingData()
  }, [])

  async function handleSubscribe(plan: PlanKey) {
    setActionLoading(plan)
    try {
      const res = await fetch('/api/billing/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      }
    } catch (error) {
      console.error('Checkout error:', error)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleManageBilling() {
    setActionLoading('portal')
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      }
    } catch (error) {
      console.error('Portal error:', error)
    } finally {
      setActionLoading(null)
    }
  }

  const isActive = subscription?.status === 'active' || subscription?.status === 'trialing'
  const currentPlan = isActive ? subscription?.plan : null

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-[15px] font-semibold text-[#0a0a0a]">Billing</h1>
        </div>
        <div className="flex items-center justify-center py-24">
          <div className="text-[13px] text-[#a3a3a3]">Loading...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-[15px] font-semibold text-[#0a0a0a]">Billing</h1>
        {isActive && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleManageBilling}
            disabled={actionLoading === 'portal'}
          >
            {actionLoading === 'portal' ? 'Loading...' : 'Manage Subscription'}
          </Button>
        )}
      </div>

      {/* Current Plan Status */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-[14px]">Current Plan</CardTitle>
          <CardDescription className="text-[12px]">
            {isActive
              ? `You are on the ${PLANS[currentPlan as PlanKey]?.name || currentPlan} plan`
              : 'You are on the Free Trial'}
          </CardDescription>
        </CardHeader>
        {isActive && subscription && (
          <CardContent>
            <div className="flex items-center gap-2 text-[12px] text-[#737373]">
              <Badge variant={subscription.status === 'active' ? 'default' : 'secondary'}>
                {subscription.status}
              </Badge>
              {subscription.current_period_end && (
                <span>
                  Renews {new Date(subscription.current_period_end).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </span>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      <Separator className="mb-6" />

      {/* Plan Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(Object.entries(PLANS) as [PlanKey, typeof PLANS[PlanKey]][]).map(([key, plan]) => {
          const isCurrent = currentPlan === key
          return (
            <Card key={key} className={isCurrent ? 'border-[#0a0a0a]' : ''}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-[14px]">{plan.name}</CardTitle>
                  {isCurrent && <Badge>Current</Badge>}
                </div>
                <CardDescription className="text-[12px]">
                  <span className="text-[20px] font-semibold text-[#0a0a0a]">
                    {'\u20B9'}{(plan.price / 100).toLocaleString('en-IN')}
                  </span>
                  <span className="text-[#737373]">/month</span>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2 text-[12px] text-[#525252]">
                      <svg className="h-3.5 w-3.5 text-[#0a0a0a] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                {isCurrent ? (
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={handleManageBilling}
                    disabled={actionLoading === 'portal'}
                  >
                    Manage Plan
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    onClick={() => handleSubscribe(key)}
                    disabled={actionLoading === key}
                  >
                    {actionLoading === key ? 'Redirecting...' : 'Subscribe'}
                  </Button>
                )}
              </CardFooter>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
