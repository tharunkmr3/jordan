// Verify email OTP
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const { userId, otp } = await request.json()
  if (!userId || !otp) {
    return NextResponse.json({ error: 'userId and otp required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Get user metadata
  const { data: { user }, error } = await supabase.auth.admin.getUserById(userId)
  if (error || !user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const storedOtp = user.user_metadata?.verification_otp
  const expiresAt = user.user_metadata?.otp_expires_at

  if (!storedOtp || !expiresAt) {
    return NextResponse.json({ error: 'No verification code found. Request a new one.' }, { status: 400 })
  }

  if (new Date(expiresAt) < new Date()) {
    return NextResponse.json({ error: 'Code expired. Request a new one.' }, { status: 400 })
  }

  if (storedOtp !== otp) {
    return NextResponse.json({ error: 'Invalid code' }, { status: 400 })
  }

  // Mark email as confirmed and clear OTP
  await supabase.auth.admin.updateUserById(userId, {
    email_confirm: true,
    user_metadata: { verification_otp: null, otp_expires_at: null },
  })

  return NextResponse.json({ verified: true })
}
