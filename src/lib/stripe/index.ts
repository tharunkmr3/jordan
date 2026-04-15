import Stripe from 'stripe'

export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-03-25.dahlia' })
  : null as unknown as Stripe // Stripe not configured yet

export const PLANS = {
  starter: {
    name: 'Starter',
    price: 1500000, // ₹15,000 in paise
    priceId: process.env.STRIPE_STARTER_PRICE_ID || '',
    features: ['500 conversations/mo', '1 AI agent', 'English + 2 languages', 'Email support'],
  },
  growth: {
    name: 'Growth',
    price: 3500000, // ₹35,000 in paise
    priceId: process.env.STRIPE_GROWTH_PRICE_ID || '',
    features: ['2,000 conversations/mo', 'All channels', 'All languages', 'Priority support'],
  },
} as const

export type PlanKey = keyof typeof PLANS
