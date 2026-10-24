import { pool } from '../db/pool.js'
import { requireAuth } from './auth.js'

export function requireDatabaseRole(...roles) {
  const authenticate = requireAuth
  return [authenticate, async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT u.user_id AS "userId", u.sap_id AS "sapId", u.email, u.role,
                e.employee_id AS "employeeId"
         FROM users u
         LEFT JOIN employees e ON e.user_id = u.user_id
         WHERE u.user_id = $1 AND u.is_active = TRUE`,
        [req.auth.sub],
      )
      const user = result.rows[0]
      if (!user) return res.status(401).json({ error: 'Account is no longer active' })
      if (!roles.includes(user.role)) return res.status(403).json({ error: 'Access denied' })
      req.currentUser = user
      return next()
    } catch (error) {
      return next(error)
    }
  }]
}
