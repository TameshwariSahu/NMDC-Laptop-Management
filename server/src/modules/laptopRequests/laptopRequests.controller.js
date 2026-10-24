import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from '../../db/pool.js'
import { env } from '../../config/env.js'
import { detectInvoiceType, parseInvoiceMultipart } from './multipart.js'

export const invoiceStorageDirectory = env.invoiceStorageDir
  ? path.resolve(env.invoiceStorageDir)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../private-invoices')
const MAC_PATTERN = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i

function validateLaptopFields(fields) {
  const values = {
    serialNumber: String(fields.serialNumber ?? '').trim(),
    purchaseDate: String(fields.purchaseDate ?? '').trim(),
    modelNumber: String(fields.modelNumber ?? '').trim(),
    macAddress: String(fields.macAddress ?? '').trim().toUpperCase(),
    operatingSystem: String(fields.operatingSystem ?? '').trim(),
    licenseKey: String(fields.licenseKey ?? '').trim(),
  }
  if (!values.serialNumber || values.serialNumber.length > 255) throw httpError(400, 'Serial number is required and must be at most 255 characters')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.purchaseDate) || Number.isNaN(Date.parse(`${values.purchaseDate}T00:00:00Z`))
      || new Date(`${values.purchaseDate}T00:00:00Z`).toISOString().slice(0, 10) !== values.purchaseDate) {
    throw httpError(400, 'Purchase date must be a valid YYYY-MM-DD date')
  }
  if (!values.modelNumber || values.modelNumber.length > 255) throw httpError(400, 'Model number is required and must be at most 255 characters')
  if (!MAC_PATTERN.test(values.macAddress)) throw httpError(400, 'MAC address must use the format 00:11:22:33:44:55')
  if (!['Windows', 'macOS'].includes(values.operatingSystem)) throw httpError(400, 'Operating system must be Windows or macOS')
  if (values.licenseKey.length > 512) throw httpError(400, 'License key must be at most 512 characters')
  return values
}

function decodeSecret(value, name) {
  if (!value) throw httpError(500, `${name} is not configured`)
  const decoded = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  if (decoded.length !== 32) throw httpError(500, `${name} must encode exactly 32 bytes`)
  return decoded
}

export function encryptLicenseKey(licenseKey) {
  if (!licenseKey) return { ciphertext: null, nonce: null, authTag: null, fingerprint: null }
  const encryptionKey = decodeSecret(env.licenseEncryptionKey, 'LICENSE_ENCRYPTION_KEY')
  const hmacKey = decodeSecret(env.licenseHmacKey, 'LICENSE_HMAC_KEY')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(licenseKey, 'utf8'), cipher.final()])
  const fingerprint = createHmac('sha256', hmacKey).update(licenseKey).digest()
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
  return { laptop, invoice, detected }
}

export async function createLaptopRequest(req, res, next) {
  let storedKey
  const client = await pool.connect()
  try {
    const { laptop, invoice, detected } = await parseRequest(req)
    const license = encryptLicenseKey(laptop.licenseKey)
    const fileId = randomUUID()
    const storageKey = `${randomUUID()}${detected.extension}`
    const metadata = invoiceRow(invoice, detected, fileId, storageKey, req.currentUser.userId)
    await client.query('BEGIN')
    const inserted = await client.query(
      `INSERT INTO laptop_requests
         (owner_employee_id, serial_number, purchase_date, model_number, mac_address,
          operating_system, license_key_ciphertext, license_key_nonce, license_key_auth_tag, license_key_hmac)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING request_id, serial_number, purchase_date, model_number, mac_address,
         operating_system, status, version, created_at, updated_at`,
      [req.currentUser.employeeId, laptop.serialNumber, laptop.purchaseDate, laptop.modelNumber,
        laptop.macAddress, laptop.operatingSystem, license.ciphertext, license.nonce, license.authTag, license.fingerprint],
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
       VALUES ($1, $2, 'laptop_request_submitted', 'laptop_request', $3, $4::jsonb)`,
      [req.currentUser.userId, req.currentUser.sapId, request.request_id, JSON.stringify({ status: request.status })],
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
              r.status, r.version, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
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
