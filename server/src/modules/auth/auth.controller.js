import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { pool } from '../../db/pool.js'
import { env } from '../../config/env.js'
import { sendLoginOtp } from '../../services/otpEmail.js'
import { isValidSapId, normalizeSapId } from '../../utils/sapId.js'

const hashOtp = (otp) => createHash('sha256').update(otp).digest('hex')

export async function requestOtp(req, res, next) {
  const sapId = normalizeSapId(req.body?.sapId)
  if (!isValidSapId(sapId)) return res.status(400).json({ error: 'SAP ID must be exactly 8 characters' })
  try {
    const { rows } = await pool.query(
      `SELECT user_id, email FROM users WHERE upper(sap_id) = $1 AND is_active = TRUE`, [sapId],
    )
    if (!rows[0]) return res.status(404).json({ error: 'Account does not exist. Please contact the admin.' })

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = new Date(Date.now() + env.otpTtlMinutes * 60_000)
    await pool.query('UPDATE login_otps SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL', [rows[0].user_id])
    await pool.query('INSERT INTO login_otps (user_id, otp_hash, expires_at) VALUES ($1, $2, $3)', [rows[0].user_id, hashOtp(otp), expiresAt])
    await sendLoginOtp(rows[0].email, otp)
    return res.json({ message: 'A login code has been sent to your registered email.' })
  } catch (error) {
    return next(error)
  }
}

export async function verifyOtp(req, res, next) {
  const sapId = normalizeSapId(req.body?.sapId)
  const otp = String(req.body?.otp ?? '').trim()
  if (!isValidSapId(sapId) || !/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Enter an 8-character SAP ID and six-digit code' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const userResult = await client.query(
      'SELECT user_id, sap_id, email, role FROM users WHERE upper(sap_id) = $1 AND is_active = TRUE FOR UPDATE', [sapId],
    )
    const user = userResult.rows[0]
    if (!user) {
      await client.query('ROLLBACK')
      return res.status(401).json({ error: 'Invalid or expired login code' })
    }
    const otpResult = await client.query(
      `SELECT otp_id, otp_hash FROM login_otps
       WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW() AND attempts < $2
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [user.user_id, env.otpMaxAttempts],
    )
    const record = otpResult.rows[0]
    const submittedHash = Buffer.from(hashOtp(otp))
    const storedHash = record ? Buffer.from(record.otp_hash) : Buffer.alloc(64)
    const matches = timingSafeEqual(submittedHash, storedHash) && Boolean(record)
    if (!record || !matches) {
      if (record) await client.query('UPDATE login_otps SET attempts = attempts + 1 WHERE otp_id = $1', [record.otp_id])
      await client.query('COMMIT')
      return res.status(401).json({ error: 'Invalid or expired login code' })
    }

    await client.query('UPDATE login_otps SET consumed_at = NOW() WHERE otp_id = $1', [record.otp_id])
    const employeeResult = await client.query('SELECT employee_id, employee_name, designation, employee_category, department FROM employees WHERE user_id = $1', [user.user_id])
    await client.query('COMMIT')
    const token = jwt.sign({ sub: user.user_id, role: user.role, sapId: user.sap_id }, env.jwtSecret, { expiresIn: '8h', issuer: 'laptop-management-api' })
    return res.json({ token, user: { userId: user.user_id, sapId: user.sap_id, email: user.email, role: user.role, employee: employeeResult.rows[0] ?? null } })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    return next(error)
  } finally {
    client.release()
  }
}

export async function getCurrentUser(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id AS "userId", u.sap_id AS "sapId", u.email, u.role,
        e.employee_id AS "employeeId", e.employee_name AS "employeeName", e.designation,
        e.employee_category AS "employeeCategory", e.department
       FROM users u LEFT JOIN employees e ON e.user_id = u.user_id WHERE u.user_id = $1 AND u.is_active = TRUE`, [req.auth.sub],
    )
    if (!rows[0]) return res.status(401).json({ error: 'Account is no longer active' })
    return res.json({ user: rows[0] })
  } catch (error) {
    return next(error)
  }
}
