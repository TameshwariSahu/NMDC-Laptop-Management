import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from '../src/db/pool.js'
import { isValidSapId, normalizeSapId } from '../src/utils/sapId.js'

function readArguments(argv, environment) {
  const names = new Map([
    ['--sap-id', 'sapId'], ['--name', 'name'], ['--email', 'email'],
    ['--designation', 'designation'], ['--employee-category', 'employeeCategory'], ['--department', 'department'],
  ])
  const values = {}
  for (let i = 0; i < argv.length; i += 1) {
    const field = names.get(argv[i])
    if (!field || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('Invalid bootstrap arguments')
    if (values[field] !== undefined) throw new Error('Duplicate bootstrap argument')
    values[field] = argv[++i]
  }
  const envNames = {
    sapId: 'BOOTSTRAP_ADMIN_SAP_ID', name: 'BOOTSTRAP_ADMIN_NAME', email: 'BOOTSTRAP_ADMIN_EMAIL',
    designation: 'BOOTSTRAP_ADMIN_DESIGNATION', employeeCategory: 'BOOTSTRAP_ADMIN_EMPLOYEE_CATEGORY',
    department: 'BOOTSTRAP_ADMIN_DEPARTMENT',
  }
  for (const [field, envName] of Object.entries(envNames)) values[field] ??= environment[envName]
  return values
}

function validate(input) {
  const value = Object.fromEntries(Object.entries(input).map(([key, item]) => [key, typeof item === 'string' ? item.trim() : '']))
  value.sapId = normalizeSapId(value.sapId)
  if (!isValidSapId(value.sapId)) throw new Error('SAP ID must be exactly 8 characters')
  if (!value.name || value.name.length > 160) throw new Error('Name is required and must be at most 160 characters')
  if (!/^\S+@\S+\.\S+$/.test(value.email) || value.email.length > 254) throw new Error('A valid email is required')
  if (!value.designation || value.designation.length > 120) throw new Error('Designation is required and must be at most 120 characters')
  if (!['Workman', 'Executive', 'JO'].includes(value.employeeCategory)) throw new Error('Employee category must be Workman, Executive or JO')
  if (!value.department || value.department.length > 120) throw new Error('Department is required and must be at most 120 characters')
  return value
}

/** Create the first Admin and required employee profile atomically. */
export async function bootstrapFirstAdmin(input, databasePool = pool) {
  const value = validate(input)
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    // Serialize with account-role changes so two bootstrap attempts cannot race.
    await client.query('SELECT pg_advisory_xact_lock(731943, 1)')
    const existing = await client.query("SELECT 1 FROM users WHERE role='admin' AND is_active=TRUE LIMIT 1")
    if (existing.rowCount) throw new Error('An active Admin already exists; bootstrap refused')

    const created = await client.query(
      `INSERT INTO users (sap_id, email, role, is_active)
       VALUES ($1, $2, 'admin', TRUE) RETURNING user_id`,
      [value.sapId, value.email],
    )
    const userId = created.rows[0].user_id
    await client.query(
      `INSERT INTO employees
         (user_id, sap_id, employee_name, email, designation, employee_category, department)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, value.sapId, value.name, value.email, value.designation, value.employeeCategory, value.department],
    )
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_sap_id, action, entity_type, entity_id, details)
       VALUES (NULL, 'BOOTSTRAP', 'first_admin_created', 'user', $1, $2::jsonb)`,
      [userId, JSON.stringify({ role: 'admin', changedFields: ['sapId', 'email', 'employeeProfile'] })],
    )
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await bootstrapFirstAdmin(readArguments(process.argv.slice(2), process.env))
    console.log('First Admin account created with an employee profile and bootstrap audit entry.')
    console.log('The account can sign in using its registered email OTP.')
  } catch (error) {
    if (error.message.startsWith('An active Admin')) console.error(error.message)
    else if (error.code) console.error('Bootstrap failed; the transaction was rolled back. Check the database configuration and supplied values.')
    else console.error(`Bootstrap failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
