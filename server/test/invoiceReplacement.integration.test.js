import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import jwt from 'jsonwebtoken'
import { app } from '../src/app.js'
import { env } from '../src/config/env.js'
import { pool } from '../src/db/pool.js'
import { invoiceStorageDirectory } from '../src/modules/laptopRequests/laptopRequests.controller.js'

const ready = Boolean(process.env.TEST_DATABASE_URL)
let server, baseUrl

before(async () => {
  if (!ready) return
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/api`
})

after(async () => {
  if (!ready) return
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await pool.end()
  if (invoiceStorageDirectory.startsWith(os.tmpdir())) await rm(invoiceStorageDirectory, { recursive: true, force: true })
})

async function actor(role) {
  const tag = randomUUID()
  const sapId = `IV${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`
  const user = await pool.query(
    'INSERT INTO users (sap_id, email, role) VALUES ($1, $2, $3) RETURNING user_id',
    [sapId, `${role}-${tag}@example.invalid`, role],
  )
  const result = { userId: user.rows[0].user_id, sapId, role }
  if (role === 'employee') {
    const profile = await pool.query(
      `INSERT INTO employees (user_id, sap_id, employee_name, email, designation, employee_category, department)
       VALUES ($1, $2, 'Synthetic Invoice Employee', $3, 'Tester', 'Executive', 'Integration')
       RETURNING employee_id`,
      [result.userId, sapId, `${role}-${tag}@example.invalid`],
    )
    result.employeeId = profile.rows[0].employee_id
  }
  result.token = jwt.sign({ sub: result.userId, role: 'employee' }, env.jwtSecret, { expiresIn: '5m' })
  return result
}

function formData(fields = {}, bytes = Buffer.from('%PDF-1.4\nsynthetic original invoice\n%%EOF'), mimeType = 'application/pdf', name = 'original.pdf') {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
  form.set('invoice', new Blob([bytes], { type: mimeType }), name)
  return form
}

async function call(pathname, user, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { authorization: `Bearer ${user.token}`, ...(options.headers ?? {}) },
  })
}

async function json(response) { return response.json() }

async function submitLaptop(employee) {
  const tag = randomUUID()
  const response = await call('/employee/requests', employee, {
    method: 'POST',
    body: formData({
      serialNumber: `INV-${tag}`, purchaseDate: '2025-01-10', modelNumber: 'Synthetic Invoice Model',
      macAddress: `02:${tag.replaceAll('-', '').slice(0, 10).match(/.{2}/g).join(':')}`,
      operatingSystem: 'Windows', licenseKey: '',
    }),
  })
  assert.equal(response.status, 201)
  return json(response)
}

test('Engineer rejection keeps the current invoice visible as needing replacement and blocks resubmission until upload', { skip: !ready }, async () => {
  const employee = await actor('employee'), engineer = await actor('engineer')
  const created = await submitLaptop(employee)
  const requestId = created.request.request_id
  const originalFileId = created.invoice.fileId

  const rejection = await call(`/engineer/requests/${requestId}/decision`, engineer, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reject', expectedVersion: 1, remarks: 'Synthetic correction requested' }),
  })
  assert.equal(rejection.status, 200)

  const listed = await call('/employee/requests', employee)
  const request = (await json(listed)).requests[0]
  assert.equal(request.status, 'NEEDS_EMPLOYEE_CORRECTION')
  assert.equal(request.needsInvoiceReplacement, true)
  assert.equal(request.invoices.length, 1)
  assert.equal(request.invoices[0].fileId, originalFileId)

  const blocked = await call(`/employee/requests/${requestId}/corrections`, employee, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 2, modelNumber: 'Synthetic corrected model' }),
  })
  assert.equal(blocked.status, 409)
  assert.match((await json(blocked)).error, /replacement invoice/i)
})

test('replacement deletes the old invoice row and file, exposes only the replacement, and blocks old downloads for every role', { skip: !ready }, async () => {
  const employee = await actor('employee'), engineer = await actor('engineer'), admin = await actor('admin')
  const created = await submitLaptop(employee)
  const requestId = created.request.request_id
  const originalFileId = created.invoice.fileId
  const originalRecord = await pool.query('SELECT storage_key FROM request_invoices WHERE file_id=$1', [originalFileId])
  const originalPath = path.join(invoiceStorageDirectory, originalRecord.rows[0].storage_key)
  await readFile(originalPath)

  const rejection = await call(`/engineer/requests/${requestId}/decision`, engineer, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reject', expectedVersion: 1, remarks: 'Synthetic correction requested' }),
  })
  assert.equal(rejection.status, 200)

  const replacementBytes = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9])
  const replacementResponse = await call(`/employee/requests/${requestId}/invoice`, employee, {
    method: 'POST', body: formData({ expectedVersion: 2 }, replacementBytes, 'image/jpeg', 'replacement.pdf'),
  })
  assert.equal(replacementResponse.status, 201)
  const replacement = (await json(replacementResponse)).invoice

  const records = await pool.query(
    `SELECT file_id, storage_key FROM request_invoices WHERE request_id=$1`,
    [requestId],
  )
  assert.equal(records.rowCount, 1)
  assert.equal(records.rows[0].file_id, replacement.fileId)
  await assert.rejects(readFile(originalPath), (error) => error.code === 'ENOENT')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SAVEPOINT duplicate_request_invoice')
    await assert.rejects(
      client.query(
        `INSERT INTO request_invoices (request_id, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by_user_id)
         VALUES ($1, $2, 'duplicate.jpg', 'image/jpeg', 1, decode(repeat('cd',32),'hex'), $3)`,
        [requestId, `${randomUUID()}.jpg`, employee.userId],
      ),
      (error) => error.code === '23505',
    )
    await client.query('ROLLBACK TO SAVEPOINT duplicate_request_invoice')
    await client.query('RELEASE SAVEPOINT duplicate_request_invoice')
    await client.query('ROLLBACK')
  } finally { client.release() }

  const audit = await pool.query(
    `SELECT action, details FROM audit_log WHERE entity_id=$1 AND action='invoice_replaced' ORDER BY audit_log_id DESC LIMIT 1`,
    [requestId],
  )
  assert.equal(audit.rowCount, 1)
  assert.equal(audit.rows[0].action, 'invoice_replaced')
  assert.equal(JSON.stringify(audit.rows[0].details).includes('replacement.pdf'), false)
  assert.equal(JSON.stringify(audit.rows[0].details).includes(replacementBytes.toString('hex')), false)

  const employeeRequest = (await json(await call('/employee/requests', employee))).requests[0]
  assert.equal(employeeRequest.invoices.length, 1)
  assert.equal(employeeRequest.invoices[0].fileId, replacement.fileId)
  assert.equal(Object.hasOwn(employeeRequest, 'supersededInvoices'), false)
  const engineerRequest = (await json(await call(`/engineer/requests/${requestId}`, engineer))).request
  assert.equal(engineerRequest.invoices.length, 1)
  assert.equal(engineerRequest.invoices[0].fileId, replacement.fileId)
  const adminRequest = (await json(await call(`/admin/requests/${requestId}`, admin))).request
  assert.equal(adminRequest.invoices[0].fileId, replacement.fileId)

  assert.equal((await call(`/invoices/${originalFileId}/download`, employee)).status, 404)
  assert.equal((await call(`/invoices/${originalFileId}/download`, engineer)).status, 404)
  assert.equal((await call(`/invoices/${originalFileId}/download`, admin)).status, 404)
  const currentDownload = await call(`/invoices/${replacement.fileId}/download`, employee)
  assert.equal(currentDownload.status, 200)
  assert.equal(currentDownload.headers.get('content-type'), 'image/jpeg')
  assert.match(currentDownload.headers.get('content-disposition'), /replacement\.jpg/i)

  const resubmitted = await call(`/employee/requests/${requestId}/corrections`, employee, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 3, modelNumber: 'Synthetic corrected model' }),
  })
  assert.equal(resubmitted.status, 200)
  assert.equal((await json(resubmitted)).request.status, 'PENDING_ENGINEER')
  const afterResubmission = (await json(await call('/employee/requests', employee))).requests[0]
  assert.equal(afterResubmission.needsInvoiceReplacement, false)
})
