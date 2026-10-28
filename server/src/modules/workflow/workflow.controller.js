import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../../db/pool.js'
import { encryptLicenseKey, invoiceStorageDirectory } from '../laptopRequests/laptopRequests.controller.js'
import { normalizeMacAddress } from '../../utils/macAddress.js'
import { normalizeLicenseKey } from '../../utils/licenseKey.js'
import { normalizeEmail } from '../../utils/email.js'

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FIELD_COLUMNS = Object.freeze({
  serialNumber: 'serial_number',
  purchaseDate: 'purchase_date',
  modelNumber: 'model_number',
  macAddress: 'mac_address',
  operatingSystem: 'operating_system',
  msOfficeAccountEmail: 'ms_office_account_email',
})

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

async function setRequestActor(client, req) {
  await client.query("SELECT set_config('app.actor_sap_id',$1,true)", [req.currentUser.sapId])
}

function requestIdFrom(req) {
  if (!REQUEST_ID_PATTERN.test(req.params.requestId)) throw httpError(400, 'Invalid request ID')
  return req.params.requestId
}

function readExpectedVersion(body) {
  const value = Number(body?.expectedVersion)
  if (!Number.isSafeInteger(value) || value < 1) throw httpError(400, 'expectedVersion must be a positive integer')
  return value
}

function validatePatch(body, { allowRemarks = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Request body must be a JSON object')
  const allowed = new Set(['expectedVersion', ...Object.keys(FIELD_COLUMNS), 'windowsKey', 'officeKey', ...(allowRemarks ? ['remarks'] : [])])
  const unknown = Object.keys(body).find((key) => !allowed.has(key))
  if (unknown) throw httpError(400, `Field is not editable: ${unknown}`)
  const patch = {}
  for (const [field, column] of Object.entries(FIELD_COLUMNS)) {
    if (!Object.hasOwn(body, field)) continue
    const value = typeof body[field] === 'string' ? body[field].trim() : ''
    if (field === 'msOfficeAccountEmail') {
      if (body[field] !== null && typeof body[field] !== 'string') {
        throw httpError(400, 'MS Office account email must be text or null')
      }
      const normalized = normalizeEmail(value)
      if (normalized === false) {
        throw httpError(400, 'Enter a valid MS Office account email.')
      }
      patch[field] = { column, value: normalized }
      continue
    }
    if (field === 'serialNumber' && (!value || value.length > 255)) throw httpError(400, 'Serial number is required and must be at most 255 characters')
    if (field === 'purchaseDate' && (!/^\d{4}-\d{2}-\d{2}$/.test(value)
        || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) {
      throw httpError(400, 'Purchase date must be a valid YYYY-MM-DD date')
    }
    if (field === 'modelNumber' && (!value || value.length > 255)) throw httpError(400, 'Model number is required and must be at most 255 characters')
    if (field === 'macAddress' && !normalizeMacAddress(value)) throw httpError(400, 'Enter a valid MAC address.')
    if (field === 'operatingSystem' && !['Windows', 'macOS'].includes(value)) throw httpError(400, 'Operating system must be Windows or macOS')
    patch[field] = { column, value: field === 'macAddress' ? normalizeMacAddress(value) : value }
  }
  for (const [field, keyType, prefix] of [['windowsKey', 'windows', 'windows_license_key'], ['officeKey', 'office', 'office_license_key']]) {
    if (!Object.hasOwn(body, field)) continue
    const value = body[field]
    if (value !== null && typeof value !== 'string') throw httpError(400, `${field} must be text or null`)
    const text = normalizeLicenseKey(value)
    if (text === null) throw httpError(400, `Invalid ${field === 'officeKey' ? 'MS Office' : 'Windows'} key.`)
    if (field === 'windowsKey' && body.operatingSystem === 'macOS' && text) throw httpError(400, 'A Windows key cannot be used with macOS')
    if (field === 'officeKey' && text && !String(body.msOfficeAccountEmail ?? '').trim()) {
      throw httpError(400, 'MS Office account email is required when an MS Office key is entered.')
    }
    const encrypted = encryptLicenseKey(text, keyType)
    patch[field] = {
      columns: [`${prefix}_ciphertext`, `${prefix}_nonce`, `${prefix}_auth_tag`, `${prefix}_hmac`],
      values: [encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.fingerprint],
    }
  }
  if (Object.keys(patch).length === 0) throw httpError(400, 'Provide at least one editable field')
  const remarks = allowRemarks ? String(body.remarks ?? '').trim() : undefined
  if (remarks !== undefined && remarks.length > 2000) throw httpError(400, 'Remarks must be at most 2000 characters')
  return { patch, remarks }
}

async function lockRequest(client, requestId, req, expectedVersion) {
  const result = await client.query(
    `SELECT request_id, owner_employee_id, status, version, operating_system,
       serial_number, purchase_date, model_number, mac_address,
       ms_office_account_email, registered_by_user_id,
       (windows_license_key_ciphertext IS NOT NULL) AS windows_key_present,
       (office_license_key_ciphertext IS NOT NULL) AS office_key_present
     FROM laptop_requests WHERE request_id = $1 FOR UPDATE`,
    [requestId],
  )
  const request = result.rows[0]
  if (!request || (req.currentUser.role === 'employee' && request.owner_employee_id !== req.currentUser.employeeId)) {
    throw httpError(404, 'Laptop request not found')
  }
  if (request.version !== expectedVersion) throw httpError(409, 'Request version is out of date; reload and try again')
  return request
}

function validateOperatingSystemChange(request, patch) {
  const targetOperatingSystem = patch.operatingSystem?.value ?? request.operating_system
  if (targetOperatingSystem === 'macOS' && patch.windowsKey?.values?.[0]) {
    throw httpError(400, 'A Windows key cannot be used with macOS')
  }
  if (request.operating_system === 'Windows'
      && targetOperatingSystem === 'macOS'
      && request.windows_key_present) {
    throw httpError(409, 'Remove the existing Windows key before changing the operating system to macOS')
  }
}

function validateOfficeEmailChange(request, patch) {
  const replacingOfficeKey = Boolean(patch.officeKey?.values?.[0])
  const clearingOfficeKey = patch.officeKey && !patch.officeKey.values[0]
  const clearsEmail = Object.hasOwn(patch, 'msOfficeAccountEmail') && !patch.msOfficeAccountEmail.value
  if (replacingOfficeKey && !patch.msOfficeAccountEmail?.value) {
    throw httpError(400, 'MS Office account email is required when an MS Office key is entered.')
  }
  if (request.ms_office_account_email && clearsEmail && !clearingOfficeKey) {
    throw httpError(400, 'Remove the MS Office key before clearing its account email.')
  }
}

function buildUpdate(patch, requestId, expectedVersion, status) {
  const assignments = []
  const values = [requestId, expectedVersion]
  for (const entry of Object.values(patch)) {
    if (entry.column) {
      values.push(entry.value)
      assignments.push(`${entry.column} = $${values.length}`)
    } else {
      for (let i = 0; i < entry.columns.length; i += 1) {
        values.push(entry.values[i])
        assignments.push(`${entry.columns[i]} = $${values.length}`)
      }
    }
  }
  if (status) {
    values.push(status)
    assignments.push(`status = $${values.length}`)
  }
  assignments.push('version = version + 1')
  assignments.push('updated_at = NOW()')
  return {
    sql: `UPDATE laptop_requests SET ${assignments.join(', ')} WHERE request_id = $1 AND version = $2
          RETURNING request_id, status, version, updated_at`,
    values,
  }
}

async function insertWorkflowEvents(client, req, { requestId, oldStatus, newStatus, action, remarks, changedFields, changes, version }) {
  await client.query(
    `INSERT INTO approval_history
       (request_id, actor_user_id, actor_sap_id, action, remarks, old_status, new_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [requestId, req.currentUser.userId, req.currentUser.sapId, action, remarks ?? null, oldStatus, newStatus],
  )
  await client.query(
    `INSERT INTO audit_log (actor_user_id, actor_sap_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, 'laptop_request', $4, $5::jsonb)`,
    [req.currentUser.userId, req.currentUser.sapId, action.toLowerCase(), requestId,
      JSON.stringify({ oldStatus, newStatus, version, changedFields, changes })],
  )
}

async function addEditAudit(client, req, { requestId, status, remarks, changedFields, changes, version }) {
  await client.query(
    `INSERT INTO audit_log (actor_user_id, actor_sap_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, 'laptop_request_edited', 'laptop_request', $3, $4::jsonb)`,
    [req.currentUser.userId, req.currentUser.sapId, requestId,
      JSON.stringify({ status, remarks, changedFields, changes, version })],
  )
}

function changesForPatch(request, patch) {
  const changes = {}
  const oldValues = {
    serialNumber: request.serial_number,
    purchaseDate: request.purchase_date,
    modelNumber: request.model_number,
    macAddress: request.mac_address,
    operatingSystem: request.operating_system,
    msOfficeAccountEmail: request.ms_office_account_email,
  }
  for (const [field, entry] of Object.entries(patch)) {
    if (entry.column) {
      const oldValue = oldValues[field] ?? null
      if (oldValue !== entry.value) changes[field] = { old: oldValue, new: entry.value }
    } else {
      const presentField = field === 'windowsKey' ? 'windows_key_present' : 'office_key_present'
      if (Boolean(request[presentField]) !== Boolean(entry.values[0]) || entry.values[0]) changes[field] = 'changed'
    }
  }
  return changes
}

function changedFieldNames(patch) {
  return Object.keys(patch)
}

function listLimitOffset(query) {
  const limit = Number(query.limit ?? 25)
  const offset = Number(query.offset ?? 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw httpError(400, 'limit must be between 1 and 100')
  if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, 'offset must be a non-negative integer')
  return { limit, offset }
}

function requestProjection() {
  return `
  r.request_id AS "requestId", r.owner_employee_id AS "ownerEmployeeId",
  e.employee_name AS "employeeName", e.sap_id AS "employeeSapId",
  e.department,
  r.serial_number AS "serialNumber", r.purchase_date AS "purchaseDate",
  r.model_number AS "modelNumber", r.mac_address AS "macAddress",
  r.operating_system AS "operatingSystem", r.status, r.version,
  r.ms_office_account_email AS "msOfficeAccountEmail",
  r.created_by_sap_id AS "createdBySapId",
  (SELECT creator.employee_name FROM employees creator
   WHERE upper(creator.sap_id) = upper(r.created_by_sap_id) LIMIT 1) AS "createdByName",
  r.registered_by_user_id AS "registeredByUserId",
  r.created_at AS "createdAt", r.updated_at AS "updatedAt",
  (r.license_key_ciphertext IS NOT NULL) AS "legacyKeyPresent",
  (r.windows_license_key_ciphertext IS NOT NULL) AS "windowsKeyPresent",
  (r.office_license_key_ciphertext IS NOT NULL) AS "officeKeyPresent",
  (r.windows_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests duplicate
          WHERE duplicate.windows_license_key_hmac = r.windows_license_key_hmac
            AND duplicate.request_id <> r.request_id)) AS "windowsKeyDuplicateWarning",
  (r.office_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests duplicate
          WHERE duplicate.office_license_key_hmac = r.office_license_key_hmac
            AND duplicate.request_id <> r.request_id)) AS "officeKeyDuplicateWarning",
  ((r.windows_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests duplicate
          WHERE duplicate.windows_license_key_hmac = r.windows_license_key_hmac AND duplicate.request_id <> r.request_id))
   OR (r.office_license_key_hmac IS NOT NULL AND EXISTS (SELECT 1 FROM laptop_requests duplicate
          WHERE duplicate.office_license_key_hmac = r.office_license_key_hmac AND duplicate.request_id <> r.request_id))) AS "duplicateLicenseWarning",
  COALESCE((SELECT json_agg(json_build_object(
    'action', h.action, 'remarks', h.remarks, 'oldStatus', h.old_status,
    'newStatus', h.new_status, 'createdAt', h.created_at
  ) ORDER BY h.created_at) FROM approval_history h WHERE h.request_id = r.request_id), '[]'::json) AS history,
  COALESCE((SELECT json_agg(json_build_object(
    'fileId', i.file_id, 'originalName', i.original_name, 'mimeType', i.mime_type,
    'sizeBytes', i.size_bytes, 'createdAt', i.created_at
  ) ORDER BY i.created_at DESC) FROM request_invoices i
    WHERE i.request_id = r.request_id), '[]'::json) AS invoices,
  (r.status = 'NEEDS_EMPLOYEE_CORRECTION' AND EXISTS (
    SELECT 1 FROM approval_history rejected
    WHERE rejected.request_id = r.request_id AND rejected.action = 'ENGINEER_REJECTED'
      AND NOT EXISTS (SELECT 1 FROM request_invoices replacement
        WHERE replacement.request_id = r.request_id
          AND replacement.created_at > rejected.created_at)
  )) AS "needsInvoiceReplacement"
`
}

export async function listWorkflowQueue(req, res, next) {
  try {
    const { limit, offset } = listLimitOffset(req.query)
    const status = req.currentUser.role === 'engineer' ? 'PENDING_ENGINEER' : 'PENDING_ADMIN'
    const projection = requestProjection()
    const [items, total] = await Promise.all([
      pool.query(
        `SELECT ${projection}
         FROM laptop_requests r JOIN employees e ON e.employee_id = r.owner_employee_id
         WHERE r.status = $1 ORDER BY r.created_at ASC, r.request_id
         LIMIT $2 OFFSET $3`,
        [status, limit, offset],
      ),
      pool.query('SELECT COUNT(*)::INTEGER AS total FROM laptop_requests WHERE status = $1', [status]),
    ])
    return res.json({
      requests: items.rows,
      pagination: { limit, offset, total: total.rows[0].total },
    })
  } catch (error) {
    return next(error)
  }
}

export async function getWorkflowRequest(req, res, next) {
  try {
    const requestId = requestIdFrom(req)
    const projection = requestProjection()
    const result = await pool.query(
      `SELECT ${projection}
       FROM laptop_requests r JOIN employees e ON e.employee_id = r.owner_employee_id
       WHERE r.request_id = $1`,
      [requestId],
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Laptop request not found' })
    return res.json({ request: result.rows[0] })
  } catch (error) {
    return next(error)
  }
}

export async function editEngineerRequest(req, res, next) {
  const client = await pool.connect()
  try {
    const requestId = requestIdFrom(req)
    const expectedVersion = readExpectedVersion(req.body)
    const { patch, remarks } = validatePatch(req.body, { allowRemarks: true })
    if (!remarks) throw httpError(400, 'Remarks are required for engineer edits')
    await client.query('BEGIN')
    await setRequestActor(client, req)
    const request = await lockRequest(client, requestId, req, expectedVersion)
    if (request.status !== 'PENDING_ENGINEER') throw httpError(409, 'Engineer edits are allowed only while PENDING_ENGINEER')
    validateOperatingSystemChange(request, patch)
    validateOfficeEmailChange(request, patch)
    const update = buildUpdate(patch, requestId, expectedVersion)
    const updated = await client.query(update.sql, update.values)
    await addEditAudit(client, req, {
      requestId, status: request.status, remarks, changedFields: changedFieldNames(patch),
      changes: changesForPatch(request, patch), version: updated.rows[0].version,
    })
    await client.query('COMMIT')
    return res.json({ request: updated.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    return next(error)
  } finally {
    client.release()
  }
}

export async function submitCorrection(req, res, next) {
  const client = await pool.connect()
  try {
    const requestId = requestIdFrom(req)
    const expectedVersion = readExpectedVersion(req.body)
    const { patch, remarks } = validatePatch(req.body, { allowRemarks: true })
    await client.query('BEGIN')
    await setRequestActor(client, req)
    const request = await lockRequest(client, requestId, req, expectedVersion)
    const permitted = (request.status === 'NEEDS_EMPLOYEE_CORRECTION' && req.currentUser.role === 'employee')
      || (request.status === 'NEEDS_ENGINEER_CORRECTION' && ['employee', 'engineer'].includes(req.currentUser.role))
    if (!permitted) throw httpError(409, 'Correction is not allowed for this role and request status')
    validateOperatingSystemChange(request, patch)
    validateOfficeEmailChange(request, patch)
    if (request.status === 'NEEDS_EMPLOYEE_CORRECTION') {
      const invoiceResult = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM request_invoices invoice
           WHERE invoice.request_id = $1
             AND invoice.created_at > (
               SELECT MAX(history.created_at) FROM approval_history history
               WHERE history.request_id = $1 AND history.action = 'ENGINEER_REJECTED'
             )
         ) AS replacement_uploaded`,
        [requestId],
      )
      if (!invoiceResult.rows[0]?.replacement_uploaded) {
        throw httpError(409, 'Upload a replacement invoice before resubmitting this request')
      }
    }
    const update = buildUpdate(patch, requestId, expectedVersion, 'PENDING_ENGINEER')
    const updated = await client.query(update.sql, update.values)
    const action = request.status === 'NEEDS_EMPLOYEE_CORRECTION' ? 'EMPLOYEE_RESUBMITTED' : 'CORRECTION_RESUBMITTED'
    await insertWorkflowEvents(client, req, {
      requestId, oldStatus: request.status, newStatus: 'PENDING_ENGINEER', action, remarks,
      changedFields: changedFieldNames(patch), changes: changesForPatch(request, patch), version: updated.rows[0].version,
    })
    await client.query('COMMIT')
    return res.json({ request: updated.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    return next(error)
  } finally {
    client.release()
  }
}

const DECISION_TRANSITIONS = Object.freeze({
  engineer: {
    approve: { oldStatus: 'PENDING_ENGINEER', newStatus: 'PENDING_ADMIN', action: 'ENGINEER_APPROVED' },
    reject: { oldStatus: 'PENDING_ENGINEER', newStatus: 'NEEDS_EMPLOYEE_CORRECTION', action: 'ENGINEER_REJECTED' },
  },
  admin: {
    approve: { oldStatus: 'PENDING_ADMIN', newStatus: 'APPROVED', action: 'ADMIN_APPROVED' },
    reject: { oldStatus: 'PENDING_ADMIN', newStatus: 'NEEDS_ENGINEER_CORRECTION', action: 'ADMIN_REJECTED' },
  },
})

export async function decideRequest(req, res, next) {
  const client = await pool.connect()
  try {
    const requestId = requestIdFrom(req)
    const expectedVersion = readExpectedVersion(req.body)
    const actionInput = String(req.body?.action ?? '').trim().toLowerCase()
    const transition = DECISION_TRANSITIONS[req.currentUser.role]?.[actionInput]
    if (!transition) throw httpError(400, 'Action must be approve or reject')
    const decisionRemarks = String(req.body?.remarks ?? '').trim()
    if (actionInput === 'reject' && !decisionRemarks) throw httpError(400, 'Remarks are required for rejection')
    const remarks = decisionRemarks || null
    if (decisionRemarks.length > 2000) throw httpError(400, 'Remarks must be at most 2000 characters')
    const keys = Object.keys(req.body ?? {})
    if (keys.some((key) => !['action', 'remarks', 'expectedVersion'].includes(key))) throw httpError(400, 'Unexpected decision field')
    await client.query('BEGIN')
    await setRequestActor(client, req)
    const request = await lockRequest(client, requestId, req, expectedVersion)
    if (request.status !== transition.oldStatus) throw httpError(409, 'This decision is not allowed for the current request status')
    if (req.currentUser.role === 'engineer' && actionInput === 'approve'
        && request.registered_by_user_id === req.currentUser.userId) {
      throw httpError(403, 'The registering Engineer cannot approve this request')
    }
    if (req.currentUser.role === 'admin' && actionInput === 'approve') {
      const engineerApproval = await client.query(
        `SELECT EXISTS (SELECT 1 FROM approval_history
         WHERE request_id = $1 AND action = 'ENGINEER_APPROVED') AS approved`,
        [requestId],
      )
      if (!engineerApproval.rows[0].approved) {
        throw httpError(409, 'Engineer approval is required before final approval')
      }
    }
    const update = buildUpdate({}, requestId, expectedVersion, transition.newStatus)
    const updated = await client.query(update.sql, update.values)
    await insertWorkflowEvents(client, req, {
      requestId, oldStatus: transition.oldStatus, newStatus: transition.newStatus,
      action: transition.action, remarks, changedFields: [], version: updated.rows[0].version,
    })
    await client.query('COMMIT')
    return res.json({ request: updated.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    return next(error)
  } finally {
    client.release()
  }
}

export async function downloadInvoice(req, res, next) {
  try {
    if (!REQUEST_ID_PATTERN.test(req.params.fileId)) throw httpError(400, 'Invalid invoice ID')
    const result = await pool.query(
      `SELECT i.storage_key, i.original_name, i.mime_type, r.owner_employee_id
       FROM request_invoices i JOIN laptop_requests r ON r.request_id = i.request_id
       WHERE i.file_id = $1`,
      [req.params.fileId],
    )
    const invoice = result.rows[0]
    if (!invoice || (req.currentUser.role === 'employee' && invoice.owner_employee_id !== req.currentUser.employeeId)) {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    if (!/^[0-9a-f-]{36}\.(?:pdf|jpg|png)$/i.test(invoice.storage_key)) return res.status(404).json({ error: 'Invoice not found' })
    let contents
    try {
      contents = await readFile(path.join(invoiceStorageDirectory, invoice.storage_key))
    } catch {
      return res.status(404).json({ error: 'Invoice not found' })
    }
    const safeName = path.basename(invoice.original_name).replace(/[\r\n]/g, '').slice(0, 255) || 'invoice'
    const extension = ({ 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' })[invoice.mime_type]
    const filename = encodeURIComponent(extension
      ? `${path.basename(safeName, path.extname(safeName)) || 'invoice'}${extension}`
      : safeName)
    res.setHeader('Content-Type', invoice.mime_type)
    res.setHeader('Content-Length', contents.length)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    return res.status(200).send(contents)
  } catch (error) {
    return next(error)
  }
}
