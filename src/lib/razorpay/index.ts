import Razorpay from 'razorpay'

export const razorpay = process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    })
  : null

export const PLANS = {
  starter: {
    name: 'Starter',
    price: 1500000, // ₹15,000 in paise
    planId: process.env.RAZORPAY_STARTER_PLAN_ID || '',
    features: ['500 conversations/mo', '1 AI agent', 'English + 2 languages', 'Email support'],
  },
  growth: {
    name: 'Growth',
    price: 3500000, // ₹35,000 in paise
    planId: process.env.RAZORPAY_GROWTH_PLAN_ID || '',
    features: ['2,000 conversations/mo', 'All channels', 'All languages', 'Priority support'],
  },
} as const

export type PlanKey = keyof typeof PLANS
