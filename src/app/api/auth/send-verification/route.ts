// Send email verification OTP via Resend
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(request: Request) {
  const { email, userId } = await request.json()
  if (!email || !userId) {
    return NextResponse.json({ error: 'email and userId required' }, { status: 400 })
  }

  // Skip verification in local dev
  if (process.env.SKIP_EMAIL_VERIFICATION === 'true') {
    const supabase = createAdminClient()
    await supabase.auth.admin.updateUserById(userId, { email_confirm: true })
    return NextResponse.json({ skipped: true })
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 min

  // Store OTP in user metadata
  const supabase = createAdminClient()
  await supabase.auth.admin.updateUserById(userId, {
    user_metadata: { verification_otp: otp, otp_expires_at: expiresAt },
  })

  // Send email
  const { error } = await resend.emails.send({
    from: 'Jordon AI <noreply@jordon.ai>',
    to: email,
    subject: 'Verify your email — Jordon AI',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">Verify your email</h2>
        <p style="color: #666; font-size: 14px; margin-bottom: 24px;">Enter this code to complete your signup:</p>
        <div style="background: #f5f5f5; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #0a0a0a;">${otp}</span>
        </div>
        <p style="color: #999; font-size: 12px;">This code expires in 10 minutes. If you didn't sign up for Jordon AI, ignore this email.</p>
      </div>
    `,
  })

  if (error) {
    console.error('[send-verification] Resend error:', error)
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 })
  }

  return NextResponse.json({ sent: true })
}
