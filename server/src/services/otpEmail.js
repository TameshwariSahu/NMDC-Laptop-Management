import nodemailer from 'nodemailer'
import { env } from '../config/env.js'

function createTransport() {
  const { host, port, secure, user, pass } = env.smtp
  if (!host || !user || !pass) return null
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } })
}

export async function sendLoginOtp(email, otp) {
  const transport = createTransport()
  if (!transport) {
    if (env.nodeEnv !== 'production' && env.authExposeOtp) {
      console.info(`[development] Login OTP for ${email}: ${otp}`)
      return
    }
    throw new Error('Email delivery is not configured')
  }

  await transport.sendMail({
    from: env.smtp.from || env.smtp.user,
    to: email,
    subject: 'Your Laptop Management System login code',
    text: `Your login code is ${otp}. It expires in ${env.otpTtlMinutes} minutes. If you did not request it, ignore this email.`,
  })
}
