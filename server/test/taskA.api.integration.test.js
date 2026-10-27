import assert from 'node:assert/strict'
import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import jwt from 'jsonwebtoken'
import { app } from '../src/app.js'
import { env } from '../src/config/env.js'
import { pool } from '../src/db/pool.js'

let server
let baseUrl
const defaultInvoiceStorage = path.resolve(path.dirname(new URL('../src/modules/laptopRequests/laptopRequests.controller.js', import.meta.url).pathname), '../../../private-invoices')
const invoiceStorage = env.invoiceStorageDir ? path.resolve(env.invoiceStorageDir) : defaultInvoiceStorage
const integrationReady = Boolean(process.env.TEST_DATABASE_URL)

before(async () => {
  if (!integrationReady) return
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/api/employee`
})

after(async () => {
  if (!integrationReady) return
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await pool.end()
  if (invoiceStorage.startsWith(os.tmpdir())) await rm(invoiceStorage, { recursive: true, force: true })
})

async function createEmployee() {
  const tag = randomUUID()
  const sapId = `AP${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`
  const user = await pool.query(
    `INSERT INTO users (sap_id, email, role) VALUES ($1, $2, 'employee') RETURNING user_id`,
    [sapId, `api-${tag}@example.invalid`],
  )
  const profile = await pool.query(
    `INSERT INTO employees
       (user_id, sap_id, employee_name, email, designation, employee_category, department)
     VALUES ($1, $2, 'Synthetic API Employee', $3, 'Tester', 'Executive', 'Integration')
     RETURNING employee_id`,
    [user.rows[0].user_id, sapId, `api-${tag}@example.invalid`],
  )
  return {
    userId: user.rows[0].user_id,
    employeeId: profile.rows[0].employee_id,
    sapId,
    token: jwt.sign({ sub: user.rows[0].user_id, role: 'admin' }, env.jwtSecret, { expiresIn: '5m' }),
  }
}

async function createEngineer() {
  const tag = randomUUID()
  const sapId = `EN${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`
  const result = await pool.query(
    `INSERT INTO users (sap_id,email,role) VALUES ($1,$2,'engineer') RETURNING user_id`,
    [sapId, `engineer-${tag}@example.invalid`],
  )
  return { userId: result.rows[0].user_id, sapId,
    token: jwt.sign({ sub: result.rows[0].user_id }, env.jwtSecret, { expiresIn: '5m' }) }
}

function formData(overrides = {}, fileBytes = Buffer.from('%PDF-1.4\nsynthetic integration invoice\n%%EOF'), mimeType = 'application/pdf') {
  const form = new FormData()
  const values = {
    serialNumber: `S-${randomUUID()}`,
    purchaseDate: '2025-01-10',
    modelNumber: 'Synthetic Model 100',
    macAddress: `02:${randomUUID().replaceAll('-', '').slice(0, 10).match(/.{2}/g).join(':')}`,
    operatingSystem: 'Windows',
    windowsKey: '',
    officeKey: '',
    ...overrides,
  }
  for (const [key, value] of Object.entries(values)) form.set(key, value)
  form.set('invoice', new Blob([fileBytes], { type: mimeType }), 'synthetic-invoice.pdf')
  return form
}

async function request(pathname, token, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  })
}

test('authentication rejects SAP IDs that are not exactly eight characters', { skip: !integrationReady }, async () => {
  const response = await fetch(`${baseUrl.replace(/\/employee$/, '')}/auth/request-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sapId: 'SHORT01' }),
  })
  assert.equal(response.status, 400)
})

test('unknown and deactivated SAP IDs return the same error; deactivated accounts receive no OTP and old sessions fail', { skip: !integrationReady }, async () => {
  const employee = await createEmployee()
  await pool.query('UPDATE users SET is_active = FALSE WHERE user_id = $1', [employee.userId])
  const otpCountBefore = await pool.query('SELECT COUNT(*)::int AS n FROM login_otps WHERE user_id = $1', [employee.userId])
  const authBase = baseUrl.replace(/\/employee$/, '')
  async function requestOtp(sapId) {
    return fetch(`${authBase}/auth/request-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sapId }),
    })
  }
  const unknown = await requestOtp('ZZ000001')
  const deactivated = await requestOtp((await pool.query('SELECT sap_id FROM users WHERE user_id=$1', [employee.userId])).rows[0].sap_id)
  assert.equal(unknown.status, 404)
  assert.equal(deactivated.status, 404)
  const unknownBody = await unknown.json()
  const deactivatedBody = await deactivated.json()
  assert.deepEqual(deactivatedBody, unknownBody)
  assert.equal(unknownBody.error, 'Account does not exist. Please contact the admin.')
  const otpCountAfter = await pool.query('SELECT COUNT(*)::int AS n FROM login_otps WHERE user_id = $1', [employee.userId])
  assert.equal(otpCountAfter.rows[0].n, otpCountBefore.rows[0].n)
  const oldSession = await request('/requests', employee.token)
  assert.equal(oldSession.status, 401)
})

test('registration accepts and stores colonless and colon-separated MAC addresses as uppercase hex', { skip: !integrationReady }, async () => {
  const owner = await createEmployee()
  const inputs = ['aabbccddeeff', '11:22:33:44:55:66']
  const expected = ['AABBCCDDEEFF', '112233445566']
  for (let index = 0; index < inputs.length; index += 1) {
    const response = await request('/requests', owner.token, {
      method: 'POST',
      body: formData({ macAddress: inputs[index] }),
    })
    assert.equal(response.status, 201)
    const { request: created } = await response.json()
    const stored = await pool.query('SELECT mac_address FROM laptop_requests WHERE request_id=$1', [created.request_id])
    assert.equal(stored.rows[0].mac_address, expected[index])
    assert.match(stored.rows[0].mac_address, /^[0-9A-F]{12}$/)
  }
})

test('MS Office key requires a valid normalized account email; keyless requests may omit it', { skip: !integrationReady }, async () => {
  const owner = await createEmployee()
  const missing = await request('/requests', owner.token, {
    method: 'POST', body: formData({ officeKey: 'ABCDE12345FGHIJ67890KLMNO' }),
  })
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error, 'MS Office account email is required when an MS Office key is entered.')

  const keyed = await request('/requests', owner.token, {
    method: 'POST', body: formData({ officeKey: 'ABCDE12345FGHIJ67890KLMNO', msOfficeAccountEmail: '  User.Name@Example.COM  ' }),
  })
  assert.equal(keyed.status, 201)
  const requestRow = (await keyed.json()).request
  assert.equal(requestRow.ms_office_account_email, 'user.name@example.com')

  const invalid = await request('/requests', owner.token, {
    method: 'POST', body: formData({ msOfficeAccountEmail: 'not-an-email' }),
  })
  assert.equal(invalid.status, 400)

  const keyless = await request('/requests', owner.token, { method: 'POST', body: formData() })
  assert.equal(keyless.status, 201)
  assert.equal((await keyless.json()).request.ms_office_account_email, null)
})

test('Engineer can register on behalf with owner, creator audit, employee lookup, and duplicate guards', { skip: !integrationReady }, async () => {
  const employee = await createEmployee()
  const engineer = await createEngineer()
  const tag = randomUUID().replaceAll('-', '').toUpperCase()
  const firstMac = tag.slice(0, 12)
  const duplicateMac = `${tag.slice(0, 10)}01`
  const apiRoot = baseUrl.replace(/\/employee$/, '')
  const search = await fetch(`${apiRoot}/engineer/employees/search?sapId=${employee.sapId}`, {
    headers: { authorization: `Bearer ${engineer.token}` },
  })
  assert.equal(search.status, 200)
  assert.equal((await search.json()).employee.sapId, employee.sapId)

  const register = (overrides = {}, token = engineer.token) => fetch(`${apiRoot}/engineer/requests/register`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: formData({ employeeSapId: employee.sapId, ...overrides }),
  })
  const first = await register({ serialNumber: `ONBEHALF-${tag.slice(0, 8)}-01`, macAddress: firstMac })
  assert.equal(first.status, 201)
  const created = (await first.json()).request
  assert.equal(created.ms_office_account_email, null)
  const saved = await pool.query(`SELECT owner_employee_id,registered_by_user_id,created_by_sap_id
    FROM laptop_requests WHERE request_id=$1`, [created.request_id])
  assert.equal(saved.rows[0].owner_employee_id, employee.employeeId)
  assert.equal(saved.rows[0].registered_by_user_id, engineer.userId)
  assert.equal(saved.rows[0].created_by_sap_id, engineer.sapId)
  const audit = await pool.query(`SELECT action FROM audit_log WHERE entity_id=$1`, [created.request_id])
  assert.ok(audit.rows.some((row) => row.action === 'registered_on_behalf'))
  const selfApproval = await fetch(`${apiRoot}/engineer/requests/${created.request_id}/decision`, {
    method: 'POST', headers: { authorization: `Bearer ${engineer.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', expectedVersion: 1 }),
  })
  assert.equal(selfApproval.status, 403)
  const otherEngineer = await createEngineer()
  const otherApproval = await fetch(`${apiRoot}/engineer/requests/${created.request_id}/decision`, {
    method: 'POST', headers: { authorization: `Bearer ${otherEngineer.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', expectedVersion: 1 }),
  })
  assert.equal(otherApproval.status, 200)
  assert.equal((await otherApproval.json()).request.status, 'PENDING_ADMIN')
  await pool.query("UPDATE laptop_requests SET status='NEEDS_ENGINEER_CORRECTION' WHERE request_id=$1", [created.request_id])

  const duplicateSerial = await register({ serialNumber: `ONBEHALF-${tag.slice(0, 8)}-01`, macAddress: duplicateMac })
  assert.equal(duplicateSerial.status, 409)
  const duplicateSerialBody = await duplicateSerial.json()
  assert.deepEqual(duplicateSerialBody.fieldErrors, { serialNumber: 'Serial number already exists.' })
  assert.equal(JSON.stringify(duplicateSerialBody).includes(employee.sapId), false)
  const duplicateAddress = await register({ serialNumber: `ONBEHALF-${tag.slice(0, 8)}-02`, macAddress: firstMac })
  assert.equal(duplicateAddress.status, 409)
  assert.deepEqual((await duplicateAddress.json()).fieldErrors, { macAddress: 'MAC address already exists.' })
  const forbidden = await register({ serialNumber: `ONBEHALF-${tag.slice(0, 8)}-03`, macAddress: `${tag.slice(0, 10)}02` }, employee.token)
  assert.equal(forbidden.status, 403)
})

test('employee registration validates inputs, encrypts typed license keys, stores a private invoice, and lists only owned requests', { skip: !integrationReady }, async () => {
  const owner = await createEmployee()
  const other = await createEmployee()
  const secretKey = 'ABCDE12345FGHIJ67890KLMNO'
  const response = await request('/requests', owner.token, {
    method: 'POST',
    body: formData({ windowsKey: secretKey, officeKey: 'ZYXWV09876UTSRQ54321ONMLK', msOfficeAccountEmail: 'office.owner@example.invalid' }),
  })
  assert.equal(response.status, 201)
  const created = await response.json()
  assert.equal(created.request.status, 'PENDING_ENGINEER')
  assert.equal(created.invoice.mimeType, 'application/pdf')

  const stored = await pool.query(
    `SELECT r.owner_employee_id, r.license_key_ciphertext, r.license_key_hmac,
            r.windows_license_key_ciphertext, r.windows_license_key_hmac,
            r.office_license_key_ciphertext, r.office_license_key_hmac,
            i.storage_key, i.sha256, i.size_bytes
     FROM laptop_requests r JOIN request_invoices i USING (request_id)
     WHERE r.request_id = $1`,
    [created.request.request_id],
  )
  assert.equal(stored.rows[0].owner_employee_id, owner.employeeId)
  assert.equal(stored.rows[0].license_key_ciphertext, null, 'new submissions do not write legacy key columns')
  assert.equal(stored.rows[0].license_key_hmac, null)
  assert.ok(stored.rows[0].windows_license_key_ciphertext)
  assert.ok(stored.rows[0].windows_license_key_hmac)
  assert.ok(stored.rows[0].office_license_key_ciphertext)
  assert.ok(stored.rows[0].office_license_key_hmac)
  assert.notEqual(stored.rows[0].windows_license_key_ciphertext.toString(), secretKey)
  assert.match(stored.rows[0].storage_key, /^[0-9a-f-]{36}\.pdf$/i)
  assert.equal(stored.rows[0].sha256.length, 32)
  const privateFile = await readFile(path.join(invoiceStorage, stored.rows[0].storage_key))
  assert.equal(privateFile.toString(), '%PDF-1.4\nsynthetic integration invoice\n%%EOF')

  const ownListResponse = await request('/requests', owner.token)
  assert.equal(ownListResponse.status, 200)
  const ownList = await ownListResponse.json()
  assert.equal(ownList.requests.length, 1)
  assert.equal(ownList.requests[0].requestId, created.request.request_id)
  assert.equal(ownList.requests[0].history[0].action, 'SUBMITTED')
  assert.equal(ownList.requests[0].invoices[0].fileId, created.invoice.fileId)

  const otherListResponse = await request('/requests', other.token)
  assert.deepEqual((await otherListResponse.json()).requests, [])
})

test('license keys accept plain or five-by-five dashes, normalize before encryption and fingerprinting, and reject invalid inputs', { skip: !integrationReady }, async () => {
  const owner = await createEmployee()
  const plain = 'ABCDE12345FGHIJ67890KLMNO'
  const grouped = 'abcde-12345-fghij-67890-klmno'
  const officePlain = 'ZYXWV09876UTSRQ54321ONMLK'
  const officeGrouped = 'zyxwv-09876-utsrq-54321-onmlk'
  const firstResponse = await request('/requests', owner.token, { method: 'POST', body: formData({ windowsKey: plain, officeKey: officePlain, msOfficeAccountEmail: 'office.owner@example.invalid' }) })
  const secondResponse = await request('/requests', owner.token, { method: 'POST', body: formData({ windowsKey: grouped, officeKey: officeGrouped, msOfficeAccountEmail: 'office.owner@example.invalid' }) })
  assert.equal(firstResponse.status, 201)
  assert.equal(secondResponse.status, 201)
  const [first, second] = await Promise.all([firstResponse.json(), secondResponse.json()])
  const stored = await pool.query(`SELECT windows_license_key_ciphertext AS ciphertext,windows_license_key_nonce AS nonce,
      windows_license_key_auth_tag AS auth_tag,windows_license_key_hmac AS hmac,
      office_license_key_ciphertext AS office_ciphertext,office_license_key_nonce AS office_nonce,
      office_license_key_auth_tag AS office_auth_tag,office_license_key_hmac AS office_hmac
    FROM laptop_requests WHERE request_id=ANY($1::uuid[]) ORDER BY serial_number`, [[first.request.request_id, second.request.request_id]])
  assert.equal(stored.rowCount, 2)
  assert.deepEqual(stored.rows[0].hmac, stored.rows[1].hmac)
  assert.deepEqual(stored.rows[0].office_hmac, stored.rows[1].office_hmac)
  const encryptionKey = /^[a-f0-9]{64}$/i.test(env.licenseEncryptionKey)
    ? Buffer.from(env.licenseEncryptionKey, 'hex') : Buffer.from(env.licenseEncryptionKey, 'base64')
  for (const row of stored.rows) {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, row.nonce)
    decipher.setAuthTag(row.auth_tag)
    const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8')
    assert.equal(plaintext, plain)
    const officeDecipher = createDecipheriv('aes-256-gcm', encryptionKey, row.office_nonce)
    officeDecipher.setAuthTag(row.office_auth_tag)
    const officeText = Buffer.concat([officeDecipher.update(row.office_ciphertext), officeDecipher.final()]).toString('utf8')
    assert.equal(officeText, officePlain)
  }
  const own = await (await request('/requests', owner.token)).json()
  const duplicateRequests = own.requests.filter((row) => [first.request.request_id, second.request.request_id].includes(row.requestId))
  assert.ok(duplicateRequests.every((row) => row.windowsKeyDuplicateWarning))
  assert.ok(duplicateRequests.every((row) => row.officeKeyDuplicateWarning))

  for (const [field, invalid] of [['windowsKey', 'ABCDE_12345_FGHIJ_67890_KLMNO'], ['officeKey', 'ABCDE-12345-FGHIJ-67890']]) {
    const invalidResponse = await request('/requests', owner.token, { method: 'POST', body: formData({ [field]: invalid }) })
    assert.equal(invalidResponse.status, 400)
    assert.match((await invalidResponse.json()).error, /^Invalid (Windows|MS Office) key\.$/)
  }
})

test('Windows keys are rejected for macOS submissions', { skip: !integrationReady }, async () => {
  const owner = await createEmployee()
  const response = await request('/requests', owner.token, {
    method: 'POST', body: formData({ operatingSystem: 'macOS', windowsKey: 'ABCDE12345FGHIJ67890KLMNO' }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /Windows key cannot be used with macOS/)
})

test('registration rejects invalid laptop data, invalid invoice content, and duplicate serial or MAC values', { skip: !integrationReady }, async () => {
  const owner = await createEmployee()
  const invalidMac = await request('/requests', owner.token, {
    method: 'POST', body: formData({ macAddress: 'bad-mac' }),
  })
  assert.equal(invalidMac.status, 400)
  const invalidSeparator = await request('/requests', owner.token, {
    method: 'POST', body: formData({ macAddress: 'AA-BB-CC-DD-EE-FF' }),
  })
  assert.equal(invalidSeparator.status, 400)

  const invalidInvoice = await request('/requests', owner.token, {
    method: 'POST', body: formData({}, Buffer.from('not a real PDF')),
  })
  assert.equal(invalidInvoice.status, 400)

  const oversizedInvoice = await request('/requests', owner.token, {
    method: 'POST', body: formData({}, Buffer.alloc(5 * 1024 * 1024 + 1, 65)),
  })
  assert.equal(oversizedInvoice.status, 413)

  const serial = `DUP-${randomUUID()}`
  const mac = `02:${randomUUID().replaceAll('-', '').slice(0, 10).match(/.{2}/g).join(':')}`
  const first = await request('/requests', owner.token, {
    method: 'POST', body: formData({ serialNumber: serial, macAddress: mac }),
  })
  assert.equal(first.status, 201)
  const duplicateSerial = await request('/requests', owner.token, {
    method: 'POST', body: formData({ serialNumber: ` ${serial.toLowerCase()} ` }),
  })
  assert.equal(duplicateSerial.status, 409)
  assert.deepEqual((await duplicateSerial.json()).fieldErrors, { serialNumber: 'Serial number already exists.' })
  const duplicateMac = await request('/requests', owner.token, {
    method: 'POST', body: formData({ macAddress: mac.replaceAll(':', '').toLowerCase() }),
  })
  assert.equal(duplicateMac.status, 409)
  assert.deepEqual((await duplicateMac.json()).fieldErrors, { macAddress: 'MAC address already exists.' })
})

test('employee invoice upload checks ownership and keeps files private with generated names and hashes', { skip: !integrationReady }, async () => {
  const owner = await createEmployee()
  const other = await createEmployee()
  const createdResponse = await request('/requests', owner.token, {
    method: 'POST', body: formData(),
  })
  const created = await createdResponse.json()
  await pool.query(
    `UPDATE laptop_requests SET status = 'NEEDS_EMPLOYEE_CORRECTION'
     WHERE request_id = $1`,
    [created.request.request_id],
  )

  const forbidden = await request(`/requests/${created.request.request_id}/invoice`, other.token, {
    method: 'POST', body: formData({ expectedVersion: '1' }),
  })
  assert.equal(forbidden.status, 404)

  const uploadedBytes = Buffer.from('%PDF-1.5\nsecond synthetic invoice\n%%EOF')
  const uploaded = await request(`/requests/${created.request.request_id}/invoice`, owner.token, {
    method: 'POST', body: formData({ expectedVersion: '1' }, uploadedBytes),
  })
  assert.equal(uploaded.status, 201)
  const invoice = (await uploaded.json()).invoice
  const record = await pool.query(
    'SELECT storage_key, sha256, size_bytes FROM request_invoices WHERE file_id = $1',
    [invoice.fileId],
  )
  assert.equal(record.rows[0].sha256.toString('hex'), createHash('sha256').update(uploadedBytes).digest('hex'))
  assert.equal(Number(record.rows[0].size_bytes), uploadedBytes.length)
  assert.match(record.rows[0].storage_key, /^[0-9a-f-]{36}\.pdf$/i)
})

test('employee routes reject engineer tokens using the database role', { skip: !integrationReady }, async () => {
  const tag = randomUUID()
  const engineer = await pool.query(
    `INSERT INTO users (sap_id, email, role) VALUES ($1, $2, 'engineer') RETURNING user_id`,
    [`EN${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`, `engineer-${tag}@example.invalid`],
  )
  const token = jwt.sign({ sub: engineer.rows[0].user_id, role: 'employee' }, env.jwtSecret, { expiresIn: '5m' })
  const response = await request('/requests', token)
  assert.equal(response.status, 403)
})
