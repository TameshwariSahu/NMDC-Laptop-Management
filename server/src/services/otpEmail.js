import nodemailer from 'nodemailer'
import { env } from '../config/env.js'

const SENDER_NAME = 'NMDC Laptop Management System'
const SUBJECT = 'NMDC Laptop Management System: Login OTP'

function createTransport() {
  const { host, port, secure, user, pass } = env.smtp
  if (!host || !user || !pass) return null
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } })
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export async function sendLoginOtp(email, otp, transportFactory = createTransport) {
  const transport = transportFactory()
  if (!transport) throw new Error('Email delivery is not configured')

  const safeOtp = escapeHtml(otp)
  const text = [
    'Dear Employee,',
    '',
    'Your login OTP is:',
    String(otp),
    '',
    'This OTP is valid for 10 minutes and can be used only once.',
    'Do not share it with anyone.',
    'If you did not request this OTP, please ignore this email or contact the administrator.',
    '',
    SENDER_NAME,
  ].join('\n')
  const html = `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #202938; line-height: 1.5;">
    <p>Dear Employee,</p>
    <p>Your login OTP is:</p>
    <p style="font-size: 30px; font-weight: 700; letter-spacing: 5px; margin: 12px 0;"><strong>${safeOtp}</strong></p>
    <p>This OTP is valid for 10 minutes and can be used only once.</p>
    <p>Do not share it with anyone.</p>
    <p>If you did not request this OTP, please ignore this email or contact the administrator.</p>
    <p>${SENDER_NAME}</p>
  </body>
</html>`

  await transport.sendMail({
    from: { name: SENDER_NAME, address: env.smtp.from || env.smtp.user },
    to: email,
    subject: SUBJECT,
    text,
    html,
  })
}
