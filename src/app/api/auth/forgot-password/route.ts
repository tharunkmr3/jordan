// Send password reset OTP via Resend
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(request: Request) {
  const { email } = await request.json()
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Find user by email
  const { data: { users } } = await supabase.auth.admin.listUsers()
  const user = users.find(u => u.email === email)

  if (!user) {
    // Don't reveal if user exists — still return success
    return NextResponse.json({ sent: true })
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  // Store in user metadata
  await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: { reset_otp: otp, reset_otp_expires_at: expiresAt },
  })

  // Send email
  const { error } = await resend.emails.send({
    from: 'Jordon AI <noreply@jordon.ai>',
    to: email,
    subject: 'Reset your password — Jordon AI',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">Reset your password</h2>
        <p style="color: #666; font-size: 14px; margin-bottom: 24px;">Enter this code to reset your password:</p>
        <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #0a0a0a;">${otp}</span>
        </div>
        <p style="color: #999; font-size: 12px;">This code expires in 10 minutes. If you didn't request a password reset, ignore this email.</p>
      </div>
    `,
  })

  if (error) {
    console.error('[forgot-password] Resend error:', error)
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 })
  }

  return NextResponse.json({ sent: true })
}
