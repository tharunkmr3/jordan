// Verify Razorpay payment and activate subscription
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import crypto from 'crypto'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json()
    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
      razorpay_order_id,
      plan,
      orgId,
    } = body

    // Verify signature
    const secret = process.env.RAZORPAY_KEY_SECRET!
    let expectedSignature: string

    if (razorpay_subscription_id) {
      // Subscription payment
      expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
        .digest('hex')
    } else {
      // One-time order payment
      expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex')
    }

    if (expectedSignature !== razorpay_signature) {
      return NextResponse.json({ error: 'Payment verification failed' }, { status: 400 })
    }

    // Save subscription/payment to DB
    const admin = createAdminClient()

    await admin.from('subscriptions').insert({
      org_id: orgId,
      stripe_subscription_id: razorpay_subscription_id || razorpay_payment_id, // reuse field
      stripe_price_id: razorpay_payment_id, // store payment ID
      plan,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })

    // Update org plan
    await admin
      .from('organizations')
      .update({
        plan,
        stripe_subscription_id: razorpay_subscription_id || razorpay_payment_id,
      })
      .eq('id', orgId)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Payment verification error:', error)
    return NextResponse.json({ error: 'Payment verification failed' }, { status: 500 })
  }
}
