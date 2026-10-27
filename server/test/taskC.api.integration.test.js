import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import test, { after, before } from 'node:test'
import jwt from 'jsonwebtoken'
import { app } from '../src/app.js'
import { env } from '../src/config/env.js'
import { pool } from '../src/db/pool.js'

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
  await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
  await pool.end()
})

async function actor(role) {
  const tag = randomUUID(), sapId = `TC${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`
  const u = await pool.query('INSERT INTO users(sap_id,email,role) VALUES($1,$2,$3) RETURNING user_id', [sapId, `${tag}@example.invalid`, role])
  const value = { userId: u.rows[0].user_id, sapId, role }
  if (role === 'employee') {
    const e = await pool.query(`INSERT INTO employees(user_id,sap_id,employee_name,email,designation,employee_category,department)
      VALUES($1,$2,'Synthetic Task C Employee',$3,'Tester','Executive','Integration') RETURNING employee_id`, [value.userId,sapId,`${tag}@example.invalid`])
    value.employeeId = e.rows[0].employee_id
  }
  value.token = jwt.sign({ sub: value.userId, role: 'employee' }, env.jwtSecret, { expiresIn: '5m' })
  return value
}
async function api(path, user, method = 'GET', body) {
  return fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${user.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
}
async function json(response) { return response.json() }
function unzipWorkbook(buffer) {
  const files = new Map()
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034B50) {
    const method = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength)
    const dataStart = nameStart + nameLength + extraLength
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    files.set(name, method === 8 ? inflateRawSync(compressed).toString('utf8') : compressed.toString('utf8'))
    offset = dataStart + compressedSize
  }
  return files
}
async function clearance(admin, employee) {
  const r = await api('/admin/retirement-clearances', admin, 'POST', { sapId: employee.sapId, reason: 'Retirement' })
  assert.equal(r.status, 201)
  const value = (await json(r)).clearance
  return { ...value, clearance_id: value.clearance_id ?? value.clearanceId }
}
async function checks(clearanceId) {
  return (await pool.query('SELECT check_id,check_key,is_mandatory,is_complete FROM retirement_clearance_checks WHERE clearance_id=$1 ORDER BY check_key', [clearanceId])).rows
}

test('reports paginate/filter and warn on duplicate typed HMAC without exposing fingerprints or key values', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin')
  const hmac = Buffer.from(`synthetic-${randomUUID()}`)
  const ids = []
  for (let i = 0; i < 2; i += 1) {
    const row = await pool.query(`INSERT INTO laptop_requests(owner_employee_id,serial_number,purchase_date,model_number,mac_address,operating_system,office_license_key_ciphertext,office_license_key_nonce,office_license_key_auth_tag,office_license_key_hmac)
      VALUES($1,$2,CURRENT_DATE,'Model',$3,'Windows',$4,$5,$6,$7) RETURNING request_id`, [employee.employeeId,`TC-${randomUUID()}`,randomUUID().replaceAll('-','').slice(0,12).toUpperCase(),Buffer.from('cipher'),Buffer.alloc(12,1),Buffer.alloc(16,2),hmac])
    ids.push(row.rows[0].request_id)
  }
  const response = await api(`/admin/reports?duplicateOnly=true&sapId=${employee.sapId}&limit=1`, admin)
  assert.equal(response.status, 200)
  const page = await json(response)
  assert.equal(page.reports.length, 1); assert.equal(page.pagination.total, 2)
  assert.equal(page.reports[0].duplicateLicenseWarning, true)
  assert.equal(JSON.stringify(page).includes(hmac.toString()), false)
  assert.equal(Object.hasOwn(page.reports[0], 'licenseKey'), false)
})

test('duplicate key comparison matches within a key type and never across Windows and Office', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin')
  const sharedFingerprint = Buffer.from(`TYPE_MATCH_${randomUUID()}`)
  const addRequest = async (type, fingerprint) => pool.query(`INSERT INTO laptop_requests(
      owner_employee_id,serial_number,purchase_date,model_number,mac_address,operating_system,
      ${type}_license_key_ciphertext,${type}_license_key_nonce,${type}_license_key_auth_tag,${type}_license_key_hmac)
    VALUES($1,$2,CURRENT_DATE,'Typed duplicate model',$3,'Windows',decode('01','hex'),decode(repeat('01',12),'hex'),decode(repeat('02',16),'hex'),$4)
    RETURNING request_id`, [employee.employeeId, `TYPED-${randomUUID()}`, randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(), fingerprint])
  const windowsOne = await addRequest('windows', sharedFingerprint)
  const office = await addRequest('office', sharedFingerprint)
  const windowsTwo = await addRequest('windows', sharedFingerprint)
  const response = await api('/admin/reports?limit=100', admin)
  assert.equal(response.status, 200)
  const reports = (await json(response)).reports
  const byId = new Map(reports.map((row) => [row.requestId, row]))
  assert.equal(byId.get(windowsOne.rows[0].request_id).windowsKeyDuplicateWarning, true)
  assert.equal(byId.get(windowsTwo.rows[0].request_id).windowsKeyDuplicateWarning, true)
  assert.equal(byId.get(office.rows[0].request_id).officeKeyDuplicateWarning, false)
  assert.equal(byId.get(office.rows[0].request_id).duplicateLicenseWarning, false)
})

test('Admin Excel export applies filters, audits filters only, rejects other roles, and excludes secret and invoice data', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin'), engineer = await actor('engineer')
  const matchingHmac = Buffer.from(`EXPORT_HMAC_CANARY_${randomUUID()}`)
  const secretCiphertext = Buffer.from(`EXPORT_CIPHERTEXT_CANARY_${randomUUID()}`)
  const invoiceName = `EXPORT_INVOICE_CANARY_${randomUUID()}.pdf`
  const storageKey = `EXPORT_STORAGE_CANARY_${randomUUID()}`
  const formulaSerial = '=1+1'

  await pool.query("UPDATE employees SET employee_name=$1,designation=$2,department=$3,employee_category='JO' WHERE employee_id=$4", [
    'Komal Synthetic', '+Synthetic Export Tester', '@Export Test Department', employee.employeeId,
  ])
  const insertReportRequest = async ({ serial, model, mac, status, hmac }) => {
    const result = await pool.query(`INSERT INTO laptop_requests (
      owner_employee_id,serial_number,purchase_date,model_number,mac_address,operating_system,status,
      windows_license_key_ciphertext,windows_license_key_nonce,windows_license_key_auth_tag,windows_license_key_hmac
    ) VALUES ($1,$2,CURRENT_DATE,$3,$4,'Windows',$5,$6,$7,$8,$9) RETURNING request_id`, [
      employee.employeeId, serial, model, mac, status, secretCiphertext, Buffer.alloc(12, 3), Buffer.alloc(16, 4), hmac,
    ])
    return result.rows[0].request_id
  }
  const matchingRequest = await insertReportRequest({
    serial: formulaSerial, model: '+SUM(1,1)', mac: '00AABBCCDDEE', status: 'PENDING_ENGINEER', hmac: matchingHmac,
  })
  await pool.query('UPDATE laptop_requests SET ms_office_account_email=$1 WHERE request_id=$2', ['office.owner@example.invalid', matchingRequest])
  await insertReportRequest({
    serial: `FILTERED-STATUS-${randomUUID()}`, model: 'Status excluded', mac: '11AABBCCDDEE', status: 'NEEDS_EMPLOYEE_CORRECTION', hmac: matchingHmac,
  })
  await insertReportRequest({
    serial: `FILTERED-DUPLICATE-${randomUUID()}`, model: 'No duplicate', mac: '22AABBCCDDEE', status: 'PENDING_ENGINEER', hmac: Buffer.from(`UNIQUE_${randomUUID()}`),
  })
  await pool.query(`INSERT INTO approval_history(request_id,actor_user_id,actor_sap_id,action,remarks,new_status)
    VALUES ($1,$2,$3,'engineer_edit','-Latest remark formula canary','PENDING_ENGINEER')`, [matchingRequest, engineer.userId, engineer.sapId])
  await pool.query(`INSERT INTO audit_log(actor_user_id,actor_sap_id,action,entity_type,entity_id,details)
    VALUES ($1,$2,'laptop_request_submitted','laptop_request',$3,'{}'::jsonb),
           ($1,$2,'laptop_request_edited','laptop_request',$3,'{}'::jsonb)`, [employee.userId, employee.sapId, matchingRequest])
  await pool.query(`INSERT INTO request_invoices(request_id,storage_key,original_name,mime_type,size_bytes,sha256,uploaded_by_user_id)
    VALUES ($1,$2,$3,'application/x-invoice-canary',982451,$4,$5)`, [matchingRequest, storageKey, invoiceName, Buffer.from(`EXPORT_SHA_CANARY_${randomUUID()}`), employee.userId])

  const query = `?status=PENDING_ENGINEER&sapId=${employee.sapId}&duplicateOnly=true`
  const engineerResponse = await api(`/admin/reports/export.xlsx${query}`, engineer)
  const employeeResponse = await api(`/admin/reports/export.xlsx${query}`, employee)
  assert.equal(engineerResponse.status, 403)
  assert.equal(employeeResponse.status, 403)

  const response = await api(`/admin/reports/export.xlsx${query}`, admin)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.match(response.headers.get('content-disposition') ?? '', /laptop-report-\d{4}-\d{2}-\d{2}\.xlsx/)
  const workbook = Buffer.from(await response.arrayBuffer())
  assert.equal(workbook.readUInt32LE(0), 0x04034B50)
  const files = unzipWorkbook(workbook)
  assert.ok(files.has('xl/workbook.xml'))
  const sheet = files.get('xl/worksheets/sheet1.xml')
  assert.ok(sheet)
  assert.equal((sheet.match(/<row /g) ?? []).length, 2, 'headers plus exactly one matching report row')
  for (const header of ['SAP ID','Employee Name','Designation','Category','Department','Serial Number','Model Number','MAC Address','Operating System','Purchase Date','Windows Key Provided','Windows Key Duplicate Check','MS Office Key Provided','MS Office Key Duplicate Check','Status','Latest Remarks','Created By','Updated By','Created Date','Updated Date','MS Office Account Email']) {
    assert.ok(sheet.includes(header), `missing export column ${header}`)
  }
  assert.ok(!sheet.includes('Legacy Key'), 'Legacy Key is omitted when none of the exported records has a legacy key')
  assert.equal(sheet.includes('Request ID'), false)
  assert.equal(sheet.includes(matchingRequest), false, 'internal request UUID is not exported')
  assert.ok(sheet.includes('00AABBCCDDEE'), 'MAC is exported as a text value')
  assert.match(sheet, /<c r="A2" s="0" t="inlineStr">/, 'SAP ID is explicitly stored as text')
  assert.match(sheet, /<c r="F2" s="0" t="inlineStr">/, 'serial number is explicitly stored as text')
  assert.match(sheet, /<c r="H2" s="0" t="inlineStr">/, 'MAC cell is explicitly stored as text')
  assert.ok(sheet.includes('Pending Engineer'), 'status is human readable')
  assert.ok(sheet.includes('JO (Junior Officer)'), 'JO category displays with its label')
  assert.ok(sheet.includes('Komal Synthetic (' + employee.sapId + ')'), 'creator name is looked up and paired with SAP ID')
  assert.ok(sheet.includes('Komal Synthetic (' + employee.sapId + ')'), 'updater name is looked up and paired with SAP ID')
  assert.ok(files.get('xl/worksheets/sheet1.xml').includes('state="frozen"'), 'header row is frozen')
  assert.ok(files.get('xl/worksheets/sheet1.xml').includes('<col min="1" max="1" width="14" customWidth="1"/>'), 'sensible column widths are included')
  assert.ok(files.get('xl/styles.xml').includes('<b/>'), 'header style is bold')
  assert.match(sheet, /\d{2} [A-Z][a-z]{2} \d{4}/, 'dates use DD MMM YYYY text format')
  assert.ok(sheet.includes('&apos;=1+1'), 'formula-like text is prefixed with an apostrophe')
  assert.ok(sheet.includes('&apos;+Synthetic Export Tester'))
  assert.ok(sheet.includes('&apos;@Export Test Department'))
  assert.ok(sheet.includes('&apos;-Latest remark formula canary'))
  assert.ok(sheet.includes('Yes'))
  assert.ok(sheet.includes('Duplicate match'))
  assert.ok(sheet.includes('office.owner@example.invalid'), 'Office account email is exported')
  const sheetText = Object.values(files).join('\n')
  for (const forbidden of [secretCiphertext.toString(), matchingHmac.toString(), storageKey, invoiceName, 'application/x-invoice-canary', '982451', 'EXPORT_SHA_CANARY']) {
    assert.equal(sheetText.includes(forbidden), false, `export leaked forbidden value ${forbidden}`)
  }

  await pool.query(`INSERT INTO audit_log(actor_user_id,actor_sap_id,action,entity_type,entity_id,details)
    VALUES (NULL,'SYSTEM','system_update','laptop_request',$1,'{}'::jsonb)`, [matchingRequest])
  const fallbackTag = randomUUID()
  const fallbackRequest = await pool.query(`INSERT INTO laptop_requests (
      owner_employee_id,serial_number,purchase_date,model_number,mac_address,operating_system,status,
      windows_license_key_ciphertext,windows_license_key_nonce,windows_license_key_auth_tag,windows_license_key_hmac)
    VALUES ($1,$2,CURRENT_DATE,'Fallback actor synthetic',$3,'Windows','PENDING_ENGINEER',$4,$5,$6,$7) RETURNING request_id`, [
    employee.employeeId, `000${fallbackTag.slice(0, 8)}`, fallbackTag.replaceAll('-', '').slice(0, 12).toUpperCase(),
    secretCiphertext, Buffer.alloc(12, 3), Buffer.alloc(16, 4), matchingHmac,
  ])
  await pool.query(`INSERT INTO audit_log(actor_user_id,actor_sap_id,action,entity_type,entity_id,details)
    VALUES (NULL,'NOEMP001','laptop_request_submitted','laptop_request',$1,'{}'::jsonb)`, [fallbackRequest.rows[0].request_id])
  const legacyUnknownTag = randomUUID()
  await pool.query(`INSERT INTO laptop_requests (
      owner_employee_id,serial_number,purchase_date,model_number,mac_address,operating_system,status,
      windows_license_key_ciphertext,windows_license_key_nonce,windows_license_key_auth_tag,windows_license_key_hmac)
    VALUES ($1,$2,CURRENT_DATE,'Unknown legacy actor synthetic',$3,'Windows','PENDING_ENGINEER',$4,$5,$6,$7)`, [
    employee.employeeId, `LEGACY-${legacyUnknownTag.slice(0, 8)}`, legacyUnknownTag.replaceAll('-', '').slice(0, 12).toUpperCase(),
    secretCiphertext, Buffer.alloc(12, 4), Buffer.alloc(16, 5), matchingHmac,
  ])
  const actorResponse = await api(`/admin/reports/export.xlsx${query}`, admin)
  const actorSheet = unzipWorkbook(Buffer.from(await actorResponse.arrayBuffer())).get('xl/worksheets/sheet1.xml')
  assert.ok(actorSheet.includes('System'), 'SYSTEM actor displays as System')
  assert.ok(actorSheet.includes('NOEMP001'), 'SAP ID is shown alone when no employee name exists')
  assert.ok(actorSheet.includes('Unknown (legacy)'), 'missing historical actor displays as Unknown (legacy)')

  await pool.query(`UPDATE laptop_requests SET license_key_ciphertext=$1,license_key_nonce=$2,license_key_auth_tag=$3,license_key_hmac=$4 WHERE request_id=$5`, [
    Buffer.from(`LEGACY_CIPHER_${randomUUID()}`), Buffer.alloc(12, 7), Buffer.alloc(16, 8), Buffer.from(`LEGACY_HMAC_${randomUUID()}`), matchingRequest,
  ])
  const legacyResponse = await api(`/admin/reports/export.xlsx${query}`, admin)
  assert.equal(legacyResponse.status, 200)
  const legacyFiles = unzipWorkbook(Buffer.from(await legacyResponse.arrayBuffer()))
  assert.ok(legacyFiles.get('xl/worksheets/sheet1.xml').includes('Legacy Key'), 'Legacy Key column appears when an exported row has a legacy key')

  const audit = await pool.query(`SELECT details FROM audit_log
    WHERE actor_user_id=$1 AND action='report_exported' ORDER BY audit_log_id DESC LIMIT 1`, [admin.userId])
  assert.equal(audit.rowCount, 1)
  assert.deepEqual(audit.rows[0].details, { filters: { status: 'PENDING_ENGINEER', sapId: employee.sapId, from: null, to: null, duplicateOnly: 'true' } })
  const auditDetails = JSON.stringify(audit.rows[0].details)
  assert.equal(auditDetails.includes(formulaSerial), false)
  assert.equal(auditDetails.includes(matchingRequest), false)
})

test('admin creates profiles for every role and can create or edit legacy profiles atomically with audit', { skip: !ready }, async () => {
  const first = await actor('admin'), second = await actor('admin')
  const invalidSapId = await api('/admin/accounts', first, 'POST', { sapId: 'TOOSHRT', email: 'invalid@example.invalid', role: 'engineer' })
  assert.equal(invalidSapId.status, 400)
  await pool.query("UPDATE users SET is_active=false WHERE role='admin' AND is_active=true AND user_id NOT IN ($1,$2)", [first.userId, second.userId])
  const employeeTag = randomUUID()
  const created = await api('/admin/accounts', first, 'POST', { sapId: `NE${employeeTag.replaceAll('-', '').slice(0, 6).toUpperCase()}`, email: `${employeeTag}@example.invalid`, role: 'employee', employeeName: 'Synthetic New Employee', designation: 'Tester', employeeCategory: 'JO', department: 'Integration' })
  assert.equal(created.status, 201)
  const createdBody = await json(created)
  const profile = await pool.query('SELECT employee_id FROM employees WHERE user_id=$1', [createdBody.account.userId])
  assert.equal(profile.rowCount, 1)
  assert.equal(createdBody.account.employeeCategory, 'JO')
  const engineerTag = randomUUID()
  const engineerCreated = await api('/admin/accounts', first, 'POST', {
    sapId: `NG${engineerTag.replaceAll('-', '').slice(0, 6).toUpperCase()}`, email: `${engineerTag}@example.invalid`, role: 'engineer',
    employeeName: 'Synthetic Engineer', designation: 'Engineer', employeeCategory: 'Executive', department: 'Engineering',
  })
  assert.equal(engineerCreated.status, 201)
  const engineerAccount = (await json(engineerCreated)).account
  const listed = await api(`/admin/accounts?q=${engineerAccount.sapId}`, first)
  const engineerListed = (await json(listed)).accounts[0]
  assert.equal(engineerListed.sapId, engineerAccount.sapId)
  assert.equal(engineerListed.employeeName, 'Synthetic Engineer')
  const missingProfileTag = randomUUID()
  const missingProfileUser = await pool.query(`INSERT INTO users(sap_id,email,role) VALUES($1,$2,'admin') RETURNING user_id,sap_id`, [
    `LP${missingProfileTag.replaceAll('-', '').slice(0, 6).toUpperCase()}`, `${missingProfileTag}@example.invalid`,
  ])
  const profileValues = { employeeName: 'Synthetic Legacy Admin', designation: 'Administrator', employeeCategory: 'JO', department: 'Administration' }
  const createdProfile = await api(`/admin/accounts/${missingProfileUser.rows[0].user_id}/profile`, first, 'PATCH', profileValues)
  assert.equal(createdProfile.status, 200)
  const createdProfileBody = await json(createdProfile)
  assert.equal(createdProfileBody.account.employeeName, profileValues.employeeName)
  assert.equal(createdProfileBody.account.employeeCategory, 'JO')
  const updatedProfile = await api(`/admin/accounts/${missingProfileUser.rows[0].user_id}/profile`, first, 'PATCH', { ...profileValues, employeeName: 'Updated Synthetic Admin' })
  assert.equal(updatedProfile.status, 200)
  const engineerActor = await actor('engineer')
  const forbiddenProfileEdit = await api(`/admin/accounts/${missingProfileUser.rows[0].user_id}/profile`, engineerActor, 'PATCH', profileValues)
  assert.equal(forbiddenProfileEdit.status, 403)
  const listedAdmin = await api(`/admin/accounts?q=${missingProfileUser.rows[0].sap_id}`, first)
  const listedAdminBody = await json(listedAdmin)
  assert.equal(listedAdminBody.accounts[0].employeeName, 'Updated Synthetic Admin')
  assert.equal(listedAdminBody.accounts[0].employeeCategory, 'JO')
  const profileRows = await pool.query('SELECT COUNT(*)::int AS count FROM employees WHERE user_id=$1', [missingProfileUser.rows[0].user_id])
  assert.equal(profileRows.rows[0].count, 1)
  const profileAudits = await pool.query(`SELECT action,details->'changedFields' AS changed_fields FROM audit_log WHERE entity_id=$1 ORDER BY audit_log_id`, [missingProfileUser.rows[0].user_id])
  assert.deepEqual(profileAudits.rows.map((row) => row.action), ['account_profile_created', 'account_profile_updated'])
  assert.deepEqual(profileAudits.rows[0].changed_fields, ['employeeName','designation','employeeCategory','department'])
  await pool.query('UPDATE users SET is_active=false WHERE user_id=$1', [missingProfileUser.rows[0].user_id])
  const missingFields = await api('/admin/accounts', first, 'POST', {
    sapId: `MF${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`, email: `${randomUUID()}@example.invalid`, role: 'admin',
  })
  assert.equal(missingFields.status, 400)
  const self = await api(`/admin/accounts/${first.userId}`, first, 'PATCH', { isActive: false })
  assert.equal(self.status, 409)
  const secondSelf = await api(`/admin/accounts/${second.userId}`, second, 'PATCH', { role: 'engineer' })
  assert.equal(secondSelf.status, 409)

  const outcomes = await Promise.all([
    api(`/admin/accounts/${second.userId}`, first, 'PATCH', { isActive: false }),
    api(`/admin/accounts/${first.userId}`, second, 'PATCH', { isActive: false }),
  ])
  const statuses = await Promise.all(outcomes.map((r) => r.status))
  assert.ok(statuses.includes(200))
  assert.ok(statuses.some((s) => s === 409 || s === 401))
  const remaining = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND is_active=true")
  assert.ok(remaining.rows[0].n >= 1)
  const logs = await pool.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE entity_type='user' AND entity_id=$1", [createdBody.account.userId])
  assert.equal(logs.rows[0].n, 1)
  const adminTag = randomUUID()
  const adminCreated = await api('/admin/accounts', first, 'POST', {
    sapId: `NA${adminTag.replaceAll('-', '').slice(0, 6).toUpperCase()}`, email: `${adminTag}@example.invalid`, role: 'admin',
    employeeName: 'Synthetic New Admin', designation: 'Administrator', employeeCategory: 'Executive', department: 'Administration',
  })
  assert.equal(adminCreated.status, 201)
  const createdAdmin = (await json(adminCreated)).account
  const adminProfile = await pool.query('SELECT employee_name FROM employees WHERE user_id=$1', [createdAdmin.userId])
  assert.equal(adminProfile.rows[0].employee_name, 'Synthetic New Admin')
})

test('unique SAP ID and email conflicts return only their matching field errors', { skip: !ready }, async () => {
  const admin = await actor('admin')
  const tag = randomUUID()
  const sapId = `UX${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`
  const email = `unique-${tag}@example.invalid`
  const accountData = (overrides = {}) => ({
    sapId, email, role: 'employee', employeeName: 'Synthetic Unique Check',
    designation: 'Tester', employeeCategory: 'Executive', department: 'Integration', ...overrides,
  })
  const created = await api('/admin/accounts', admin, 'POST', accountData())
  assert.equal(created.status, 201)

  const duplicateSapId = await api('/admin/accounts', admin, 'POST', accountData({ email: `new-${tag}@example.invalid` }))
  assert.equal(duplicateSapId.status, 409)
  const sapError = await json(duplicateSapId)
  assert.equal(sapError.error, 'SAP ID already exists.')
  assert.deepEqual(sapError.fieldErrors, { sapId: 'SAP ID already exists.' })
  assert.equal(JSON.stringify(sapError).includes(email), false)

  // The baseline schema has no unique email index. Add one only to this isolated
  // test database to exercise the same PostgreSQL unique-violation path.
  await pool.query('CREATE UNIQUE INDEX integration_test_users_email_unique_idx ON users (lower(email))')
  try {
    const duplicateEmail = await api('/admin/accounts', admin, 'POST', accountData({
      sapId: `UE${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`,
    }))
    assert.equal(duplicateEmail.status, 409)
    const emailError = await json(duplicateEmail)
    assert.equal(emailError.error, 'Email address already exists.')
    assert.deepEqual(emailError.fieldErrors, { email: 'Email address already exists.' })
    assert.equal(JSON.stringify(emailError).includes(sapId), false)
  } finally {
    await pool.query('DROP INDEX IF EXISTS integration_test_users_email_unique_idx')
  }
})

test('clearance API exposes exactly the two mandatory removal checks and blocks finalization until both are complete', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin')
  const c = await clearance(admin, employee)
  let list = await checks(c.clearance_id)
  assert.deepEqual(list.map((check) => check.check_key).sort(), ['antivirus_removal', 'company_software_removal'])
  assert.ok(list.every((check) => check.is_mandatory && !check.is_complete))
  await pool.query(`INSERT INTO retirement_clearance_checks (clearance_id,check_key,check_label,is_mandatory)
    VALUES ($1,'license_check','Legacy license check',FALSE),($1,'asset_return','Legacy asset return',FALSE)`, [c.clearance_id])
  const visible = await api(`/admin/retirement-clearances?sapId=${employee.sapId}`, admin)
  assert.equal(visible.status, 200)
  const visibleChecks = (await json(visible)).clearances[0].checks
  assert.deepEqual(visibleChecks.map((check) => check.checkKey).sort(), ['antivirus_removal', 'company_software_removal'])
  assert.ok(visibleChecks.every((check) => check.isMandatory))
  const extraCheck = await api('/admin/retirement-clearances', admin, 'POST', { sapId: employee.sapId, reason: 'Retirement', additionalChecks: [{ checkKey: 'extra', checkLabel: 'Extra', isMandatory: true }] })
  assert.equal(extraCheck.status, 400)
  const blocked = await api(`/admin/retirement-clearances/${c.clearance_id}/clear`, admin, 'POST', { remarks: 'Attempt before checks complete' })
  assert.equal(blocked.status, 409)
  const incomplete = list[0]
  const update = await api(`/admin/retirement-clearances/${c.clearance_id}/checks/${incomplete.check_id}`, admin, 'PATCH', { isComplete: true, remarks: 'Synthetic check complete' })
  assert.equal(update.status, 200)
  const log = await pool.query("SELECT action,details->>'checkKey' AS key FROM audit_log WHERE entity_type='retirement_clearance_check' AND entity_id=$1 ORDER BY audit_log_id DESC LIMIT 1", [incomplete.check_id])
  assert.equal(log.rows[0].action, 'retirement_check_updated'); assert.equal(log.rows[0].key, incomplete.check_key)
  const stillBlocked = await api(`/admin/retirement-clearances/${c.clearance_id}/clear`, admin, 'POST', { remarks: 'Only one of two complete' })
  assert.equal(stillBlocked.status, 409)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SAVEPOINT mandatory_delete')
    await assert.rejects(client.query('DELETE FROM retirement_clearance_checks WHERE check_id=$1', [list.find((x) => x.is_mandatory).check_id]), /mandatory retirement checks cannot be deleted/)
    await client.query('ROLLBACK TO SAVEPOINT mandatory_delete')
    await client.query('RELEASE SAVEPOINT mandatory_delete')
    await client.query('ROLLBACK')
  } finally { client.release() }

  const zeroEmployee = await actor('employee')
  const zero = await pool.query("INSERT INTO retirement_clearances(employee_id,created_by_sap_id,reason) VALUES($1,$2,'Retirement') RETURNING clearance_id", [zeroEmployee.employeeId,admin.sapId])
  const noChecks = await api(`/admin/retirement-clearances/${zero.rows[0].clearance_id}/clear`, admin, 'POST', { remarks: 'No checks exist' })
  assert.equal(noChecks.status, 409)
})

test('clearance reason is required at creation and before final approval', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin')
  const missingReason = await api('/admin/retirement-clearances', admin, 'POST', { sapId: employee.sapId })
  assert.equal(missingReason.status, 400)
  const c = await clearance(admin, employee)
  await pool.query('UPDATE retirement_clearances SET reason=NULL WHERE clearance_id=$1', [c.clearanceId])
  const rows = await checks(c.clearanceId)
  for (const row of rows) {
    const result = await api(`/admin/retirement-clearances/${c.clearanceId}/checks/${row.check_id}`, admin, 'PATCH', { isComplete: true, remarks: 'Synthetic required check complete' })
    assert.equal(result.status, 200)
  }
  const noReasonAtFinalization = await api(`/admin/retirement-clearances/${c.clearanceId}/clear`, admin, 'POST', { remarks: 'No reason supplied' })
  assert.equal(noReasonAtFinalization.status, 400)
  const withReason = await api(`/admin/retirement-clearances/${c.clearanceId}/clear`, admin, 'POST', { reason: 'Transfer', remarks: 'Synthetic reason supplied' })
  assert.equal(withReason.status, 200)
  assert.equal((await json(withReason)).clearance.reason, 'Transfer')
})

test('searching twice for the same SAP ID returns the existing open clearance', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin')
  const firstSearch = await api(`/admin/retirement-clearances?sapId=${employee.sapId}`, admin)
  assert.equal(firstSearch.status, 200)
  assert.deepEqual((await json(firstSearch)).clearances, [])

  const created = await api('/admin/retirement-clearances', admin, 'POST', { sapId: employee.sapId, reason: 'Retirement' })
  assert.equal(created.status, 201)
  const clearanceId = (await json(created)).clearance.clearanceId

  const secondSearch = await api(`/admin/retirement-clearances?sapId=${employee.sapId}`, admin)
  assert.equal(secondSearch.status, 200)
  const secondSearchResults = (await json(secondSearch)).clearances
  assert.equal(secondSearchResults.length, 1)
  assert.equal(secondSearchResults[0].clearanceId, clearanceId)
  assert.equal(secondSearchResults[0].status, 'BLOCKED')

  const repeatedCreate = await api('/admin/retirement-clearances', admin, 'POST', { sapId: employee.sapId, reason: 'Retirement' })
  assert.equal(repeatedCreate.status, 200)
  assert.equal((await json(repeatedCreate)).clearance.clearanceId, clearanceId)
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM retirement_clearances WHERE employee_id=$1', [employee.employeeId])
  assert.equal(count.rows[0].count, 1)
})

test('search and create return an existing CLEARED clearance instead of conflicting', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin'), existing = await clearance(admin, employee)
  for (const check of await checks(existing.clearanceId)) {
    const updated = await api(`/admin/retirement-clearances/${existing.clearanceId}/checks/${check.check_id}`, admin, 'PATCH', { isComplete: true, remarks: 'Synthetic retirement check complete' })
    assert.equal(updated.status, 200)
  }
  const finalized = await api(`/admin/retirement-clearances/${existing.clearanceId}/clear`, admin, 'POST', { remarks: 'Synthetic clearance officer remarks' })
  assert.equal(finalized.status, 200)

  const search = await api(`/admin/retirement-clearances?sapId=${employee.sapId}`, admin)
  assert.equal(search.status, 200)
  const results = (await json(search)).clearances
  assert.equal(results.length, 1)
  assert.equal(results[0].clearanceId, existing.clearanceId)
  assert.equal(results[0].status, 'CLEARED')

  const repeatedCreate = await api('/admin/retirement-clearances', admin, 'POST', { sapId: employee.sapId, reason: 'Retirement' })
  assert.equal(repeatedCreate.status, 200)
  const returned = (await json(repeatedCreate)).clearance
  assert.equal(returned.clearanceId, existing.clearanceId)
  assert.equal(returned.status, 'CLEARED')
})

test('concurrent clearance creates return one shared record without a unique-conflict response', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin')
  const responses = await Promise.all([
    api('/admin/retirement-clearances', admin, 'POST', { sapId: employee.sapId, reason: 'Retirement' }),
    api('/admin/retirement-clearances', admin, 'POST', { sapId: employee.sapId, reason: 'Retirement' }),
  ])
  const statuses = responses.map((response) => response.status).sort()
  assert.deepEqual(statuses, [200, 201])
  const payloads = await Promise.all(responses.map(json))
  assert.equal(payloads[0].clearance.clearanceId, payloads[1].clearance.clearanceId)
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM retirement_clearances WHERE employee_id=$1', [employee.employeeId])
  assert.equal(count.rows[0].count, 1)
})

test('cleared clearance and its checks are locked against later changes', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin'), c = await clearance(admin, employee)
  const rows = await checks(c.clearance_id)
  for (const check of rows) {
    const r = await api(`/admin/retirement-clearances/${c.clearance_id}/checks/${check.check_id}`, admin, 'PATCH', { isComplete: true, remarks: 'Synthetic complete' })
    assert.equal(r.status, 200)
  }
  const done = await api(`/admin/retirement-clearances/${c.clearance_id}/clear`, admin, 'POST', { remarks: 'Officer synthetic clearance' })
  assert.equal(done.status, 200)
  const change = await api(`/admin/retirement-clearances/${c.clearance_id}/checks/${rows[0].check_id}`, admin, 'PATCH', { isComplete: false })
  assert.equal(change.status, 409)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SAVEPOINT cleared_update')
    await assert.rejects(client.query("UPDATE retirement_clearances SET remarks='changed' WHERE clearance_id=$1", [c.clearance_id]), /cleared retirement clearances are locked/)
    await client.query('ROLLBACK TO SAVEPOINT cleared_update'); await client.query('RELEASE SAVEPOINT cleared_update')
    await client.query('ROLLBACK')
  } finally { client.release() }
})

test('concurrent mandatory-check completion serializes with clearance finalization', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin'), c = await clearance(admin, employee)
  const rows = await checks(c.clearance_id), check = rows[0]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT clearance_id FROM retirement_clearances WHERE clearance_id=$1 FOR UPDATE', [c.clearance_id])
    await client.query("SELECT set_config('app.actor_user_id',$1,true),set_config('app.actor_sap_id',$2,true)", [admin.userId,admin.sapId])
    const completion = client.query(`UPDATE retirement_clearance_checks SET is_complete=true,checked_by_user_id=$2,checked_by_sap_id=$3,checked_at=NOW()
      WHERE clearance_id=$1 AND is_mandatory=true`, [c.clearance_id,admin.userId,admin.sapId])
    const finalizing = api(`/admin/retirement-clearances/${c.clearance_id}/clear`, admin, 'POST', { remarks: 'Concurrent test finalization' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const peek = await pool.query('SELECT status FROM retirement_clearances WHERE clearance_id=$1', [c.clearance_id])
    assert.equal(peek.rows[0].status, 'BLOCKED')
    await completion
    await client.query('COMMIT')
    const response = await finalizing
    assert.equal(response.status, 200)
    const status = await pool.query('SELECT status FROM retirement_clearances WHERE clearance_id=$1', [c.clearance_id])
    assert.equal(status.rows[0].status, 'CLEARED')
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
})
