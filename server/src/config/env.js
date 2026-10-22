import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const configDirectory = dirname(fileURLToPath(import.meta.url))
// Prefer the workspace-level .env, which is where the frontend project already expects it.
dotenv.config({ path: resolve(configDirectory, '../../../.env') })
// Keep server/.env supported for users who prefer an API-local environment file.
dotenv.config({ path: resolve(configDirectory, '../../.env'), override: false })

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 10),
  otpMaxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),
  authExposeOtp: process.env.AUTH_EXPOSE_OTP === 'true',
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
  },
}

if (!env.databaseUrl) throw new Error('DATABASE_URL is required')
if (!env.jwtSecret || env.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to at least 32 characters')
}
