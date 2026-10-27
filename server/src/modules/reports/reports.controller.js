import { pool } from '../../db/pool.js'
import { isValidSapId, normalizeSapId } from '../../utils/sapId.js'
import { createReportWorkbook } from './reports.xlsx.js'

const REPORT_STATUSES = ['PENDING_ENGINEER', 'NEEDS_EMPLOYEE_CORRECTION', 'PENDING_ADMIN', 'NEEDS_ENGINEER_CORRECTION', 'APPROVED']

function bad(message) { return Object.assign(new Error(message), { status: 400 }) }

function pagination(query) {
  const limit = Number(query.limit ?? 25), offset = Number(query.offset ?? 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('limit must be between 1 and 100')
  if (!Number.isSafeInteger(offset) || offset < 0) throw bad('offset must be a non-negative integer')
  return { limit, offset }
}

function reportFilters(query) {
  const where = [], values = []
  const filters = { status: null, sapId: null, from: null, to: null, duplicateOnly: null }
  const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)) }

  if (query.status) {
    if (!REPORT_STATUSES.includes(query.status)) throw bad('Invalid status filter')
    filters.status = query.status
    add('r.status = ?', query.status)
  }
  if (query.sapId) {
    const sapId = normalizeSapId(query.sapId)
    if (!isValidSapId(sapId)) throw bad('SAP ID must be exactly 8 characters')
    filters.sapId = sapId
    add('e.sap_id = ?', sapId)
  }
  if (query.from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.from)) throw bad('from must be YYYY-MM-DD')
    filters.from = query.from
    add('r.created_at >= ?::date', query.from)
  }
  if (query.to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.to)) throw bad('to must be YYYY-MM-DD')
    filters.to = query.to
    add("r.created_at < (?::date + INTERVAL '1 day')", query.to)
  }
  if (query.duplicateOnly === 'true') {
    filters.duplicateOnly = 'true'
    where.push(`(
      (r.windows_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests d WHERE d.windows_license_key_hmac = r.windows_license_key_hmac AND d.request_id <> r.request_id))
      OR (r.office_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests d WHERE d.office_license_key_hmac = r.office_license_key_hmac AND d.request_id <> r.request_id))
    )`)
  } else if (query.duplicateOnly === 'false') {
    filters.duplicateOnly = 'false'
  } else if (query.duplicateOnly) {
    throw bad('duplicateOnly must be true or false')
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', values, filters }
}

const EXPORT_SQL = `SELECT e.sap_id AS "sapId", e.employee_name AS "employeeName",
    e.designation, e.employee_category AS "category", e.department,
    r.serial_number AS "serialNumber", r.model_number AS "modelNumber", r.mac_address AS "macAddress",
    r.operating_system AS "operatingSystem", r.purchase_date AS "purchaseDate", r.status,
    r.ms_office_account_email AS "msOfficeAccountEmail",
    latest.remarks AS "latestRemarks",
    (r.license_key_ciphertext IS NOT NULL) AS "legacyKeyPresent",
    (r.windows_license_key_ciphertext IS NOT NULL) AS "windowsKeyPresent",
    (r.windows_license_key_hmac IS NOT NULL AND EXISTS (
      SELECT 1 FROM laptop_requests d WHERE d.windows_license_key_hmac = r.windows_license_key_hmac AND d.request_id <> r.request_id
    )) AS "windowsKeyDuplicate",
    (r.office_license_key_ciphertext IS NOT NULL) AS "officeKeyPresent",
    (r.office_license_key_hmac IS NOT NULL AND EXISTS (
      SELECT 1 FROM laptop_requests d WHERE d.office_license_key_hmac = r.office_license_key_hmac AND d.request_id <> r.request_id
    )) AS "officeKeyDuplicate",
    r.created_at AS "createdAt", r.updated_at AS "updatedAt",
    CASE
      WHEN upper(COALESCE(r.created_by_sap_id, created_actor.actor_sap_id, '')) IN ('SYSTEM','BOOTSTRAP') THEN 'System'
      WHEN NULLIF(BTRIM(COALESCE(r.created_by_sap_id, created_actor.actor_sap_id)), '') IS NULL THEN 'Unknown (legacy)'
      WHEN created_employee.employee_name IS NOT NULL
        THEN created_employee.employee_name || ' (' || COALESCE(r.created_by_sap_id, created_actor.actor_sap_id) || ')'
      ELSE COALESCE(r.created_by_sap_id, created_actor.actor_sap_id)
    END AS "createdBy",
    CASE
      WHEN upper(COALESCE(r.updated_by_sap_id, updated_actor.actor_sap_id, '')) IN ('SYSTEM','BOOTSTRAP') THEN 'System'
      WHEN NULLIF(BTRIM(COALESCE(r.updated_by_sap_id, updated_actor.actor_sap_id)), '') IS NULL THEN 'Unknown (legacy)'
      WHEN updated_employee.employee_name IS NOT NULL
        THEN updated_employee.employee_name || ' (' || COALESCE(r.updated_by_sap_id, updated_actor.actor_sap_id) || ')'
      ELSE COALESCE(r.updated_by_sap_id, updated_actor.actor_sap_id)
    END AS "updatedBy"
  FROM laptop_requests r
  JOIN employees e ON e.employee_id = r.owner_employee_id
  LEFT JOIN LATERAL (
    SELECT ah.remarks FROM approval_history ah
    WHERE ah.request_id = r.request_id AND NULLIF(BTRIM(ah.remarks), '') IS NOT NULL
    ORDER BY ah.created_at DESC, ah.history_id DESC LIMIT 1
  ) latest ON TRUE
  LEFT JOIN LATERAL (
    SELECT al.actor_sap_id FROM audit_log al
    WHERE al.entity_type='laptop_request' AND al.entity_id=r.request_id::text
      AND al.action='laptop_request_submitted'
    ORDER BY al.occurred_at, al.audit_log_id LIMIT 1
  ) created_actor ON TRUE
  LEFT JOIN LATERAL (
    SELECT al.actor_sap_id FROM audit_log al
    WHERE al.entity_type='laptop_request' AND al.entity_id=r.request_id::text
    ORDER BY al.occurred_at DESC, al.audit_log_id DESC LIMIT 1
  ) updated_actor ON TRUE
  LEFT JOIN employees created_employee
    ON upper(created_employee.sap_id) = upper(COALESCE(r.created_by_sap_id, created_actor.actor_sap_id))
  LEFT JOIN employees updated_employee
    ON upper(updated_employee.sap_id) = upper(COALESCE(r.updated_by_sap_id, updated_actor.actor_sap_id))
  __FILTER__
  ORDER BY r.created_at DESC, r.request_id`

export async function listReports(req, res, next) {
  try {
    const { limit, offset } = pagination(req.query)
    const { clause, values } = reportFilters(req.query)
    const pageValues = [...values, limit, offset]
    const [items, count] = await Promise.all([
      pool.query(`SELECT r.request_id AS "requestId", r.serial_number AS "serialNumber", r.purchase_date AS "purchaseDate",
        r.model_number AS "modelNumber", r.mac_address AS "macAddress", r.operating_system AS "operatingSystem", r.ms_office_account_email AS "msOfficeAccountEmail", r.status,
        r.created_at AS "createdAt", e.employee_name AS "employeeName", e.sap_id AS "employeeSapId", e.department,
        (r.license_key_ciphertext IS NOT NULL) AS "legacyKeyPresent",
        (r.windows_license_key_ciphertext IS NOT NULL) AS "windowsKeyPresent",
        (r.office_license_key_ciphertext IS NOT NULL) AS "officeKeyPresent",
        ((r.windows_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests d WHERE d.windows_license_key_hmac=r.windows_license_key_hmac AND d.request_id<>r.request_id))
         OR (r.office_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests d WHERE d.office_license_key_hmac=r.office_license_key_hmac AND d.request_id<>r.request_id))) AS "duplicateLicenseWarning",
        (r.windows_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests d WHERE d.windows_license_key_hmac=r.windows_license_key_hmac AND d.request_id<>r.request_id)) AS "windowsKeyDuplicateWarning",
        (r.office_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests d WHERE d.office_license_key_hmac=r.office_license_key_hmac AND d.request_id<>r.request_id)) AS "officeKeyDuplicateWarning"
        FROM laptop_requests r JOIN employees e ON e.employee_id=r.owner_employee_id ${clause}
        ORDER BY r.created_at DESC, r.request_id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, pageValues),
      pool.query(`SELECT COUNT(*)::INTEGER AS total FROM laptop_requests r JOIN employees e ON e.employee_id=r.owner_employee_id ${clause}`, values),
    ])
    return res.json({ reports: items.rows, pagination: { limit, offset, total: count.rows[0].total } })
  } catch (error) { return next(error) }
}

export async function exportReportsExcel(req, res, next) {
  const client = await pool.connect()
  let transactionOpen = false
  try {
    const { clause, values, filters } = reportFilters(req.query)
    await client.query('BEGIN')
    transactionOpen = true
    const result = await client.query(EXPORT_SQL.replace('__FILTER__', clause), values)
    const workbook = createReportWorkbook(result.rows)
    await client.query(`INSERT INTO audit_log (actor_user_id,actor_sap_id,action,entity_type,details)
      VALUES ($1,$2,'report_exported','report',$3::jsonb)`, [
      req.currentUser.userId,
      req.currentUser.sapId,
      JSON.stringify({ filters }),
    ])
    await client.query('COMMIT')
    transactionOpen = false
    const date = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="laptop-report-${date}.xlsx"`)
    res.setHeader('Content-Length', workbook.length)
    return res.send(workbook)
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
    return next(error)
  } finally { client.release() }
}
