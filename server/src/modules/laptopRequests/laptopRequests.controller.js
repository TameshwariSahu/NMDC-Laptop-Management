import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from '../../db/pool.js'
import { env } from '../../config/env.js'
import { detectInvoiceType, parseInvoiceMultipart } from './multipart.js'
import { normalizeMacAddress } from '../../utils/macAddress.js'
import { normalizeLicenseKey } from '../../utils/licenseKey.js'
import { normalizeEmail } from '../../utils/email.js'

export const invoiceStorageDirectory = env.invoiceStorageDir
  ? path.resolve(env.invoiceStorageDir)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../private-invoices')
function validateLaptopFields(fields) {
  const macAddress = normalizeMacAddress(fields.macAddress)
  const msOfficeAccountEmail = normalizeEmail(fields.msOfficeAccountEmail)
  const values = {
    serialNumber: String(fields.serialNumber ?? '').trim(),
    purchaseDate: String(fields.purchaseDate ?? '').trim(),
    modelNumber: String(fields.modelNumber ?? '').trim(),
    macAddress,
    operatingSystem: String(fields.operatingSystem ?? '').trim(),
    windowsKey: normalizeLicenseKey(fields.windowsKey),
    officeKey: normalizeLicenseKey(fields.officeKey),
    msOfficeAccountEmail,
  }
  if (!values.serialNumber || values.serialNumber.length > 255) throw httpError(400, 'Serial number is required and must be at most 255 characters')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.purchaseDate) || Number.isNaN(Date.parse(`${values.purchaseDate}T00:00:00Z`))
      || new Date(`${values.purchaseDate}T00:00:00Z`).toISOString().slice(0, 10) !== values.purchaseDate) {
    throw httpError(400, 'Purchase date must be a valid YYYY-MM-DD date')
  }
  if (!values.modelNumber || values.modelNumber.length > 255) throw httpError(400, 'Model number is required and must be at most 255 characters')
  if (!values.macAddress) throw httpError(400, 'Enter a valid MAC address.')
  if (!['Windows', 'macOS'].includes(values.operatingSystem)) throw httpError(400, 'Operating system must be Windows or macOS')
  if (values.windowsKey === null) throw httpError(400, 'Invalid Windows key.')
  if (values.officeKey === null) throw httpError(400, 'Invalid MS Office key.')
  if (msOfficeAccountEmail === false) {
    throw httpError(400, 'Enter a valid MS Office account email.')
  }
  if (values.officeKey && !values.msOfficeAccountEmail) {
    throw httpError(400, 'MS Office account email is required when an MS Office key is entered.')
  }
  if (values.operatingSystem === 'macOS' && values.windowsKey) throw httpError(400, 'A Windows key cannot be used with macOS')
  return values
}

function decodeSecret(value, name) {
  if (!value) throw httpError(500, `${name} is not configured`)
  const decoded = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  if (decoded.length !== 32) throw httpError(500, `${name} must encode exactly 32 bytes`)
  return decoded
}

export function encryptLicenseKey(licenseKey, keyType = 'legacy') {
  if (!licenseKey) return { ciphertext: null, nonce: null, authTag: null, fingerprint: null }
  if (!['windows', 'office', 'legacy'].includes(keyType)) throw httpError(400, 'Invalid license key type')
  const normalizedKey = normalizeLicenseKey(licenseKey)
  if (!normalizedKey) throw httpError(400, `Invalid ${keyType === 'office' ? 'MS Office' : 'Windows'} key.`)
  const encryptionKey = decodeSecret(env.licenseEncryptionKey, 'LICENSE_ENCRYPTION_KEY')
  const hmacKey = decodeSecret(env.licenseHmacKey, 'LICENSE_HMAC_KEY')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(normalizedKey, 'utf8'), cipher.final()])
  const fingerprint = createHmac('sha256', hmacKey).update(keyType).update('\0').update(normalizedKey).digest()
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), fingerprint }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function invoiceRow(invoice, detected, fileId, storageKey, userId) {
  const receivedName = path.basename(invoice.originalName).replace(/[\r\n]/g, '').slice(0, 255) || 'invoice'
  const normalizedName = `${path.basename(receivedName, path.extname(receivedName)) || 'invoice'}${detected.extension}`
  return {
    fileId,
    storageKey,
    originalName: normalizedName,
    mimeType: detected.type,
    sizeBytes: invoice.data.length,
    sha256: createHash('sha256').update(invoice.data).digest(),
    uploadedByUserId: userId,
  }
}

async function persistInvoice(client, requestId, metadata) {
  await client.query(
    `INSERT INTO request_invoices
       (file_id, request_id, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [metadata.fileId, requestId, metadata.storageKey, metadata.originalName, metadata.mimeType,
      metadata.sizeBytes, metadata.sha256, metadata.uploadedByUserId],
  )
}

async function storeInvoice(metadata, bytes) {
  await mkdir(invoiceStorageDirectory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(invoiceStorageDirectory, metadata.storageKey), bytes, { flag: 'wx', mode: 0o600 })
}

async function parseRequest(req) {
  if (!req.is('multipart/form-data')) throw httpError(415, 'Use multipart/form-data and include an invoice')
  const { fields, invoice } = parseInvoiceMultipart(req.body, req.get('content-type') ?? '')
  const laptop = validateLaptopFields(fields)
  const detected = detectInvoiceType(invoice)
  return { laptop, invoice, detected, fields }
}

async function createRequest(req, res, next, onBehalf = false) {
  let storedKey
  const client = await pool.connect()
  try {
    const { laptop, invoice, detected, fields } = await parseRequest(req)
    let ownerEmployeeId = req.currentUser.employeeId
    if (onBehalf) {
      const sapIdInput = String(fields.employeeSapId ?? '').trim()
      if (!/^[A-Za-z0-9]{8}$/.test(sapIdInput)) throw httpError(400, 'Employee SAP ID must be exactly 8 characters')
      const employee = await pool.query(
        `SELECT e.employee_id
         FROM employees e JOIN users u ON u.user_id = e.user_id
         WHERE upper(e.sap_id) = upper($1) AND u.role = 'employee' AND u.is_active = TRUE`,
        [sapIdInput],
      )
      if (!employee.rows[0]) throw httpError(404, 'Employee not found')
      ownerEmployeeId = employee.rows[0].employee_id
    }
    if (!ownerEmployeeId) throw httpError(403, 'Employee profile is required')
    const windowsLicense = encryptLicenseKey(laptop.windowsKey, 'windows')
    const officeLicense = encryptLicenseKey(laptop.officeKey, 'office')
    const fileId = randomUUID()
    const storageKey = `${randomUUID()}${detected.extension}`
    const metadata = invoiceRow(invoice, detected, fileId, storageKey, req.currentUser.userId)
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.actor_sap_id',$1,true)", [req.currentUser.sapId])
    const inserted = await client.query(
      `INSERT INTO laptop_requests
         (owner_employee_id, serial_number, purchase_date, model_number, mac_address,
          operating_system, windows_license_key_ciphertext, windows_license_key_nonce,
          windows_license_key_auth_tag, windows_license_key_hmac,
          office_license_key_ciphertext, office_license_key_nonce,
          office_license_key_auth_tag, office_license_key_hmac,
          ms_office_account_email, registered_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING request_id, serial_number, purchase_date, model_number, mac_address,
         operating_system, ms_office_account_email, status, version, created_at, updated_at,
         (license_key_ciphertext IS NOT NULL) AS legacy_key_present`,
      [ownerEmployeeId, laptop.serialNumber, laptop.purchaseDate, laptop.modelNumber,
        laptop.macAddress, laptop.operatingSystem,
        windowsLicense.ciphertext, windowsLicense.nonce, windowsLicense.authTag, windowsLicense.fingerprint,
        officeLicense.ciphertext, officeLicense.nonce, officeLicense.authTag, officeLicense.fingerprint,
        laptop.msOfficeAccountEmail, onBehalf ? req.currentUser.userId : null],
    )
    const request = inserted.rows[0]
    await client.query(
      `INSERT INTO approval_history
         (request_id, actor_user_id, actor_sap_id, action, old_status, new_status)
       VALUES ($1, $2, $3, 'SUBMITTED', NULL, $4)`,
      [request.request_id, req.currentUser.userId, req.currentUser.sapId, request.status],
    )
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_sap_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, 'laptop_request', $4, $5::jsonb)`,
      [req.currentUser.userId, req.currentUser.sapId, onBehalf ? 'registered_on_behalf' : 'laptop_request_submitted',
        request.request_id, JSON.stringify({ status: request.status })],
    )
    await storeInvoice(metadata, invoice.data)
    storedKey = storageKey
    await persistInvoice(client, request.request_id, metadata)
    await client.query('COMMIT')
    return res.status(201).json({ request, invoice: { fileId, originalName: metadata.originalName, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes } })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (storedKey) await rm(path.join(invoiceStorageDirectory, storedKey), { force: true }).catch(() => {})
    return next(error)
  } finally {
    client.release()
  }
}

export async function createLaptopRequest(req, res, next) {
  return createRequest(req, res, next, false)
}

export async function registerLaptopOnBehalf(req, res, next) {
  return createRequest(req, res, next, true)
}

export async function searchEmployeeForEngineer(req, res, next) {
  try {
    const sapId = String(req.query.sapId ?? '').trim()
    if (!/^[A-Za-z0-9]{8}$/.test(sapId)) throw httpError(400, 'SAP ID must be exactly 8 characters')
    const result = await pool.query(
      `SELECT e.sap_id AS "sapId", e.employee_name AS "employeeName",
              e.designation, e.employee_category AS category, e.department
       FROM employees e JOIN users u ON u.user_id = e.user_id
       WHERE upper(e.sap_id) = upper($1) AND u.role = 'employee' AND u.is_active = TRUE`,
      [sapId],
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found' })
    return res.json({ employee: result.rows[0] })
  } catch (error) { return next(error) }
}

export async function uploadRequestInvoice(req, res, next) {
  let storedKey
  let replacedStorageKeys = []
  const client = await pool.connect()
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.requestId)) throw httpError(400, 'Invalid request ID')
    if (!req.is('multipart/form-data')) throw httpError(415, 'Use multipart/form-data and include an invoice')
    const { fields, invoice } = parseInvoiceMultipart(req.body, req.get('content-type') ?? '')
    const detected = detectInvoiceType(invoice)
    const remarks = String(fields.remarks ?? '').trim()
    if (req.currentUser.role === 'engineer' && !remarks) {
      throw httpError(400, 'Remarks are required for engineer edits')
    }
    if (remarks.length > 2000) throw httpError(400, 'Remarks must be at most 2000 characters')
    const expectedVersion = Number(fields.expectedVersion)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw httpError(400, 'expectedVersion must be a positive integer')
    }
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.actor_sap_id',$1,true)", [req.currentUser.sapId])
    const requestResult = await client.query(
      `SELECT request_id, owner_employee_id, status, version FROM laptop_requests
       WHERE request_id = $1 FOR UPDATE`,
      [req.params.requestId],
    )
    const currentRequest = requestResult.rows[0]
    if (!currentRequest || (req.currentUser.role === 'employee'
        && currentRequest.owner_employee_id !== req.currentUser.employeeId)) {
      throw httpError(404, 'Laptop request not found')
    }
    if (currentRequest.version !== expectedVersion) throw httpError(409, 'Request version is out of date; reload and try again')
    const allowedStatus = req.currentUser.role === 'employee'
      ? ['NEEDS_EMPLOYEE_CORRECTION', 'NEEDS_ENGINEER_CORRECTION'].includes(currentRequest.status)
      : ['PENDING_ENGINEER', 'NEEDS_ENGINEER_CORRECTION'].includes(currentRequest.status)
    if (!allowedStatus) throw httpError(409, 'Invoice changes are not allowed for this role and request status')
    const updatedRequest = await client.query(
      `UPDATE laptop_requests SET version = version + 1
       WHERE request_id = $1 AND version = $2
       RETURNING version`,
      [req.params.requestId, expectedVersion],
    )
    const fileId = randomUUID()
    const storageKey = `${randomUUID()}${detected.extension}`
    const metadata = invoiceRow(invoice, detected, fileId, storageKey, req.currentUser.userId)
    const oldInvoices = await client.query(
      `DELETE FROM request_invoices WHERE request_id = $1 RETURNING storage_key`,
      [req.params.requestId],
    )
    replacedStorageKeys = oldInvoices.rows.map((row) => row.storage_key)
    await storeInvoice(metadata, invoice.data)
    storedKey = storageKey
    await persistInvoice(client, req.params.requestId, metadata)
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_sap_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'invoice_replaced', 'laptop_request', $3, $4::jsonb)`,
      [req.currentUser.userId, req.currentUser.sapId,
        req.params.requestId,
        JSON.stringify({ version: updatedRequest.rows[0].version, replacedInvoiceCount: replacedStorageKeys.length })],
    )
    await client.query('COMMIT')
    for (const oldStorageKey of replacedStorageKeys) {
      await rm(path.join(invoiceStorageDirectory, oldStorageKey), { force: true }).catch(() => {})
    }
    return res.status(201).json({
      invoice: { fileId, originalName: metadata.originalName, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes },
      version: updatedRequest.rows[0].version,
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (storedKey) await rm(path.join(invoiceStorageDirectory, storedKey), { force: true }).catch(() => {})
    return next(error)
  } finally {
    client.release()
  }
}

export async function listOwnLaptopRequests(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT r.request_id AS "requestId", r.serial_number AS "serialNumber",
              r.purchase_date AS "purchaseDate", r.model_number AS "modelNumber",
              r.mac_address AS "macAddress", r.operating_system AS "operatingSystem",
              r.ms_office_account_email AS "msOfficeAccountEmail",
              r.status, r.version, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
              (r.license_key_ciphertext IS NOT NULL) AS "legacyKeyPresent",
              (r.windows_license_key_ciphertext IS NOT NULL) AS "windowsKeyPresent",
              (r.office_license_key_ciphertext IS NOT NULL) AS "officeKeyPresent",
              (r.windows_license_key_hmac IS NOT NULL AND EXISTS (
                SELECT 1 FROM laptop_requests d WHERE d.windows_license_key_hmac=r.windows_license_key_hmac AND d.request_id<>r.request_id
              )) AS "windowsKeyDuplicateWarning",
              (r.office_license_key_hmac IS NOT NULL AND EXISTS (
                SELECT 1 FROM laptop_requests d WHERE d.office_license_key_hmac=r.office_license_key_hmac AND d.request_id<>r.request_id
              )) AS "officeKeyDuplicateWarning",
              COALESCE((
                SELECT json_agg(json_build_object(
                  'action', h.action, 'remarks', h.remarks, 'oldStatus', h.old_status,
                  'newStatus', h.new_status, 'createdAt', h.created_at
                ) ORDER BY h.created_at)
                FROM approval_history h WHERE h.request_id = r.request_id
              ), '[]'::json) AS history,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'fileId', i.file_id, 'originalName', i.original_name,
                  'mimeType', i.mime_type, 'sizeBytes', i.size_bytes, 'createdAt', i.created_at
                ) ORDER BY i.created_at DESC)
                FROM request_invoices i WHERE i.request_id = r.request_id
              ), '[]'::json) AS invoices,
              (r.status = 'NEEDS_EMPLOYEE_CORRECTION' AND EXISTS (
                SELECT 1 FROM approval_history rejected
                WHERE rejected.request_id = r.request_id AND rejected.action = 'ENGINEER_REJECTED'
                  AND NOT EXISTS (SELECT 1 FROM request_invoices replacement
                    WHERE replacement.request_id = r.request_id
                      AND replacement.created_at > rejected.created_at)
              )) AS "needsInvoiceReplacement"
       FROM laptop_requests r
       WHERE r.owner_employee_id = $1
       ORDER BY r.created_at DESC`,
      [req.currentUser.employeeId],
    )
    return res.json({ requests: result.rows })
  } catch (error) {
    return next(error)
  }
}
