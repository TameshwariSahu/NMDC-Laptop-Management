import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
const invoiceTestDirectory = path.join(os.tmpdir(), `lms-invoice-test-${suffix}`)
const originalUrl = new URL(env.databaseUrl)
const originalDatabaseName = decodeURIComponent(originalUrl.pathname.slice(1))

if (testDatabaseName === originalDatabaseName || baselineDatabaseName === originalDatabaseName) {
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
  const names = [testDatabaseName, baselineDatabaseName]

  try {
    await client.connect()
    const existing = await client.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [names])
    if (existing.rowCount > 0) throw new Error('Generated test database name already exists; rerun the test setup')
    for (const name of names) {
      // Names are generated locally and checked against a strict identifier pattern.
      if (!/^lms_migration_(?:baseline_)?test_\d{8}_[a-f0-9]{8}$/.test(name)) {
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
  try {
    const result = await runMigrations(testPool, migrationsDirectory)
    console.log(`Migration runner output (empty database): ${result.appliedCount} migrations recorded.`)

    const initialSql = await readFile(path.join(migrationsDirectory, '001_initial.sql'), 'utf8')
    await baselinePool.query(initialSql)
    console.log('Prepared baseline database by applying only 001_initial.sql; migration tracking is absent.')
  } finally {
    await Promise.all([testPool.end(), baselinePool.end()])
  }
}

async function runIntegrationTests() {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/bootstrapAdmin.integration.test.js', 'test/postgres.integration.test.js', 'test/taskA.api.integration.test.js', 'test/workflow.integration.test.js', 'test/taskC.api.integration.test.js', 'test/invoiceReplacement.integration.test.js'], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrlFor(testDatabaseName),
      TEST_DATABASE_URL: databaseUrlFor(testDatabaseName),
      TEST_BASELINE_DATABASE_URL: databaseUrlFor(baselineDatabaseName),
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
}
