import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import Stripe from 'stripe'
import { stripe } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const supabase = createAdminClient()
  const orgId = session.metadata?.org_id
  const plan = session.metadata?.plan as 'starter' | 'growth'

  if (!orgId || !plan) {
    console.error('Missing metadata in checkout session:', session.id)
    return
  }

  const subscriptionId = session.subscription as string

  // Fetch full subscription details from Stripe
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)

  // Create subscription record
  const firstItem = subscription.items.data[0]
  await supabase.from('subscriptions').insert({
    org_id: orgId,
    stripe_subscription_id: subscriptionId,
    stripe_price_id: firstItem?.price.id || null,
    plan,
    status: 'active',
    current_period_start: firstItem ? new Date(firstItem.current_period_start * 1000).toISOString() : null,
    current_period_end: firstItem ? new Date(firstItem.current_period_end * 1000).toISOString() : null,
  })

  // Update organization
  await supabase
    .from('organizations')
    .update({
      plan,
      stripe_subscription_id: subscriptionId,
    })
    .eq('id', orgId)
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const supabase = createAdminClient()
  const orgId = subscription.metadata?.org_id

  if (!orgId) {
    console.error('Missing org_id in subscription metadata:', subscription.id)
    return
  }

  const status = subscription.status === 'active'
    ? 'active'
    : subscription.status === 'past_due'
      ? 'past_due'
      : subscription.status === 'trialing'
        ? 'trialing'
        : 'cancelled'

  const subItem = subscription.items.data[0]
  await supabase
    .from('subscriptions')
    .update({
      status,
      stripe_price_id: subItem?.price.id || null,
      current_period_start: subItem ? new Date(subItem.current_period_start * 1000).toISOString() : null,
      current_period_end: subItem ? new Date(subItem.current_period_end * 1000).toISOString() : null,
    })
    .eq('stripe_subscription_id', subscription.id)
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const supabase = createAdminClient()
  const orgId = subscription.metadata?.org_id

  await supabase
    .from('subscriptions')
    .update({
      status: 'cancelled',
      cancel_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id)

  if (orgId) {
    await supabase
      .from('organizations')
      .update({ plan: 'free', stripe_subscription_id: null })
      .eq('id', orgId)
  }
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const supabase = createAdminClient()
  const subscriptionId = invoice.parent?.subscription_details?.subscription as string | undefined

  if (!subscriptionId) return

  await supabase
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('stripe_subscription_id', subscriptionId)
}

export async function POST(request: Request) {
  try {
    const body = await request.text()
    const headersList = await headers()
    const signature = headersList.get('stripe-signature')

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
    }

    let event: Stripe.Event

    try {
      event = stripe.webhooks.constructEvent(
        body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch (err) {
      console.error('Webhook signature verification failed:', err)
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
    }

    // Log webhook event
    const supabase = createAdminClient()
    await supabase.from('webhook_events').insert({
      source: 'stripe',
      event_type: event.type,
      payload: event.data.object as unknown as Record<string, unknown>,
      processed: true,
    })

    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
        break
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
        break
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
        break
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice)
        break
      default:
        console.log('Unhandled webhook event:', event.type)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 })
  }
}
