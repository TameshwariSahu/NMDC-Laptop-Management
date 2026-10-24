import { pool } from '../../db/pool.js'
import { isValidSapId, normalizeSapId } from '../../utils/sapId.js'

function bad(message) { return Object.assign(new Error(message), { status: 400 }) }
function pagination(query) {
  const limit = Number(query.limit ?? 25), offset = Number(query.offset ?? 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('limit must be between 1 and 100')
  if (!Number.isSafeInteger(offset) || offset < 0) throw bad('offset must be a non-negative integer')
  return { limit, offset }
}

export async function listReports(req, res, next) {
  try {
    const { limit, offset } = pagination(req.query)
    const where = [], values = []
    const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)) }
    if (req.query.status) {
      const allowed = ['PENDING_ENGINEER', 'NEEDS_EMPLOYEE_CORRECTION', 'PENDING_ADMIN', 'NEEDS_ENGINEER_CORRECTION', 'APPROVED']
      if (!allowed.includes(req.query.status)) throw bad('Invalid status filter')
      add('r.status = ?', req.query.status)
    }
    if (req.query.sapId) {
      const sapId = normalizeSapId(req.query.sapId)
      if (!isValidSapId(sapId)) throw bad('SAP ID must be exactly 8 characters')
      add('e.sap_id = ?', sapId)
    }
    if (req.query.from) { if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) throw bad('from must be YYYY-MM-DD'); add('r.created_at >= ?::date', req.query.from) }
    if (req.query.to) { if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) throw bad('to must be YYYY-MM-DD'); add('r.created_at < (?::date + INTERVAL \'1 day\')', req.query.to) }
    if (req.query.duplicateOnly === 'true') where.push('r.license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests d WHERE d.license_key_hmac = r.license_key_hmac AND d.request_id <> r.request_id)')
    else if (req.query.duplicateOnly && req.query.duplicateOnly !== 'false') throw bad('duplicateOnly must be true or false')
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const pageValues = [...values, limit, offset]
    const [items, count] = await Promise.all([
      pool.query(`SELECT r.request_id AS "requestId", r.serial_number AS "serialNumber", r.purchase_date AS "purchaseDate",
        r.model_number AS "modelNumber", r.mac_address AS "macAddress", r.operating_system AS "operatingSystem", r.status,
        r.created_at AS "createdAt", e.employee_name AS "employeeName", e.sap_id AS "employeeSapId",
        (r.license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests d WHERE d.license_key_hmac=r.license_key_hmac AND d.request_id<>r.request_id)) AS "duplicateLicenseWarning"
        FROM laptop_requests r JOIN employees e ON e.employee_id=r.owner_employee_id ${clause}
        ORDER BY r.created_at DESC, r.request_id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, pageValues),
      pool.query(`SELECT COUNT(*)::INTEGER AS total FROM laptop_requests r JOIN employees e ON e.employee_id=r.owner_employee_id ${clause}`, values),
    ])
    return res.json({ reports: items.rows, pagination: { limit, offset, total: count.rows[0].total } })
  } catch (error) { return next(error) }
}
