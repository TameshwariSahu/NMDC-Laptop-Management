import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import jwt from 'jsonwebtoken'
import { app } from '../src/app.js'
import { env } from '../src/config/env.js'
import { pool } from '../src/db/pool.js'

const integrationReady = Boolean(process.env.TEST_DATABASE_URL)
const invoiceDirectory = path.resolve(env.invoiceStorageDir ?? path.resolve('private-invoices'))
let server
let baseUrl

before(async () => {
  if (!integrationReady) return
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/api`
})

after(async () => {
  if (!integrationReady) return
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await pool.end()
  if (invoiceDirectory.startsWith(os.tmpdir())) await rm(invoiceDirectory, { recursive: true, force: true })
})

async function createActor(role) {
  const tag = randomUUID()
  const sapId = `WF${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`
  const user = await pool.query(
    'INSERT INTO users (sap_id, email, role) VALUES ($1, $2, $3) RETURNING user_id',
    [sapId, `${role}-${tag}@example.invalid`, role],
  )
  const result = { userId: user.rows[0].user_id, role }
  if (role === 'employee') {
    const employee = await pool.query(
      `INSERT INTO employees
         (user_id, sap_id, employee_name, email, designation, employee_category, department)
       VALUES ($1, $2, 'Synthetic Workflow Employee', $3, 'Tester', 'Executive', 'Workflow')
       RETURNING employee_id`,
      [result.userId, sapId, `${role}-${tag}@example.invalid`],
    )
    result.employeeId = employee.rows[0].employee_id
  }
  result.token = jwt.sign({ sub: result.userId, role: role === 'engineer' ? 'admin' : 'employee' }, env.jwtSecret, { expiresIn: '5m' })
  return result
}

async function createRequest(owner, { status = 'PENDING_ENGINEER', version = 1, hmac = null } = {}) {
  const tag = randomUUID()
  const mac = tag.replaceAll('-', '').slice(0, 10).match(/.{2}/g).join(':')
  const result = await pool.query(
    `INSERT INTO laptop_requests
       (owner_employee_id, serial_number, purchase_date, model_number, mac_address,
        operating_system, status, version, license_key_hmac)
     VALUES ($1, $2, DATE '2025-01-10', 'Workflow Synthetic', $3, 'Windows', $4, $5, $6)
     RETURNING request_id, version`,
    [owner.employeeId, `WF-SERIAL-${tag}`, `02:${mac}`, status, version, hmac],
  )
  return result.rows[0]
}

async function api(pathname, token, { method = 'GET', body } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function json(response) {
  return response.json()
}

test('engineer and admin queues are status-filtered, paginated, and details hide license material', { skip: !integrationReady }, async () => {
  const employee = await createActor('employee')
  const engineer = await createActor('engineer')
  const admin = await createActor('admin')
  const pendingOne = await createRequest(employee)
  await createRequest(employee)
  const pendingAdmin = await createRequest(employee, { status: 'PENDING_ADMIN' })
  await createRequest(employee, { status: 'NEEDS_EMPLOYEE_CORRECTION' })

  const engineerQueue = await api('/engineer/requests?limit=1&offset=0', engineer.token)
  assert.equal(engineerQueue.status, 200)
  const engineerPage = await json(engineerQueue)
  assert.equal(engineerPage.requests.length, 1)
  assert.equal(engineerPage.requests[0].department, 'Integration')
  assert.ok(engineerPage.pagination.total >= 2)
  assert.equal(engineerPage.pagination.limit, 1)

  const detailResponse = await api(`/engineer/requests/${pendingOne.request_id}`, engineer.token)
  const detail = (await json(detailResponse)).request
  assert.equal(detail.status, 'PENDING_ENGINEER')
  assert.equal(Object.hasOwn(detail, 'licenseKey'), false)
  assert.equal(Object.hasOwn(detail, 'license_key_hmac'), false)

  const adminQueue = await api('/admin/requests', admin.token)
  const adminPage = await json(adminQueue)
  assert.deepEqual(adminPage.requests.map((request) => request.requestId), [pendingAdmin.request_id])
  assert.equal(adminPage.pagination.total, 1)
})

test('engineer decisions require remarks, enforce workflow transitions, and commit history/audit/version together', { skip: !integrationReady }, async () => {
  const employee = await createActor('employee')
  const engineer = await createActor('engineer')
  const approved = await createRequest(employee)

  const missingRemarks = await api(`/engineer/requests/${approved.request_id}/decision`, engineer.token, {
    method: 'POST', body: { action: 'approve', expectedVersion: 1 },
  })
  assert.equal(missingRemarks.status, 400)
  const approval = await api(`/engineer/requests/${approved.request_id}/decision`, engineer.token, {
    method: 'POST', body: { action: 'approve', expectedVersion: 1, remarks: 'Synthetic engineer approval' },
  })
  assert.equal(approval.status, 200)
  assert.equal((await json(approval)).request.status, 'PENDING_ADMIN')
  const stored = await pool.query(
    `SELECT r.status, r.version, h.action, h.remarks, h.old_status, h.new_status,
            (SELECT COUNT(*)::INTEGER FROM audit_log a WHERE a.entity_id = r.request_id::text
             AND a.action = 'engineer_approved') AS audit_count
     FROM laptop_requests r JOIN approval_history h USING (request_id)
     WHERE r.request_id = $1`,
    [approved.request_id],
  )
  assert.equal(stored.rows[0].status, 'PENDING_ADMIN')
  assert.equal(stored.rows[0].version, 2)
  assert.equal(stored.rows[0].action, 'ENGINEER_APPROVED')
  assert.equal(stored.rows[0].remarks, 'Synthetic engineer approval')
  assert.equal(stored.rows[0].old_status, 'PENDING_ENGINEER')
  assert.equal(stored.rows[0].new_status, 'PENDING_ADMIN')
  assert.equal(stored.rows[0].audit_count, 1)

  const stale = await api(`/engineer/requests/${approved.request_id}/decision`, engineer.token, {
    method: 'POST', body: { action: 'reject', expectedVersion: 1, remarks: 'stale version' },
  })
  assert.equal(stale.status, 409)

  const rejected = await createRequest(employee)
  const rejection = await api(`/engineer/requests/${rejected.request_id}/decision`, engineer.token, {
    method: 'POST', body: { action: 'reject', expectedVersion: 1, remarks: 'Synthetic correction needed' },
  })
  assert.equal(rejection.status, 200)
  assert.equal((await json(rejection)).request.status, 'NEEDS_EMPLOYEE_CORRECTION')
  const forbiddenRepeat = await api(`/engineer/requests/${rejected.request_id}/decision`, engineer.token, {
    method: 'POST', body: { action: 'approve', expectedVersion: 2, remarks: 'Not allowed now' },
  })
  assert.equal(forbiddenRepeat.status, 409)
})

test('admin rejection returns to engineer correction; only engineer approval can return a request to admin', { skip: !integrationReady }, async () => {
  const employee = await createActor('employee')
  const engineer = await createActor('engineer')
  const admin = await createActor('admin')
  const request = await createRequest(employee, { status: 'PENDING_ADMIN' })

  const missingRemarks = await api(`/admin/requests/${request.request_id}/decision`, admin.token, {
    method: 'POST', body: { action: 'reject', expectedVersion: 1 },
  })
  assert.equal(missingRemarks.status, 400)

  const rejected = await api(`/admin/requests/${request.request_id}/decision`, admin.token, {
    method: 'POST', body: { action: 'reject', expectedVersion: 1, remarks: 'Synthetic admin correction' },
  })
  assert.equal((await json(rejected)).request.status, 'NEEDS_ENGINEER_CORRECTION')
  const invalidAdminRetry = await api(`/admin/requests/${request.request_id}/decision`, admin.token, {
    method: 'POST', body: { action: 'approve', expectedVersion: 2, remarks: 'Must return to engineer' },
  })
  assert.equal(invalidAdminRetry.status, 409)

  const correction = await api(`/engineer/requests/${request.request_id}/corrections`, engineer.token, {
    method: 'POST', body: { expectedVersion: 2, modelNumber: 'Corrected by engineer', remarks: 'Resubmitted for verification' },
  })
  assert.equal(correction.status, 200)
  assert.equal((await json(correction)).request.status, 'PENDING_ENGINEER')
  const approveAgainWithoutReview = await api(`/admin/requests/${request.request_id}/decision`, admin.token, {
    method: 'POST', body: { action: 'approve', expectedVersion: 3, remarks: 'Still not at admin stage' },
  })
  assert.equal(approveAgainWithoutReview.status, 409)

  const engineerApproval = await api(`/engineer/requests/${request.request_id}/decision`, engineer.token, {
    method: 'POST', body: { action: 'approve', expectedVersion: 3, remarks: 'Engineer re-approved' },
  })
  assert.equal((await json(engineerApproval)).request.status, 'PENDING_ADMIN')
  const adminApproval = await api(`/admin/requests/${request.request_id}/decision`, admin.token, {
    method: 'POST', body: { action: 'approve', expectedVersion: 4, remarks: 'Final synthetic approval' },
  })
  assert.equal((await json(adminApproval)).request.status, 'APPROVED')
  assert.equal((await json(await api(`/admin/requests/${request.request_id}/decision`, admin.token, {
    method: 'POST', body: { action: 'reject', expectedVersion: 5, remarks: 'Locked after approval' },
  }))).error, 'This decision is not allowed for the current request status')
})

test('employee correction checks ownership and version, re-encrypts changed keys, and records the transition atomically', { skip: !integrationReady }, async () => {
  const owner = await createActor('employee')
  const other = await createActor('employee')
  const employee = await createRequest(owner, { status: 'NEEDS_EMPLOYEE_CORRECTION' })
  const rejection = await createActor('engineer')
  await pool.query(
    `INSERT INTO approval_history (request_id, actor_user_id, actor_sap_id, action, remarks, old_status, new_status)
     VALUES ($1, $2, $3, 'ENGINEER_REJECTED', 'Synthetic correction needed', 'PENDING_ENGINEER', 'NEEDS_EMPLOYEE_CORRECTION')`,
    [employee.request_id, rejection.userId, rejection.sapId],
  )
  await pool.query(
    `INSERT INTO request_invoices (file_id, request_id, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by_user_id)
     VALUES ($1, $2, $3, 'replacement.pdf', 'application/pdf', 1, decode(repeat('ab',32),'hex'), $4)`,
    [randomUUID(), employee.request_id, `${randomUUID()}.pdf`, owner.userId],
  )

  const forbidden = await api(`/employee/requests/${employee.request_id}/corrections`, other.token, {
    method: 'POST', body: { expectedVersion: 1, modelNumber: 'Intruder value' },
  })
  assert.equal(forbidden.status, 404)
  const stale = await api(`/employee/requests/${employee.request_id}/corrections`, owner.token, {
    method: 'POST', body: { expectedVersion: 8, modelNumber: 'Stale value' },
  })
  assert.equal(stale.status, 409)

  const corrected = await api(`/employee/requests/${employee.request_id}/corrections`, owner.token, {
    method: 'POST', body: {
      expectedVersion: 1, serialNumber: 'CORRECTED-SERIAL', modelNumber: 'Corrected synthetic model',
      licenseKey: 'SYNTHETIC-KEY-DO-NOT-LOG', remarks: 'Updated requested details',
    },
  })
  assert.equal(corrected.status, 200)
  assert.equal((await json(corrected)).request.status, 'PENDING_ENGINEER')
  const stored = await pool.query(
    `SELECT r.status, r.version, r.model_number, r.license_key_ciphertext,
            r.license_key_hmac, h.action, h.remarks,
            (SELECT COUNT(*)::INTEGER FROM audit_log a WHERE a.entity_id = r.request_id::text
             AND a.action = 'employee_resubmitted') AS audit_count
     FROM laptop_requests r JOIN approval_history h USING (request_id)
     WHERE r.request_id = $1 AND h.action = 'EMPLOYEE_RESUBMITTED'`,
    [employee.request_id],
  )
  assert.equal(stored.rows[0].status, 'PENDING_ENGINEER')
  assert.equal(stored.rows[0].version, 2)
  assert.equal(stored.rows[0].model_number, 'Corrected synthetic model')
  assert.ok(stored.rows[0].license_key_ciphertext)
  assert.equal(stored.rows[0].license_key_hmac.length, 32)
  assert.equal(stored.rows[0].action, 'EMPLOYEE_RESUBMITTED')
  assert.equal(stored.rows[0].remarks, 'Updated requested details')
  assert.equal(stored.rows[0].audit_count, 1)
})

test('engineer edits permitted fields only in PENDING_ENGINEER and increments version without changing status', { skip: !integrationReady }, async () => {
  const employee = await createActor('employee')
  const engineer = await createActor('engineer')
  const request = await createRequest(employee)
  const missingRemarks = await api(`/engineer/requests/${request.request_id}`, engineer.token, {
    method: 'PATCH', body: { expectedVersion: 1, modelNumber: 'Should not save' },
  })
  assert.equal(missingRemarks.status, 400)

  const syntheticKey = 'SYNTHETIC-EDIT-KEY-DO-NOT-LOG'
  const edited = await api(`/engineer/requests/${request.request_id}`, engineer.token, {
    method: 'PATCH', body: {
      expectedVersion: 1, modelNumber: 'Engineer edited synthetic model',
      licenseKey: syntheticKey, remarks: 'Corrected the synthetic model details',
    },
  })
  assert.equal(edited.status, 200)
  assert.equal((await json(edited)).request.status, 'PENDING_ENGINEER')
  assert.equal((await json(await api(`/engineer/requests/${request.request_id}`, engineer.token))).request.version, 2)
  const editAudit = await pool.query(
    `SELECT details FROM audit_log
     WHERE entity_id = $1 AND action = 'laptop_request_edited'`,
    [request.request_id],
  )
  assert.equal(editAudit.rowCount, 1)
  assert.deepEqual(editAudit.rows[0].details.changedFields.sort(), ['licenseKey', 'modelNumber'])
  assert.equal(editAudit.rows[0].details.remarks, 'Corrected the synthetic model details')
  assert.equal(JSON.stringify(editAudit.rows[0].details).includes(syntheticKey), false)

  const staleVersion = await api(`/engineer/requests/${request.request_id}`, engineer.token, {
    method: 'PATCH', body: { expectedVersion: 1, modelNumber: 'Stale update', remarks: 'Stale edit attempt' },
  })
  assert.equal(staleVersion.status, 409)
  const unchangedAfterConflict = await pool.query(
    `SELECT version, model_number,
            (SELECT COUNT(*)::INTEGER FROM audit_log
             WHERE entity_id = $1 AND action = 'laptop_request_edited') AS edit_count
     FROM laptop_requests WHERE request_id = $2`,
    [request.request_id, request.request_id],
  )
  assert.equal(unchangedAfterConflict.rows[0].version, 2)
  assert.equal(unchangedAfterConflict.rows[0].model_number, 'Engineer edited synthetic model')
  assert.equal(unchangedAfterConflict.rows[0].edit_count, 1)
  const disallowedField = await api(`/engineer/requests/${request.request_id}`, engineer.token, {
    method: 'PATCH', body: { expectedVersion: 2, status: 'APPROVED' },
  })
  assert.equal(disallowedField.status, 400)
  const wrongStatus = await createRequest(employee, { status: 'PENDING_ADMIN' })
  const wrongStatusEdit = await api(`/engineer/requests/${wrongStatus.request_id}`, engineer.token, {
    method: 'PATCH', body: { expectedVersion: 1, modelNumber: 'Not permitted', remarks: 'Not permitted' },
  })
  assert.equal(wrongStatusEdit.status, 409)
})

test('employee or engineer may submit NEEDS_ENGINEER_CORRECTION, but no other status allows a correction transition', { skip: !integrationReady }, async () => {
  const employee = await createActor('employee')
  const engineer = await createActor('engineer')
  const employeeRequest = await createRequest(employee, { status: 'NEEDS_ENGINEER_CORRECTION' })
  const employeeCorrection = await api(`/employee/requests/${employeeRequest.request_id}/corrections`, employee.token, {
    method: 'POST', body: { expectedVersion: 1, macAddress: '02:AA:BB:CC:DD:01' },
  })
  assert.equal(employeeCorrection.status, 200)
  assert.equal((await json(employeeCorrection)).request.status, 'PENDING_ENGINEER')

  const engineerRequest = await createRequest(employee, { status: 'NEEDS_ENGINEER_CORRECTION' })
  const engineerCorrection = await api(`/engineer/requests/${engineerRequest.request_id}/corrections`, engineer.token, {
    method: 'POST', body: { expectedVersion: 1, operatingSystem: 'macOS' },
  })
  assert.equal(engineerCorrection.status, 200)
  assert.equal((await json(engineerCorrection)).request.status, 'PENDING_ENGINEER')
})

test('invoice downloads authorize reviewers and owners without exposing private storage keys', { skip: !integrationReady }, async () => {
  const owner = await createActor('employee')
  const other = await createActor('employee')
  const engineer = await createActor('engineer')
  const request = await createRequest(owner)
  const fileId = randomUUID()
  const storageKey = `${randomUUID()}.pdf`
  const contents = Buffer.from('%PDF-1.4\nsynthetic authorized download\n%%EOF')
  await mkdir(invoiceDirectory, { recursive: true })
  await writeFile(path.join(invoiceDirectory, storageKey), contents)
  await pool.query(
    `INSERT INTO request_invoices
       (file_id, request_id, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by_user_id)
     VALUES ($1, $2, $3, 'synthetic invoice.pdf', 'application/pdf', $4, decode(repeat('ab', 32), 'hex'), $5)`,
    [fileId, request.request_id, storageKey, contents.length, owner.userId],
  )

  const reviewerDownload = await api(`/invoices/${fileId}/download`, engineer.token)
  assert.equal(reviewerDownload.status, 200)
  assert.equal(reviewerDownload.headers.get('content-type'), 'application/pdf')
  assert.deepEqual(Buffer.from(await reviewerDownload.arrayBuffer()), contents)
  assert.equal(reviewerDownload.headers.get('content-disposition'), "attachment; filename*=UTF-8''synthetic%20invoice.pdf")

  const ownerDownload = await api(`/invoices/${fileId}/download`, owner.token)
  assert.equal(ownerDownload.status, 200)
  const unauthorized = await api(`/invoices/${fileId}/download`, other.token)
  assert.equal(unauthorized.status, 404)
})

test('engineer may attach a revised invoice in the allowed status using an expected version', { skip: !integrationReady }, async () => {
  const owner = await createActor('employee')
  const engineer = await createActor('engineer')
  const request = await createRequest(owner)
  const form = new FormData()
  form.set('expectedVersion', '1')
  form.set('invoice', new Blob(['%PDF-1.4\nsynthetic engineer invoice\n%%EOF'], { type: 'application/pdf' }), 'revised.pdf')
  const missingRemarks = await fetch(`${baseUrl}/engineer/requests/${request.request_id}/invoice`, {
    method: 'POST', headers: { authorization: `Bearer ${engineer.token}` }, body: form,
  })
  assert.equal(missingRemarks.status, 400)

  const validForm = new FormData()
  validForm.set('expectedVersion', '1')
  validForm.set('remarks', 'Attached a corrected synthetic invoice')
  validForm.set('invoice', new Blob(['%PDF-1.4\nsynthetic engineer invoice\n%%EOF'], { type: 'application/pdf' }), 'revised.pdf')
  const response = await fetch(`${baseUrl}/engineer/requests/${request.request_id}/invoice`, {
    method: 'POST', headers: { authorization: `Bearer ${engineer.token}` }, body: validForm,
  })
  assert.equal(response.status, 201)
  assert.equal((await json(response)).version, 2)

  const staleForm = new FormData()
  staleForm.set('expectedVersion', '1')
  staleForm.set('remarks', 'Stale invoice attempt')
  staleForm.set('invoice', new Blob(['%PDF-1.4\nstale synthetic invoice\n%%EOF'], { type: 'application/pdf' }), 'stale.pdf')
  const stale = await fetch(`${baseUrl}/engineer/requests/${request.request_id}/invoice`, {
    method: 'POST', headers: { authorization: `Bearer ${engineer.token}` }, body: staleForm,
  })
  assert.equal(stale.status, 409)

  const employeeForm = new FormData()
  employeeForm.set('expectedVersion', '2')
  employeeForm.set('invoice', new Blob(['%PDF-1.4\nwrong state\n%%EOF'], { type: 'application/pdf' }), 'wrong-state.pdf')
  const employeeEdit = await fetch(`${baseUrl}/employee/requests/${request.request_id}/invoice`, {
    method: 'POST', headers: { authorization: `Bearer ${owner.token}` }, body: employeeForm,
  })
  assert.equal(employeeEdit.status, 409)
})
