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
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await pool.end()
})

async function actor(role, name) {
  const tag = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()
  const email = `${tag.toLowerCase()}@example.invalid`
  const user = await pool.query('INSERT INTO users(sap_id,email,role) VALUES($1,$2,$3) RETURNING user_id', [tag,email,role])
  await pool.query(`INSERT INTO employees(user_id,sap_id,employee_name,email,designation,employee_category,department)
    VALUES($1,$2,$3,$4,'Integration tester','Executive','Audit tests')`, [user.rows[0].user_id,tag,name,email])
  return { userId: user.rows[0].user_id, sapId: tag, name, token: jwt.sign({ sub: user.rows[0].user_id }, env.jwtSecret, { expiresIn: '5m' }) }
}
async function api(path, user) {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${user.token}` } })
}
function queryLikeClient(filters = {}) {
  const params = new URLSearchParams({ limit: String(filters.limit ?? 25), offset: String(filters.offset ?? 0), timeZone: filters.timeZone ?? 'Asia/Calcutta' })
  if (filters.sapId) { params.set('sapId', filters.sapId); params.set('sapIdScope', filters.sapIdScope ?? 'changedBy') }
  for (const key of ['action','from','to']) if (filters[key]) params.set(key, filters[key])
  return `/admin/audit?${params}`
}
function localDateInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
async function seedAudit(admin, owner) {
  const request = await pool.query(`INSERT INTO laptop_requests(owner_employee_id,serial_number,purchase_date,model_number,mac_address,operating_system,status)
    SELECT employee_id,$2,CURRENT_DATE,$3,$4,'Windows','APPROVED' FROM employees WHERE user_id=$1 RETURNING request_id`,
  [owner.userId, `AUD-${randomUUID()}`, 'Synthetic Audit Laptop', randomUUID().replaceAll('-', '').slice(0,12).toUpperCase()])
  const id = request.rows[0].request_id
  const when = new Date().toISOString()
  await pool.query(`INSERT INTO audit_log(actor_user_id,actor_sap_id,action,entity_type,entity_id,details,occurred_at) VALUES
    ($1,$2,'laptop_request_edited','laptop_request',$3,$4::jsonb,$5),
    ($1,$2,'account_updated','user',$6,$7::jsonb,$5)`, [admin.userId,admin.sapId,id,
    JSON.stringify({ changedFields: ['serialNumber','windowsKey'], changes: {
      serialNumber: { old: 'OLD-SERIAL', new: 'NEW-SERIAL' }, windowsKey: 'changed',
      licenseKey: { old: 'SENSITIVE-PLAINTEXT', new: 'SENSITIVE-PLAINTEXT-NEW' },
      ciphertext: 'SENSITIVE-CIPHERTEXT', fingerprint: 'SENSITIVE-HMAC', otp: '123456', token: 'secret-token',
    } }), when, owner.userId,
    JSON.stringify({ changedFields: ['department'], changes: { department: { old: 'Old Dept', new: 'New Dept' } } })])
  return { requestId: id, when }
}

test('Audit API is Admin-only; Engineer and Employee receive 403', { skip: !ready }, async () => {
  const admin = await actor('admin','Synthetic Audit Admin')
  const engineer = await actor('engineer','Synthetic Audit Engineer')
  const employee = await actor('employee','Synthetic Audit Employee')
  const [engList, empList, engExport, empExport] = await Promise.all([
    api('/admin/audit',engineer), api('/admin/audit',employee),
    api('/admin/audit/export.xlsx',engineer), api('/admin/audit/export.xlsx',employee),
  ])
  assert.deepEqual([engList.status,empList.status,engExport.status,empExport.status],[403,403,403,403])
  const adminResponse = await api('/admin/audit?limit=1',admin)
  assert.equal(adminResponse.status,200)
  const invalidSap = await api('/admin/audit?sapId=ABC1234&limit=1',admin)
  assert.equal(invalidSap.status,400)
})

test('Audit without date filters returns the full newest-first list', { skip: !ready }, async () => {
  const admin = await actor('admin','Synthetic All Audit Admin')
  const owner = await actor('employee','Synthetic All Audit Owner')
  await seedAudit(admin,owner)
  const response = await api(queryLikeClient({ limit: 100, offset: 0 }),admin)
  assert.equal(response.status,200)
  const result = await response.json()
  assert.ok(result.pagination.total >= 2)
  assert.equal(result.entries.length,Math.min(100,result.pagination.total))
  assert.ok(result.entries.some((entry) => entry.action === 'laptop_request_edited'))
  for (let index=1; index<result.entries.length; index+=1) {
    assert.ok(new Date(result.entries[index-1].occurredAt) >= new Date(result.entries[index].occurredAt))
  }
})

test('Audit filters, pagination, labels and response exclude secret and key material', { skip: !ready }, async () => {
  const admin = await actor('admin','Synthetic Audit Admin')
  const employee = await actor('employee','Synthetic Audit Owner')
  const seeded = await seedAudit(admin,employee)
  const date = localDateInZone(new Date(seeded.when), 'Asia/Calcutta')
  const pageOne = await api(queryLikeClient({ sapId: admin.sapId, action: 'laptop_request_edited', from: date, to: date, limit: 1, offset: 0 }),admin)
  assert.equal(pageOne.status,200)
  const one = await pageOne.json()
  assert.equal(one.pagination.total,1)
  assert.equal(one.entries.length,1)
  assert.equal(one.entries[0].who,`${admin.name} (${admin.sapId})`)
  assert.equal(one.entries[0].actionLabel,'Laptop request edited')
  assert.match(one.entries[0].affectedRecord,/Synthetic Audit Owner \(.*\)/)
  assert.match(one.entries[0].affectedRecord,/AUD-/)
  assert.match(one.entries[0].affectedRecord,/Synthetic Audit Laptop/)
  assert.deepEqual(one.entries[0].changes.windowsKey,'changed')
  const responseText = JSON.stringify(one)
  for (const secret of ['SENSITIVE-PLAINTEXT','SENSITIVE-CIPHERTEXT','SENSITIVE-HMAC','123456','secret-token','licenseKey','ciphertext','fingerprint']) {
    assert.equal(responseText.includes(secret),false,`response leaked ${secret}`)
  }

  const actionAlone = await api(queryLikeClient({ action: 'EdIt' }), admin)
  assert.ok((await actionAlone.json()).entries.some((entry) => entry.action === 'laptop_request_edited'))
  const lowerCaseAction = await api(queryLikeClient({ action: 'eDiT' }), admin)
  assert.ok((await lowerCaseAction.json()).entries.some((entry) => entry.action === 'laptop_request_edited'))
  const readableLabelSearch = await api(queryLikeClient({ action: 'Laptop request edit' }), admin)
  assert.ok((await readableLabelSearch.json()).entries.some((entry) => entry.action === 'laptop_request_edited'))
  const noMatch = await api(queryLikeClient({ action: 'nothing-matches-this' }), admin)
  assert.equal((await noMatch.json()).pagination.total, 0)

  const sapAlone = await api(queryLikeClient({ sapId: admin.sapId.toLowerCase() }), admin)
  const sapResults = await sapAlone.json()
  assert.equal(sapResults.pagination.total, 2)
  const accountEvent = sapResults.entries.find((entry) => entry.action === 'account_updated')
  assert.ok(accountEvent.affectedRecord.includes(`Synthetic Audit Owner (${employee.sapId})`))
  const dateAlone = await api(queryLikeClient({ from: date, to: date }), admin)
  assert.ok((await dateAlone.json()).entries.some((entry) => entry.action === 'laptop_request_edited'))
  const affectedPerson = await api(queryLikeClient({ sapId: employee.sapId.toLowerCase(), sapIdScope: 'affectedEmployee', action: 'EDIT', from: date, to: date }), admin)
  const affectedResult = await affectedPerson.json()
  assert.equal(affectedResult.pagination.total, 1)
  assert.equal(affectedResult.entries[0].action, 'laptop_request_edited')
  assert.ok(affectedResult.entries[0].affectedRecord.includes(`Synthetic Audit Owner (${employee.sapId})`))
  const wrongScope = await api(queryLikeClient({ sapId: employee.sapId, sapIdScope: 'changedBy', action: 'EDIT' }), admin)
  assert.equal((await wrongScope.json()).pagination.total, 0)

  const pair = await pool.query(`INSERT INTO audit_log(actor_user_id,actor_sap_id,action,entity_type,entity_id,details)
    VALUES($1,$2,'account_updated','user',$3,'{}'),($1,$2,'account_updated','user',$3,'{}')`, [admin.userId,admin.sapId,employee.userId])
  assert.equal(pair.rowCount,2)
  const filtered = await api(`/admin/audit?sapId=${admin.sapId}&action=account_updated&limit=1&offset=0`,admin)
  const first = await filtered.json()
  assert.equal(first.pagination.total,3)
  assert.equal(first.entries.length,1)
  const secondResponse = await api(`/admin/audit?sapId=${admin.sapId}&action=account_updated&limit=1&offset=1`,admin)
  const second = await secondResponse.json()
  assert.equal(second.entries.length,1)

  await pool.query(`INSERT INTO audit_log(actor_user_id,actor_sap_id,action,entity_type,details) VALUES
    ($1,$2,'auditXliteralYtest','test','{}'),($1,$2,'audit_percent_test','test','{}')`, [admin.userId,admin.sapId])
  const escapedUnderscore = await api(queryLikeClient({ sapId: admin.sapId, action: 'audit_literal_test' }),admin)
  assert.equal((await escapedUnderscore.json()).pagination.total,0)
  const escapedPercent = await api(queryLikeClient({ sapId: admin.sapId, action: 'audit%test' }),admin)
  assert.equal((await escapedPercent.json()).pagination.total,0)
})

test('Audit To date includes the full local day and excludes adjacent days', { skip: !ready }, async () => {
  const admin = await actor('admin','Synthetic Boundary Admin')
  const timeZone = 'Asia/Calcutta', date = localDateInZone(new Date(),'Asia/Calcutta')
  await pool.query(`INSERT INTO audit_log(actor_user_id,actor_sap_id,action,entity_type,details,occurred_at) VALUES
    ($1,$2,'date_boundary_test','test','{}',(($3::date - 1 + TIME '23:59:59') AT TIME ZONE $4)),
    ($1,$2,'date_boundary_test','test','{}',(($3::date + TIME '23:59:59') AT TIME ZONE $4)),
    ($1,$2,'date_boundary_test','test','{}',(($3::date + 1 + TIME '00:00:00') AT TIME ZONE $4))`, [admin.userId,admin.sapId,date,timeZone])
  const response = await api(queryLikeClient({ sapId: admin.sapId, action: 'date_boundary_test', from: date, to: date, timeZone }),admin)
  assert.equal(response.status,200)
  const result = await response.json()
  assert.equal(result.pagination.total,1)
})

test('Audit Excel export uses the same filtered safe entries', { skip: !ready }, async () => {
  const admin = await actor('admin','Synthetic Export Admin')
  const employee = await actor('employee','Synthetic Export Owner')
  await seedAudit(admin,employee)
  const response = await api(`/admin/audit/export.xlsx?sapId=${admin.sapId}&action=laptop_request_edited`,admin)
  assert.equal(response.status,200)
  assert.match(response.headers.get('content-type') ?? '',/spreadsheetml\.sheet/)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.readUInt32LE(0),0x04034B50)
  let offset=0, text=''
  while (offset+30<=bytes.length && bytes.readUInt32LE(offset)===0x04034B50) {
    const compressedSize=bytes.readUInt32LE(offset+18), nameLength=bytes.readUInt16LE(offset+26), extraLength=bytes.readUInt16LE(offset+28)
    const start=offset+30+nameLength+extraLength, data=bytes.subarray(start,start+compressedSize)
    text+=inflateRawSync(data).toString('utf8'); offset=start+compressedSize
  }
  assert.match(text,/Affected Record/)
  assert.match(text,/Laptop request edited/)
  for (const secret of ['SENSITIVE-PLAINTEXT','SENSITIVE-CIPHERTEXT','SENSITIVE-HMAC','123456','secret-token']) assert.equal(text.includes(secret),false)
})
