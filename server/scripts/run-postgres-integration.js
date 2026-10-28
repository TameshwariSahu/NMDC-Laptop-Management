import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { env } from '../src/config/env.js'
import { runMigrations } from '../src/db/migrationRunner.js'

const { Client, Pool } = pg
const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectory = path.join(serverDirectory, 'src', 'db', 'migrations')
const suffix = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${randomBytes(4).toString('hex')}`
const testDatabaseName = `lms_migration_test_${suffix}`
const baselineDatabaseName = `lms_migration_baseline_test_${suffix}`
const migration007DatabaseName = `lms_migration_007_test_${suffix}`
const invoiceTestDirectory = path.join(os.tmpdir(), `lms-invoice-test-${suffix}`)
const migration007FixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'lms-migration-007-fixture-'))
const originalUrl = new URL(env.databaseUrl)
const originalDatabaseName = decodeURIComponent(originalUrl.pathname.slice(1))

if ([testDatabaseName, baselineDatabaseName, migration007DatabaseName].includes(originalDatabaseName)) {
  throw new Error('Refusing to use the configured application database for integration tests')
}

function databaseUrlFor(databaseName) {
  const url = new URL(env.databaseUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

async function createIsolatedDatabases() {
  const maintenanceUrl = new URL(env.databaseUrl)
  maintenanceUrl.pathname = '/postgres'
  const client = new Client({ connectionString: maintenanceUrl.toString() })
  const names = [testDatabaseName, baselineDatabaseName, migration007DatabaseName]

  try {
    await client.connect()
    const existing = await client.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names])
    if (existing.rowCount > 0) throw new Error('Generated test database name already exists; rerun the test setup')
    for (const name of names) {
      // Names are generated locally and checked against a strict identifier pattern.
      if (!/^lms_migration_(?:(?:baseline_)?test|007_test)_\d{8}_[a-f0-9]{8}$/.test(name)) {
        throw new Error('Generated test database name failed validation')
      }
      await client.query(`CREATE DATABASE "${name}"`)
      console.log(`Created isolated PostgreSQL test database: ${name}`)
    }
  } finally {
    await client.end()
  }
}

async function initializeDatabases() {
  const testPool = new Pool({ connectionString: databaseUrlFor(testDatabaseName) })
  const baselinePool = new Pool({ connectionString: databaseUrlFor(baselineDatabaseName) })
  const migration007Pool = new Pool({ connectionString: databaseUrlFor(migration007DatabaseName) })
  try {
    const result = await runMigrations(testPool, migrationsDirectory)
    console.log(`Migration runner output (empty database): ${result.appliedCount} migrations recorded.`)

    const initialSql = await readFile(path.join(migrationsDirectory, '001_initial.sql'), 'utf8')
    await baselinePool.query(initialSql)
    console.log('Prepared baseline database by applying only 001_initial.sql; migration tracking is absent.')

    const migrations001To006 = path.join(migration007FixtureDirectory, '001-006')
    const migration007Only = path.join(migration007FixtureDirectory, '007-only')
    await Promise.all([mkdir(migrations001To006), mkdir(migration007Only)])
    const filenames = (await readdir(migrationsDirectory)).filter((file) => /^00[1-6]_.*\.sql$/i.test(file))
    if (filenames.length !== 6) throw new Error('Expected migrations 001 through 006 for the migration fixture')
    for (const file of filenames) await copyFile(path.join(migrationsDirectory, file), path.join(migrations001To006, file))
    const migration007File = '007_mac_address_and_clearance_checks.sql'
    await copyFile(path.join(migrationsDirectory, migration007File), path.join(migration007Only, migration007File))
    await runMigrations(migration007Pool, migrations001To006)

    const fixtureClient = await migration007Pool.connect()
    try {
      await fixtureClient.query('BEGIN')
      const sapId = `M7${randomBytes(3).toString('hex').toUpperCase()}`
      const user = await fixtureClient.query(
        `INSERT INTO users (sap_id, email, role) VALUES ($1, $2, 'employee') RETURNING user_id`,
        [sapId, `${sapId.toLowerCase()}@example.invalid`],
      )
      const employee = await fixtureClient.query(
        `INSERT INTO employees (user_id,sap_id,employee_name,email,designation,employee_category,department)
         VALUES ($1,$2,'Synthetic Migration Employee',$3,'Tester','Executive','Integration') RETURNING employee_id`,
        [user.rows[0].user_id, sapId, `${sapId.toLowerCase()}@example.invalid`],
      )
      const request = await fixtureClient.query(
        `INSERT INTO laptop_requests (owner_employee_id,serial_number,purchase_date,model_number,mac_address,operating_system,status)
         VALUES ($1,$2,CURRENT_DATE,'Synthetic Migration Laptop','02:AA:00:00:00:07','Windows','APPROVED') RETURNING request_id`,
        [employee.rows[0].employee_id, `MIG007-${sapId}`],
      )
      const clearance = await fixtureClient.query(
        `INSERT INTO retirement_clearances (employee_id,created_by_user_id,created_by_sap_id)
         VALUES ($1,$2,'MIGSEED') RETURNING clearance_id`,
        [employee.rows[0].employee_id, user.rows[0].user_id],
      )
      await fixtureClient.query(
        `SELECT set_config('app.actor_user_id',$1,true),set_config('app.actor_sap_id',$2,true)`,
        [user.rows[0].user_id, sapId],
      )
      await fixtureClient.query(
        `INSERT INTO retirement_clearance_checks (clearance_id,check_key,check_label,is_mandatory)
         VALUES ($1,'asset_return','Legacy asset return',TRUE),($1,'license_check','Legacy license check',TRUE),($1,'old_extra','Legacy extra check',TRUE)`,
        [clearance.rows[0].clearance_id],
      )
      await fixtureClient.query('COMMIT')
      console.log('Prepared migration 007 fixture with an APPROVED colon-MAC request and three mandatory legacy checks.')
    } catch (error) {
      await fixtureClient.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      fixtureClient.release()
    }
    await runMigrations(migration007Pool, migration007Only)
    console.log('Applied migration 007 to the dedicated migration fixture database.')
  } finally {
    await Promise.all([testPool.end(), baselinePool.end(), migration007Pool.end()])
  }
}

async function runIntegrationTests() {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/bootstrapAdmin.integration.test.js', 'test/postgres.integration.test.js', 'test/taskA.api.integration.test.js', 'test/workflow.integration.test.js', 'test/taskC.api.integration.test.js', 'test/invoiceReplacement.integration.test.js', 'test/zz_audit.api.integration.test.js'], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrlFor(testDatabaseName),
      TEST_DATABASE_URL: databaseUrlFor(testDatabaseName),
      TEST_BASELINE_DATABASE_URL: databaseUrlFor(baselineDatabaseName),
      TEST_MIGRATION_007_DATABASE_URL: databaseUrlFor(migration007DatabaseName),
      INVOICE_STORAGE_DIR: invoiceTestDirectory,
      LICENSE_ENCRYPTION_KEY: '11'.repeat(32),
      LICENSE_HMAC_KEY: '22'.repeat(32),
    },
    stdio: 'inherit',
  })
  if (result.error) throw new Error('Could not start PostgreSQL integration tests')
  if (result.status !== 0) process.exitCode = result.status ?? 1
}

try {
  await createIsolatedDatabases()
  await initializeDatabases()
  await runIntegrationTests()
} catch {
  console.error('PostgreSQL integration setup failed. No application database was targeted; details suppressed.')
  process.exitCode = 1
} finally {
  await rm(migration007FixtureDirectory, { recursive: true, force: true })
}
