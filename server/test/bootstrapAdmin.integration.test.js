import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after } from 'node:test'
import { pool } from '../src/db/pool.js'
import { bootstrapFirstAdmin } from '../scripts/bootstrap-first-admin.js'

const ready = Boolean(process.env.TEST_DATABASE_URL)
after(async () => { if (ready) await pool.end() })

test('first Admin bootstrap creates a profile and BOOTSTRAP audit row atomically, then refuses another active Admin', { skip: !ready }, async () => {
  const tag = randomUUID()
  const input = {
    sapId: `BT${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`,
    name: 'Synthetic Bootstrap Administrator',
    email: `bootstrap-${tag}@example.invalid`,
    designation: 'Synthetic Administrator',
    employeeCategory: 'JO',
    department: 'Synthetic Test Department',
  }

  await assert.rejects(bootstrapFirstAdmin({ ...input, sapId: 'SHORT01' }, pool), /SAP ID must be exactly 8 characters/)

  await bootstrapFirstAdmin(input, pool)
  const created = await pool.query(
    `SELECT u.user_id,u.role,u.is_active,e.employee_name,e.email,e.designation,e.employee_category,e.department
     FROM users u JOIN employees e USING (user_id) WHERE u.sap_id=$1`,
    [input.sapId],
  )
  assert.equal(created.rowCount, 1)
  assert.equal(created.rows[0].role, 'admin')
  assert.equal(created.rows[0].is_active, true)
  assert.equal(created.rows[0].employee_name, input.name)
  assert.equal(created.rows[0].email, input.email)
  assert.equal(created.rows[0].designation, input.designation)
  assert.equal(created.rows[0].employee_category, input.employeeCategory)
  assert.equal(created.rows[0].department, input.department)

  const audit = await pool.query(
    `SELECT actor_user_id,actor_sap_id,action,entity_type,entity_id,details
     FROM audit_log WHERE entity_id=$1 ORDER BY audit_log_id DESC LIMIT 1`,
    [created.rows[0].user_id],
  )
  assert.equal(audit.rows[0].actor_user_id, null)
  assert.equal(audit.rows[0].actor_sap_id, 'BOOTSTRAP')
  assert.equal(audit.rows[0].action, 'first_admin_created')
  assert.equal(audit.rows[0].entity_type, 'user')
  assert.deepEqual(audit.rows[0].details.changedFields, ['sapId', 'email', 'employeeProfile'])

  const secondSapId = `SE${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`
  await assert.rejects(bootstrapFirstAdmin({ ...input, sapId: secondSapId }, pool), /An active Admin already exists/)
  const second = await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE sap_id=$1', [secondSapId])
  assert.equal(second.rows[0].count, 0)
})
