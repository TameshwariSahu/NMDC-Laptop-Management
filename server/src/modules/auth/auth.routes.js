import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requestOtp, verifyOtp, getCurrentUser } from './auth.controller.js'
import { requireAuth } from '../../middleware/auth.js'

const router = Router()
const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false })
router.post('/request-otp', otpLimiter, requestOtp)
router.post('/verify-otp', otpLimiter, verifyOtp)
router.get('/me', requireAuth, getCurrentUser)
export default router
