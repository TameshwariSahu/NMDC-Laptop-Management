import { pool } from '../../db/pool.js'
import { createAuditWorkbook } from '../reports/reports.xlsx.js'

const ACTION_LABELS = Object.freeze({
  account_created: 'Account created', account_updated: 'Account updated',
  account_profile_created: 'Account profile created', account_profile_updated: 'Account profile updated',
  registered_on_behalf: 'Laptop registered on behalf', laptop_request_submitted: 'Laptop request submitted',
  laptop_request_edited: 'Laptop request edited', employee_resubmitted: 'Employee correction submitted',
  correction_resubmitted: 'Correction submitted', engineer_approved: 'Engineer approved',
  engineer_rejected: 'Engineer rejected', admin_approved: 'Admin approved', admin_rejected: 'Admin rejected',
  invoice_replaced: 'Invoice replaced', report_exported: 'Report exported', audit_exported: 'Audit exported',
  retirement_clearance_created: 'Retirement clearance created',
  retirement_clearance_finalized: 'Retirement clearance completed',
  retirement_check_added: 'Clearance check added', retirement_check_updated: 'Clearance check updated',
  retirement_check_deleted: 'Clearance check deleted',
})
const SAFE_CHANGE_FIELDS = new Set([
  'serialNumber', 'purchaseDate', 'modelNumber', 'macAddress', 'operatingSystem',
  'msOfficeAccountEmail', 'employeeName', 'designation', 'employeeCategory', 'department',
  'sapId', 'email', 'role', 'isActive', 'windowsKey', 'officeKey',
])
const SAFE_STATUSES = new Set(['PENDING_ENGINEER','NEEDS_EMPLOYEE_CORRECTION','PENDING_ADMIN','NEEDS_ENGINEER_CORRECTION','APPROVED'])

function bad(message) { return Object.assign(new Error(message), { status: 400 }) }
function dateFilter(value, name) {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw bad(`${name} must be YYYY-MM-DD`)
  return value
}
function readFilters(query) {
  const filters = { sapId: null, action: null, from: dateFilter(query.from, 'from'), to: dateFilter(query.to, 'to') }
  const where = [], values = []
  const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)) }
  if (query.sapId) {
    const sapId = String(query.sapId).trim().toUpperCase()
    if (!/^[A-Z0-9]{1,40}$/.test(sapId)) throw bad('SAP ID filter is invalid')
    filters.sapId = sapId
    add('upper(al.actor_sap_id) = ?', sapId)
  }
  if (query.action) {
    const action = String(query.action).trim()
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(action)) throw bad('Action filter is invalid')
    filters.action = action
    add('al.action = ?', action)
  }
  if (filters.from) add('al.occurred_at >= ?::date', filters.from)
  if (filters.to) add("al.occurred_at < (?::date + INTERVAL '1 day')", filters.to)
  return { filters, values, clause: where.length ? `WHERE ${where.join(' AND ')}` : '' }
}
function readPage(query) {
  const limit = Number(query.limit ?? 25), offset = Number(query.offset ?? 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw bad('Invalid pagination')
  return { limit, offset }
}
function publicChanges(details) {
  const raw = details?.changes
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const safe = {}
  for (const [field, change] of Object.entries(raw)) {
    if (!SAFE_CHANGE_FIELDS.has(field)) continue
    if (field === 'windowsKey' || field === 'officeKey') {
      if (change === 'changed') safe[field] = 'changed'
      continue
    }
    if (!change || typeof change !== 'object' || Array.isArray(change)) continue
    const { old, new: next } = change
    if ((old === null || ['string', 'number', 'boolean'].includes(typeof old))
        && (next === null || ['string', 'number', 'boolean'].includes(typeof next))) safe[field] = { old, new: next }
  }
  return safe
}
function readableAction(action) {
  return ACTION_LABELS[action] ?? String(action).split(/[_-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}
function mapRow(row) {
  let who = 'Unknown (legacy)'
  const sapId = row.actorSapId?.trim()
  if (['SYSTEM', 'BOOTSTRAP'].includes(sapId?.toUpperCase())) who = 'System'
  else if (sapId) who = row.actorName ? `${row.actorName} (${sapId})` : sapId
  let affectedRecord = 'Record'
  if (row.entityType === 'laptop_request') {
    affectedRecord = [row.serialNumber, row.employeeName, row.modelNumber].filter(Boolean).join(' · ') || 'Laptop request'
  } else if (row.entityType === 'user') affectedRecord = row.targetName || 'Account'
  else if (row.entityType === 'retirement_clearance') affectedRecord = row.clearanceEmployeeName || 'Retirement clearance'
  else if (row.entityType === 'retirement_clearance_check') affectedRecord = row.checkEmployeeName || 'Retirement clearance check'
  else if (row.entityType === 'report') affectedRecord = 'Reports'
  return {
    occurredAt: row.occurredAt, who, actorSapId: sapId ?? null,
    action: row.action, actionLabel: readableAction(row.action), affectedRecord,
    entityType: row.entityType, changes: publicChanges(row.details),
    changedFields: Array.isArray(row.details?.changedFields)
      ? row.details.changedFields.filter((field) => typeof field === 'string' && SAFE_CHANGE_FIELDS.has(field))
      : [],
    oldStatus: SAFE_STATUSES.has(row.details?.oldStatus) ? row.details.oldStatus : null,
    newStatus: SAFE_STATUSES.has(row.details?.newStatus) ? row.details.newStatus : null,
  }
}

const FROM_SQL = `FROM audit_log al
  LEFT JOIN employees actor_profile ON upper(actor_profile.sap_id)=upper(al.actor_sap_id)
  LEFT JOIN laptop_requests lr ON al.entity_type='laptop_request' AND lr.request_id::text=al.entity_id
  LEFT JOIN employees owner_profile ON owner_profile.employee_id=lr.owner_employee_id
  LEFT JOIN users target_user ON al.entity_type='user' AND target_user.user_id::text=al.entity_id
  LEFT JOIN employees target_profile ON target_profile.user_id=target_user.user_id
  LEFT JOIN retirement_clearances rc ON al.entity_type='retirement_clearance' AND rc.clearance_id::text=al.entity_id
  LEFT JOIN employees clearance_profile ON clearance_profile.employee_id=rc.employee_id
  LEFT JOIN retirement_clearance_checks rcc ON al.entity_type='retirement_clearance_check' AND rcc.check_id::text=al.entity_id
  LEFT JOIN retirement_clearances check_clearance ON check_clearance.clearance_id=rcc.clearance_id
  LEFT JOIN employees check_clearance_profile ON check_clearance_profile.employee_id=check_clearance.employee_id`
const SELECT_SQL = `SELECT al.occurred_at AS "occurredAt", al.actor_sap_id AS "actorSapId",
  actor_profile.employee_name AS "actorName", al.action, al.entity_type AS "entityType", al.details,
  lr.serial_number AS "serialNumber", owner_profile.employee_name AS "employeeName", lr.model_number AS "modelNumber",
  target_profile.employee_name AS "targetName", clearance_profile.employee_name AS "clearanceEmployeeName",
  check_clearance_profile.employee_name AS "checkEmployeeName" ${FROM_SQL}`

async function selectRows(queryable, clause, values, page = null) {
  const suffix = page ? ` ORDER BY al.occurred_at DESC,al.audit_log_id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}` : ' ORDER BY al.occurred_at DESC,al.audit_log_id DESC'
  const params = page ? [...values, page.limit, page.offset] : values
  const result = await queryable.query(`${SELECT_SQL} ${clause}${suffix}`, params)
  return result.rows.map(mapRow)
}

export async function listAudit(req, res, next) {
  try {
    const page = readPage(req.query), { clause, values } = readFilters(req.query)
    const [entries, total] = await Promise.all([
      selectRows(pool, clause, values, page),
      pool.query(`SELECT COUNT(*)::INTEGER AS total ${FROM_SQL} ${clause}`, values),
    ])
    return res.json({ entries, pagination: { ...page, total: total.rows[0].total } })
  } catch (error) { return next(error) }
}

export async function exportAuditExcel(req, res, next) {
  const client = await pool.connect()
  try {
    const { clause, values, filters } = readFilters(req.query)
    await client.query('BEGIN')
    const entries = await selectRows(client, clause, values)
    const workbook = createAuditWorkbook(entries)
    await client.query(`INSERT INTO audit_log(actor_user_id,actor_sap_id,action,entity_type,details)
      VALUES($1,$2,'audit_exported','audit_log',$3::jsonb)`, [req.currentUser.userId, req.currentUser.sapId, JSON.stringify({ filters })])
    await client.query('COMMIT')
    const date = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="audit-${date}.xlsx"`)
    res.setHeader('Content-Length', workbook.length)
    return res.send(workbook)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    return next(error)
  } finally { client.release() }
}
