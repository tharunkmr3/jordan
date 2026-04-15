// Razorpay webhook handler
import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import crypto from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(request: Request) {
  try {
    const body = await request.text()
    const headersList = await headers()
    const signature = headersList.get('x-razorpay-signature')

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
    }

    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!)
      .update(body)
      .digest('hex')

    if (expectedSignature !== signature) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
    }

    const event = JSON.parse(body)
    const supabase = createAdminClient()

    // Log webhook
    await supabase.from('webhook_events').insert({
      source: 'stripe' as const, // reusing the enum for now
      event_type: event.event,
      payload: event.payload,
      processed: true,
    })

    switch (event.event) {
      case 'subscription.activated':
      case 'subscription.charged': {
        const sub = event.payload.subscription?.entity
        if (!sub) break
        const orgId = sub.notes?.org_id
        const plan = sub.notes?.plan
        if (orgId && plan) {
          await supabase.from('subscriptions')
            .update({ status: 'active' })
            .eq('stripe_subscription_id', sub.id)

          await supabase.from('organizations')
            .update({ plan })
            .eq('id', orgId)
        }
        break
      }

      case 'subscription.cancelled':
      case 'subscription.completed': {
        const sub = event.payload.subscription?.entity
        if (!sub) break
        const orgId = sub.notes?.org_id
        await supabase.from('subscriptions')
          .update({ status: 'cancelled', cancel_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id)

        if (orgId) {
          await supabase.from('organizations')
            .update({ plan: 'free', stripe_subscription_id: null })
            .eq('id', orgId)
        }
        break
      }

      case 'payment.failed': {
        const payment = event.payload.payment?.entity
        if (!payment) break
        const notes = payment.notes || {}
        if (notes.org_id) {
          await supabase.from('subscriptions')
            .update({ status: 'past_due' })
            .eq('org_id', notes.org_id)
            .eq('status', 'active')
        }
        break
      }

      default:
        console.log('Unhandled Razorpay webhook:', event.event)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Razorpay webhook error:', error)
    return NextResponse.json({ error: 'Webhook failed' }, { status: 500 })
  }
}
