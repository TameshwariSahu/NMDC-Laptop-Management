import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import pg from 'pg'
import { runMigrations } from '../src/db/migrationRunner.js'

const { Pool } = pg
const testDatabaseUrl = process.env.TEST_DATABASE_URL
const baselineDatabaseUrl = process.env.TEST_BASELINE_DATABASE_URL
const migration007DatabaseUrl = process.env.TEST_MIGRATION_007_DATABASE_URL
const ready = Boolean(testDatabaseUrl && baselineDatabaseUrl)
const testPool = ready ? new Pool({ connectionString: testDatabaseUrl, max: 1 }) : null
const baselinePool = ready ? new Pool({ connectionString: baselineDatabaseUrl, max: 1 }) : null
const migration007Pool = migration007DatabaseUrl ? new Pool({ connectionString: migration007DatabaseUrl, max: 1 }) : null
const migration007Ready = Boolean(migration007Pool)
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations')

after(async () => {
  await Promise.all([testPool?.end(), baselinePool?.end(), migration007Pool?.end()])
})

test('integration URLs point only to dedicated migration test databases', { skip: !ready }, async () => {
  const [testInfo, baselineInfo] = await Promise.all([
    testPool.query('SELECT current_database() AS name'),
    baselinePool.query('SELECT current_database() AS name'),
  ])
  const testName = testInfo.rows[0].name
  const baselineName = baselineInfo.rows[0].name
  assert.match(testName, /^lms_migration_test_\d{8}_[a-f0-9]{8}$/)
  assert.match(baselineName, /^lms_migration_baseline_test_\d{8}_[a-f0-9]{8}$/)
  assert.notEqual(testName, baselineName)
})

test('migration runner baselines an existing 001 schema on PostgreSQL', { skip: !ready }, async () => {
  const initialSql = await readFile(path.join(migrationsDirectory, '001_initial.sql'), 'utf8')
  const nextSql = await readFile(path.join(migrationsDirectory, '002_auth_sessions_audit_log.sql'), 'utf8')
  const laptopSql = await readFile(path.join(migrationsDirectory, '003_laptop_requests.sql'), 'utf8')
  const clearanceSql = await readFile(path.join(migrationsDirectory, '004_retirement_clearances.sql'), 'utf8')
  const invoiceSql = await readFile(path.join(migrationsDirectory, '005_invoice_superseding.sql'), 'utf8')
  const sapIdSql = await readFile(path.join(migrationsDirectory, '006_sap_id_eight_characters.sql'), 'utf8')
  const macClearanceSql = await readFile(path.join(migrationsDirectory, '007_mac_address_and_clearance_checks.sql'), 'utf8')
  const clearanceReasonSql = await readFile(path.join(migrationsDirectory, '008_retirement_clearance_reason.sql'), 'utf8')
  const typedKeysSql = await readFile(path.join(migrationsDirectory, '009_typed_license_keys.sql'), 'utf8')
  const requestActorsSql = await readFile(path.join(migrationsDirectory, '010_laptop_request_actor_sap_ids.sql'), 'utf8')
  const allRoleProfilesSql = await readFile(path.join(migrationsDirectory, '011_profiles_for_all_roles.sql'), 'utf8')
  const juniorOfficerSql = await readFile(path.join(migrationsDirectory, '012_employee_category_jo.sql'), 'utf8')
  const onBehalfSql = await readFile(path.join(migrationsDirectory, '013_office_account_email_and_on_behalf.sql'), 'utf8')
  const executedSql = []
  const tracedPool = {
    async connect() {
      const client = await baselinePool.connect()
      return {
        query(sql, params) {
          executedSql.push(typeof sql === 'string' ? sql : sql.text)
          return client.query(sql, params)
        },
        release() {
          client.release()
        },
      }
    },
  }

  await runMigrations(tracedPool, migrationsDirectory)
  assert.equal(executedSql.some((sql) => sql.trim() === initialSql.trim()), false)
  assert.equal(executedSql.some((sql) => sql.trim() === nextSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === laptopSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === clearanceSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === invoiceSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === sapIdSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === macClearanceSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === clearanceReasonSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === typedKeysSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === requestActorsSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === allRoleProfilesSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === juniorOfficerSql.trim()), true)
  assert.equal(executedSql.some((sql) => sql.trim() === onBehalfSql.trim()), true)

  const rows = await baselinePool.query('SELECT version FROM schema_migrations ORDER BY version')
  assert.deepEqual(rows.rows.map((row) => row.version), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013'])
})

test('migration 012 adds JO as a usable employee category after the migration commits', { skip: !ready }, async () => {
  const value = await testPool.query("SELECT 'JO'::employee_category AS category")
  assert.equal(value.rows[0].category, 'JO')
  const enumValues = await testPool.query(`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    WHERE t.typname='employee_category' ORDER BY e.enumsortorder`)
  assert.deepEqual(enumValues.rows.map((row) => row.enumlabel), ['Workman', 'Executive', 'JO'])
})

test('migration 011 accepts one synced profile for each user role while preserving one-profile-per-user', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    for (const role of ['employee', 'engineer', 'admin']) {
      const tag = crypto.randomUUID()
      const sapId = `PR${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`
      const user = await client.query('INSERT INTO users(sap_id,email,role) VALUES($1,$2,$3) RETURNING user_id', [sapId, `${tag}@example.invalid`, role])
      await client.query(`INSERT INTO employees(user_id,sap_id,employee_name,email,designation,employee_category,department)
        VALUES($1,$2,'Synthetic Profile',$3,'Tester','Executive','Integration')`, [user.rows[0].user_id, sapId, `${tag}@example.invalid`])
      const synced = await client.query('SELECT sap_id,email FROM users WHERE user_id=$1', [user.rows[0].user_id])
      assert.equal(synced.rows[0].sap_id, sapId)
      await client.query('SAVEPOINT duplicate_profile')
      await assert.rejects(client.query(`INSERT INTO employees(user_id,sap_id,employee_name,email,designation,employee_category,department)
        VALUES($1,$2,'Duplicate Profile',$3,'Tester','Executive','Integration')`, [user.rows[0].user_id, sapId, `${tag}@example.invalid`]), (error) => error.code === '23505')
      await client.query('ROLLBACK TO SAVEPOINT duplicate_profile')
      await client.query('RELEASE SAVEPOINT duplicate_profile')
    }
  })
})

test('migration 007 normalizes an APPROVED colon-MAC request, restores its lock trigger, and writes SYSTEM audit', { skip: !migration007Ready }, async () => {
  const database = await migration007Pool.query('SELECT current_database() AS name')
  assert.match(database.rows[0].name, /^lms_migration_007_test_\d{8}_[a-f0-9]{8}$/)
  const clearances = await migration007Pool.query(
    `SELECT clearance_id FROM retirement_clearances WHERE created_by_sap_id='MIGSEED'`,
  )
  assert.equal(clearances.rowCount, 1)
  const clearanceId = clearances.rows[0].clearance_id
  const oldChecks = await migration007Pool.query(
    `SELECT check_id,check_key,is_mandatory FROM retirement_clearance_checks
     WHERE clearance_id=$1 AND check_key IN ('asset_return','license_check','old_extra') ORDER BY check_key`,
    [clearanceId],
  )
  assert.equal(oldChecks.rowCount, 3)
  assert.ok(oldChecks.rows.every((row) => row.is_mandatory === false))
  const newChecks = await migration007Pool.query(
    `SELECT check_key,is_mandatory,is_complete FROM retirement_clearance_checks
     WHERE clearance_id=$1 AND check_key IN ('company_software_removal','antivirus_removal') ORDER BY check_key`,
    [clearanceId],
  )
  assert.deepEqual(newChecks.rows.map((row) => row.check_key), ['antivirus_removal','company_software_removal'])
  assert.ok(newChecks.rows.every((row) => row.is_mandatory && !row.is_complete))
  const audit = await migration007Pool.query(
    `SELECT COUNT(*)::int AS count FROM audit_log
     WHERE actor_sap_id='SYSTEM' AND action='retirement_check_updated'
       AND entity_type='retirement_clearance_check' AND entity_id=ANY($1::text[])
       AND details->'changedFields' ? 'isMandatory'`,
    [oldChecks.rows.map((row) => row.check_id)],
  )
  assert.equal(audit.rows[0].count, 3)
  const mac = await migration007Pool.query(
    `SELECT request_id,mac_address FROM laptop_requests
     WHERE owner_employee_id=(SELECT employee_id FROM retirement_clearances WHERE clearance_id=$1)`,
    [clearanceId],
  )
  assert.equal(mac.rowCount, 1)
  assert.equal(mac.rows[0].mac_address, '02AA00000007')
  assert.match(mac.rows[0].mac_address, /^[0-9A-F]{12}$/)

  const trigger = await migration007Pool.query(
    `SELECT tgenabled FROM pg_trigger
     WHERE tgrelid='laptop_requests'::regclass
       AND tgname='laptop_requests_lock_approved' AND NOT tgisinternal`,
  )
  assert.equal(trigger.rowCount, 1)
  assert.equal(trigger.rows[0].tgenabled, 'O')
  await assert.rejects(
    migration007Pool.query(
      'UPDATE laptop_requests SET model_number=$1 WHERE request_id=$2',
      ['Changed after migration', mac.rows[0].request_id],
    ),
    (error) => error.message.includes('approved laptop requests cannot be updated'),
  )

  const migrationAudit = await migration007Pool.query(
    `SELECT COUNT(*)::int AS count FROM audit_log
     WHERE actor_sap_id='SYSTEM' AND action='migration_007_mac_normalized'
       AND entity_type='schema_migration' AND entity_id='007'`,
  )
  assert.equal(migrationAudit.rows[0].count, 1)
})

async function withRollbackTransaction(callback) {
  const client = await testPool.connect()
  try {
    await client.query('BEGIN')
    await callback(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function insertAuditRow(client) {
  const result = await client.query(
    `INSERT INTO audit_log (action, entity_type)
     VALUES ('integration_test', 'synthetic') RETURNING audit_log_id`,
  )
  return result.rows[0].audit_log_id
}

async function insertEmployee(client) {
  const tag = crypto.randomUUID()
  const sapId = `IT${tag.replaceAll('-', '').slice(0, 6).toUpperCase()}`
  const userResult = await client.query(
    `INSERT INTO users (sap_id, email, role)
     VALUES ($1, $2, 'employee') RETURNING user_id`,
    [sapId, `it-${tag}@example.invalid`],
  )
  const employeeResult = await client.query(
    `INSERT INTO employees
       (user_id, sap_id, employee_name, email, designation, employee_category, department)
     VALUES ($1, $2, $3, $4, 'Tester', 'Executive', 'Integration')
     RETURNING employee_id`,
    [userResult.rows[0].user_id, sapId, 'Synthetic Integration Employee', `it-${tag}@example.invalid`],
  )
  return { userId: userResult.rows[0].user_id, employeeId: employeeResult.rows[0].employee_id }
}

async function insertLaptopRequest(client, employeeId, overrides = {}) {
  const tag = crypto.randomUUID()
  const macSuffix = tag.replaceAll('-', '').slice(0, 12).toUpperCase()
  const defaults = {
    serialNumber: `SER-${tag}`,
    macAddress: macSuffix,
    status: 'PENDING_ENGINEER',
    licenseKeyHmac: null,
    licenseKeyCiphertext: null,
    licenseKeyNonce: null,
    licenseKeyAuthTag: null,
  }
  const values = { ...defaults, ...overrides }
  const result = await client.query(
    `INSERT INTO laptop_requests
       (owner_employee_id, serial_number, purchase_date, model_number, mac_address,
        operating_system, status, license_key_ciphertext, license_key_nonce,
        license_key_auth_tag, license_key_hmac)
     VALUES ($1, $2, DATE '2025-01-01', 'Synthetic Model', $3, 'Windows', $4, $5, $6, $7, $8)
     RETURNING request_id`,
    [employeeId, values.serialNumber, values.macAddress, values.status,
      values.licenseKeyCiphertext, values.licenseKeyNonce, values.licenseKeyAuthTag, values.licenseKeyHmac],
  )
  return result.rows[0].request_id
}

test('PostgreSQL rejects UPDATE on audit_log', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const id = await insertAuditRow(client)
    await assert.rejects(
      client.query('UPDATE audit_log SET action = $1 WHERE audit_log_id = $2', ['changed', id]),
      (error) => error.message.includes('audit_log is append-only'),
    )
  })
})

test('PostgreSQL rejects DELETE on audit_log', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const id = await insertAuditRow(client)
    await assert.rejects(
      client.query('DELETE FROM audit_log WHERE audit_log_id = $1', [id]),
      (error) => error.message.includes('audit_log is append-only'),
    )
  })
})

test('PostgreSQL rejects TRUNCATE on audit_log', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    await insertAuditRow(client)
    await assert.rejects(
      client.query('TRUNCATE TABLE audit_log'),
      (error) => error.message.includes('audit_log is append-only'),
    )
  })
})

test('PostgreSQL accepts an audit row with NULL actor fields', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_sap_id, action, entity_type)
       VALUES (NULL, NULL, 'login_failed', 'authentication')
       RETURNING actor_user_id, actor_sap_id`,
    )
    assert.equal(result.rows[0].actor_user_id, null)
    assert.equal(result.rows[0].actor_sap_id, null)
  })
})

test('PostgreSQL trims and uppercases SAP IDs on users and employee profiles', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const inputSapId = ` ab${crypto.randomUUID().replaceAll('-', '').slice(0, 6)} `
    const expectedSapId = inputSapId.trim().toUpperCase()
    const user = await client.query(
      `INSERT INTO users (sap_id, email, role) VALUES ($1, $2, 'employee') RETURNING user_id, sap_id`,
      [inputSapId, `sap-normalize-${crypto.randomUUID()}@example.invalid`],
    )
    assert.equal(user.rows[0].sap_id, expectedSapId)
    const employee = await client.query(
      `INSERT INTO employees (user_id, sap_id, employee_name, email, designation, employee_category, department)
       VALUES ($1, $2, 'Synthetic SAP Test', 'sap-profile@example.invalid', 'Tester', 'Executive', 'Integration')
       RETURNING sap_id`,
      [user.rows[0].user_id, inputSapId],
    )
    assert.equal(employee.rows[0].sap_id, expectedSapId)
  })
})

test('PostgreSQL rejects SAP IDs that are not exactly eight characters', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    await assert.rejects(
      client.query(`INSERT INTO users (sap_id, email, role) VALUES ('SHORT01', 'short@example.invalid', 'employee')`),
      (error) => error.message.includes('SAP ID must be exactly 8 characters'),
    )
  })
})

test('PostgreSQL rejects auth_sessions with expires_at before created_at', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const userResult = await client.query(
      `INSERT INTO users (sap_id, email, role)
       VALUES ($1, $2, 'employee') RETURNING user_id`,
      [`IT${crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`, 'integration-test@example.invalid'],
    )
    const userId = userResult.rows[0].user_id
    const createdAt = new Date()
    const expiredAt = new Date(createdAt.getTime() - 1000)
    await assert.rejects(
      client.query(
        'INSERT INTO auth_sessions (user_id, created_at, expires_at) VALUES ($1, $2, $3)',
        [userId, createdAt, expiredAt],
      ),
      (error) => error.code === '23514',
    )
  })
})

test('PostgreSQL rejects serial duplicates after case and whitespace normalization', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    await insertLaptopRequest(client, employeeId, { serialNumber: '  Serial-X  ' })
    await assert.rejects(
      insertLaptopRequest(client, employeeId, { serialNumber: 'serial-x' }),
      (error) => error.code === '23505',
    )
  })
})

test('PostgreSQL rejects duplicate canonical MAC addresses', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    await insertLaptopRequest(client, employeeId, { macAddress: '02AA00000001' })
    await assert.rejects(
      insertLaptopRequest(client, employeeId, { macAddress: '02AA00000001' }),
      (error) => error.code === '23505',
    )
  })
})

test('PostgreSQL rejects an invalid MAC address format', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    await assert.rejects(
      insertLaptopRequest(client, employeeId, { macAddress: 'not-a-mac' }),
      (error) => error.code === '23514',
    )
  })
})

test('PostgreSQL requires the normalized uppercase 12-character MAC representation', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    for (const [index, macAddress] of ['02aa00000001', '02AA0000000G', '02AA000001'].entries()) {
      const savepoint = `invalid_mac_${index}`
      await client.query(`SAVEPOINT ${savepoint}`)
      await assert.rejects(
        insertLaptopRequest(client, employeeId, { macAddress }),
        (error) => error.code === '23514',
      )
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      await client.query(`RELEASE SAVEPOINT ${savepoint}`)
    }
  })
})

test('PostgreSQL rejects partially populated encrypted license-key fields', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    await assert.rejects(
      insertLaptopRequest(client, employeeId, { licenseKeyCiphertext: Buffer.from('ciphertext') }),
      (error) => error.code === '23514',
    )
  })
})

test('PostgreSQL enforces typed key completeness and permits an Office key on macOS', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    const insertTyped = (os, type, partial = false) => {
      const tag = crypto.randomUUID()
      const columns = type === 'windows' ? [
        'windows_license_key_ciphertext', 'windows_license_key_nonce', 'windows_license_key_auth_tag', 'windows_license_key_hmac',
      ] : [
        'office_license_key_ciphertext', 'office_license_key_nonce', 'office_license_key_auth_tag', 'office_license_key_hmac',
      ]
      const values = partial
        ? [Buffer.from('synthetic-ciphertext'), null, null, null]
        : [Buffer.from('synthetic-ciphertext'), Buffer.alloc(12, 1), Buffer.alloc(16, 2), Buffer.alloc(32, 3)]
      return client.query(`INSERT INTO laptop_requests(owner_employee_id,serial_number,purchase_date,model_number,mac_address,operating_system,${columns.join(',')})
        VALUES($1,$2,CURRENT_DATE,'Typed key test',$3,$4,$5,$6,$7,$8)`,
      [employeeId, `TYPED-${tag}`, tag.replaceAll('-', '').slice(0, 12).toUpperCase(), os, ...values])
    }
    await client.query('SAVEPOINT typed_partial')
    await assert.rejects(insertTyped('Windows', 'windows', true), (error) => error.code === '23514')
    await client.query('ROLLBACK TO SAVEPOINT typed_partial')
    await client.query('RELEASE SAVEPOINT typed_partial')
    await client.query('SAVEPOINT windows_on_mac')
    await assert.rejects(insertTyped('macOS', 'windows'), (error) => error.code === '23514')
    await client.query('ROLLBACK TO SAVEPOINT windows_on_mac')
    await client.query('RELEASE SAVEPOINT windows_on_mac')
    await insertTyped('macOS', 'office')
  })
})

test('PostgreSQL allows two requests with the same non-unique license HMAC', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    const encrypted = {
      licenseKeyCiphertext: Buffer.from('synthetic-ciphertext'),
      licenseKeyNonce: Buffer.alloc(12, 1),
      licenseKeyAuthTag: Buffer.alloc(16, 2),
      licenseKeyHmac: Buffer.from('synthetic-key-fingerprint'),
    }
    await insertLaptopRequest(client, employeeId, encrypted)
    await insertLaptopRequest(client, employeeId, encrypted)
  })
})

test('PostgreSQL rejects updates to requests whose old status is APPROVED', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    const requestId = await insertLaptopRequest(client, employeeId, { status: 'APPROVED' })
    await assert.rejects(
      client.query('UPDATE laptop_requests SET model_number = $1 WHERE request_id = $2', ['Changed', requestId]),
      (error) => error.message.includes('approved laptop requests cannot be updated'),
    )
  })
})

test('PostgreSQL rejects UPDATE, DELETE and TRUNCATE on approval_history', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    const requestId = await insertLaptopRequest(client, employeeId)
    const inserted = await client.query(
      `INSERT INTO approval_history (request_id, action, new_status)
       VALUES ($1, 'submitted', 'PENDING_ENGINEER') RETURNING history_id`,
      [requestId],
    )
    const historyId = inserted.rows[0].history_id
    const rejected = (error) => error.message.includes('approval_history is append-only')
    const assertRejectedInSavepoint = async (name, query, values = []) => {
      await client.query(`SAVEPOINT ${name}`)
      await assert.rejects(client.query(query, values), rejected)
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
      await client.query(`RELEASE SAVEPOINT ${name}`)
    }
    await assertRejectedInSavepoint(
      'reject_update', 'UPDATE approval_history SET action = $1 WHERE history_id = $2', ['changed', historyId],
    )
    await assertRejectedInSavepoint('reject_delete', 'DELETE FROM approval_history WHERE history_id = $1', [historyId])
    await assertRejectedInSavepoint('reject_truncate', 'TRUNCATE TABLE approval_history')
  })
})

test('PostgreSQL updates updated_at when a laptop request changes', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    const requestId = await insertLaptopRequest(client, employeeId)
    const previous = new Date('2000-01-01T00:00:00.000Z')
    await client.query('UPDATE laptop_requests SET updated_at = $1 WHERE request_id = $2', [previous, requestId])
    const result = await client.query('SELECT updated_at FROM laptop_requests WHERE request_id = $1', [requestId])
    assert.ok(result.rows[0].updated_at > previous)
  })
})

test('PostgreSQL prevents deleting an employee who owns laptop requests', { skip: !ready }, async () => {
  await withRollbackTransaction(async (client) => {
    const { employeeId } = await insertEmployee(client)
    await insertLaptopRequest(client, employeeId)
    await assert.rejects(
      client.query('DELETE FROM employees WHERE employee_id = $1', [employeeId]),
      (error) => error.code === '23503',
    )
  })
})
