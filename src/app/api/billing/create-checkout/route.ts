import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { razorpay, PLANS, type PlanKey } from '@/lib/razorpay'

export async function POST(request: Request) {
  try {
    if (!razorpay) {
      return NextResponse.json({ error: 'Payment not configured' }, { status: 500 })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: membership } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', user.id)
      .single()

    if (!membership) return NextResponse.json({ error: 'No organization found' }, { status: 403 })

    const body = await request.json()
    const plan = body.plan as PlanKey

    if (!plan || !PLANS[plan]) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const selectedPlan = PLANS[plan]

    // Get org info
    const { data: org } = await supabase
      .from('organizations')
      .select('id, name')
      .eq('id', membership.org_id)
      .single()

    if (!org) return NextResponse.json({ error: 'Organization not found' }, { status: 404 })

    if (selectedPlan.planId) {
      // Subscription mode — create a Razorpay subscription
      const subscription = await razorpay.subscriptions.create({
        plan_id: selectedPlan.planId,
        total_count: 12, // 12 months
        notes: { org_id: org.id, plan, org_name: org.name },
      })

      return NextResponse.json({
        subscriptionId: subscription.id,
        keyId: process.env.RAZORPAY_KEY_ID,
        plan,
        orgId: org.id,
        name: org.name,
        email: user.email,
      })
    } else {
      // One-time order fallback
      const order = await razorpay.orders.create({
        amount: selectedPlan.price,
        currency: 'INR',
        receipt: `order_${org.id}_${plan}_${Date.now()}`,
        notes: { org_id: org.id, plan, org_name: org.name },
      })

      return NextResponse.json({
        orderId: order.id,
        keyId: process.env.RAZORPAY_KEY_ID,
        amount: selectedPlan.price,
        plan,
        orgId: org.id,
        name: org.name,
        email: user.email,
      })
    }
  } catch (error) {
    console.error('Checkout error:', error)
    return NextResponse.json({ error: 'Failed to create checkout' }, { status: 500 })
  }
}
