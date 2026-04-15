// Verify reset OTP and update password
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const { email, otp, newPassword } = await request.json()
  if (!email || !otp || !newPassword) {
    return NextResponse.json({ error: 'email, otp, and newPassword required' }, { status: 400 })
  }

  if (newPassword.length < 6) {
    return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Find user
  const { data: { users } } = await supabase.auth.admin.listUsers()
  const user = users.find(u => u.email === email)

  if (!user) {
    return NextResponse.json({ error: 'Invalid code' }, { status: 400 })
  }

  const storedOtp = user.user_metadata?.reset_otp
  const expiresAt = user.user_metadata?.reset_otp_expires_at

  if (!storedOtp || !expiresAt) {
    return NextResponse.json({ error: 'No reset code found. Request a new one.' }, { status: 400 })
  }

  if (new Date(expiresAt) < new Date()) {
    return NextResponse.json({ error: 'Code expired. Request a new one.' }, { status: 400 })
  }

  if (storedOtp !== otp) {
    return NextResponse.json({ error: 'Invalid code' }, { status: 400 })
  }

  // Update password and clear OTP
  const { error } = await supabase.auth.admin.updateUserById(user.id, {
    password: newPassword,
    user_metadata: { reset_otp: null, reset_otp_expires_at: null },
  })

  if (error) {
    return NextResponse.json({ error: 'Failed to update password' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
