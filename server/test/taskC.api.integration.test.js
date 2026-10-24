import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
async function clearance(admin, employee, extras) {
  const r = await api('/admin/retirement-clearances', admin, 'POST', { sapId: employee.sapId, additionalChecks: extras ?? [] })
  assert.equal(r.status, 201)
  return (await json(r)).clearance
}
async function checks(clearanceId) {
  return (await pool.query('SELECT check_id,check_key,is_mandatory,is_complete FROM retirement_clearance_checks WHERE clearance_id=$1 ORDER BY check_key', [clearanceId])).rows
}

test('reports paginate/filter and warn on duplicate HMAC without exposing fingerprints or key values', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin')
  const hmac = Buffer.from(`synthetic-${randomUUID()}`)
  const ids = []
  for (let i = 0; i < 2; i += 1) {
    const row = await pool.query(`INSERT INTO laptop_requests(owner_employee_id,serial_number,purchase_date,model_number,mac_address,operating_system,license_key_ciphertext,license_key_nonce,license_key_auth_tag,license_key_hmac)
      VALUES($1,$2,CURRENT_DATE,'Model',$3,'Windows',$4,$5,$6,$7) RETURNING request_id`, [employee.employeeId,`TC-${randomUUID()}`,`02:${randomUUID().replaceAll('-','').slice(0,10).match(/.{2}/g).join(':')}`,Buffer.from('cipher'),Buffer.alloc(12,1),Buffer.alloc(16,2),hmac])
    ids.push(row.rows[0].request_id)
  }
  const response = await api('/admin/reports?duplicateOnly=true&limit=1', admin)
  assert.equal(response.status, 200)
  const page = await json(response)
  assert.equal(page.reports.length, 1); assert.equal(page.pagination.total, 2)
  assert.equal(page.reports[0].duplicateLicenseWarning, true)
  assert.equal(JSON.stringify(page).includes(hmac.toString()), false)
  assert.equal(Object.hasOwn(page.reports[0], 'licenseKey'), false)
})

test('admin account changes are audited, employee profiles are created, engineer accounts avoid email fallback, and admin safeguards hold', { skip: !ready }, async () => {
  const first = await actor('admin'), second = await actor('admin')
  const invalidSapId = await api('/admin/accounts', first, 'POST', { sapId: 'TOOSHORT', email: 'invalid@example.invalid', role: 'engineer' })
  assert.equal(invalidSapId.status, 400)
  await pool.query("UPDATE users SET is_active=false WHERE role='admin' AND is_active=true AND user_id NOT IN ($1,$2)", [first.userId, second.userId])
  const employeeTag = randomUUID()
  const created = await api('/admin/accounts', first, 'POST', { sapId: `NE${employeeTag.replaceAll('-', '').slice(0, 6).toUpperCase()}`, email: `${employeeTag}@example.invalid`, role: 'employee', employeeName: 'Synthetic New Employee', designation: 'Tester', employeeCategory: 'Workman', department: 'Integration' })
  assert.equal(created.status, 201)
  const createdBody = await json(created)
  const profile = await pool.query('SELECT employee_id FROM employees WHERE user_id=$1', [createdBody.account.userId])
  assert.equal(profile.rowCount, 1)
  const engineerTag = randomUUID()
  const engineerCreated = await api('/admin/accounts', first, 'POST', {
    sapId: `NG${engineerTag.replaceAll('-', '').slice(0, 6).toUpperCase()}`, email: `${engineerTag}@example.invalid`, role: 'engineer',
  })
  assert.equal(engineerCreated.status, 201)
  const engineerAccount = (await json(engineerCreated)).account
  const listed = await api(`/admin/accounts?q=${engineerAccount.sapId}`, first)
  const engineerListed = (await json(listed)).accounts[0]
  assert.equal(engineerListed.sapId, engineerAccount.sapId)
  assert.equal(engineerListed.employeeName, null)
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
})

test('clearance rejects incomplete and zero-check records; check changes are audited; mandatory deletes are blocked', { skip: !ready }, async () => {
  const employee = await actor('employee'), admin = await actor('admin')
  const c = await clearance(admin, employee)
  const blocked = await api(`/admin/retirement-clearances/${c.clearance_id}/clear`, admin, 'POST', { remarks: 'Attempt before checks complete' })
  assert.equal(blocked.status, 409)
  const list = await checks(c.clearance_id)
  const incomplete = list[0]
  const update = await api(`/admin/retirement-clearances/${c.clearance_id}/checks/${incomplete.check_id}`, admin, 'PATCH', { isComplete: true, remarks: 'Synthetic check complete' })
  assert.equal(update.status, 200)
  const log = await pool.query("SELECT action,details->>'checkKey' AS key FROM audit_log WHERE entity_type='retirement_clearance_check' AND entity_id=$1 ORDER BY audit_log_id DESC LIMIT 1", [incomplete.check_id])
  assert.equal(log.rows[0].action, 'retirement_check_updated'); assert.equal(log.rows[0].key, incomplete.check_key)
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
  const zero = await pool.query('INSERT INTO retirement_clearances(employee_id,created_by_sap_id) VALUES($1,$2) RETURNING clearance_id', [zeroEmployee.employeeId,admin.sapId])
  const noChecks = await api(`/admin/retirement-clearances/${zero.rows[0].clearance_id}/clear`, admin, 'POST', { remarks: 'No checks exist' })
  assert.equal(noChecks.status, 409)
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
