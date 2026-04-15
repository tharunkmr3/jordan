// Portal not needed for Razorpay — subscription management is handled in-app
import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json({ error: 'Use the billing page to manage your subscription' }, { status: 400 })
}
