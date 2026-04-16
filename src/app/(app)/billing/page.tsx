'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PLANS, type PlanKey } from '@/lib/razorpay'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import type { Subscription } from '@/types/database'

interface OrgData {
  id: string
  name: string
  plan: string
}

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open: () => void }
  }
}

export default function BillingPage() {
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [org, setOrg] = useState<OrgData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  useEffect(() => {
    // Load Razorpay script
    if (!document.getElementById('razorpay-script')) {
      const script = document.createElement('script')
      script.id = 'razorpay-script'
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      document.body.appendChild(script)
    }

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
        .select('id, name, plan')
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

      if (data.error) {
        alert(data.error)
        setActionLoading(null)
        return
      }

      const options: Record<string, unknown> = {
        key: data.keyId,
        name: 'Jordon AI',
        description: `${PLANS[plan].name} Plan`,
        prefill: { email: data.email, contact: '' },
        notes: { org_id: data.orgId, plan },
        theme: { color: '#1f1f1f' },
        handler: async (response: { razorpay_payment_id: string; razorpay_subscription_id?: string; razorpay_signature: string; razorpay_order_id?: string }) => {
          // Verify payment on server
          const verifyRes = await fetch('/api/billing/verify-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...response,
              plan,
              orgId: data.orgId,
            }),
          })
          if (verifyRes.ok) {
            window.location.reload()
          } else {
            alert('Payment verification failed. Please contact support.')
          }
        },
      }

      if (data.subscriptionId) {
        options.subscription_id = data.subscriptionId
      } else if (data.orderId) {
        options.order_id = data.orderId
        options.amount = data.amount
        options.currency = 'INR'
      }

      const rzp = new window.Razorpay(options)
      rzp.open()
    } catch (error) {
      console.error('Checkout error:', error)
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
          <h1 className="text-[15px] font-semibold text-[#1f1f1f]">Billing</h1>
        </div>
        <Card className="mb-6">
          <CardHeader>
            <Skeleton className="h-4 w-24 mb-2" />
            <Skeleton className="h-3 w-48" />
          </CardHeader>
        </Card>
        <Separator className="mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map(i => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-20 mb-2" />
                <Skeleton className="h-6 w-32" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-4/6" />
                <Skeleton className="h-3 w-full" />
              </CardContent>
              <CardFooter>
                <Skeleton className="h-9 w-full" />
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-[15px] font-semibold text-[#1f1f1f]">Billing</h1>
      </div>

      {/* Current Plan Status */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-[14px]">Current Plan</CardTitle>
          <CardDescription className="text-[12px]">
            {isActive
              ? `You are on the ${PLANS[currentPlan as PlanKey]?.name || currentPlan} plan`
              : 'You are on the Free plan'}
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
            <Card key={key} className={isCurrent ? 'border-[#1f1f1f]' : ''}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-[14px]">{plan.name}</CardTitle>
                  {isCurrent && <Badge>Current</Badge>}
                </div>
                <CardDescription className="text-[12px]">
                  <span className="text-[20px] font-semibold text-[#1f1f1f]">
                    {'\u20B9'}{(plan.price / 100).toLocaleString('en-IN')}
                  </span>
                  <span className="text-[#737373]">/month</span>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2 text-[12px] text-[#525252]">
                      <svg className="h-3.5 w-3.5 text-[#1f1f1f] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                {isCurrent ? (
                  <Button className="w-full" variant="outline" disabled>
                    Current Plan
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    onClick={() => handleSubscribe(key)}
                    disabled={actionLoading === key}
                  >
                    {actionLoading === key ? 'Loading...' : 'Subscribe'}
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
