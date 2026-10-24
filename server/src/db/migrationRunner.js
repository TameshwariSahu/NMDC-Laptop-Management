import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const MIGRATION_NAME = /^(\d{3,})_([a-z0-9_-]+)\.sql$/i
const LOCK_NAMESPACE = 731942
const LOCK_KEY = 1

export const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

const INITIAL_SCHEMA_STATE_SQL = `
  WITH expected(table_name, column_name, data_type) AS (
    VALUES
      ('users', 'user_id', 'uuid'),
      ('users', 'sap_id', 'character varying'),
      ('users', 'email', 'character varying'),
      ('users', 'role', 'USER-DEFINED'),
      ('employees', 'employee_id', 'uuid'),
      ('employees', 'user_id', 'uuid'),
      ('employees', 'sap_id', 'character varying'),
      ('employees', 'employee_name', 'character varying'),
      ('employees', 'email', 'character varying'),
      ('employees', 'designation', 'character varying'),
      ('employees', 'employee_category', 'USER-DEFINED'),
      ('employees', 'department', 'character varying'),
      ('login_otps', 'otp_id', 'uuid'),
      ('login_otps', 'user_id', 'uuid'),
      ('login_otps', 'otp_hash', 'character'),
      ('login_otps', 'expires_at', 'timestamp with time zone'),
      ('login_otps', 'attempts', 'integer'),
      ('login_otps', 'consumed_at', 'timestamp with time zone')
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('users', 'employees', 'login_otps')) AS base_table_count,
    (SELECT COUNT(*)::INTEGER FROM expected e
      JOIN information_schema.columns c
        ON c.table_schema = current_schema()
       AND c.table_name = e.table_name
       AND c.column_name = e.column_name
       AND c.data_type = e.data_type) AS expected_column_count,
    (SELECT COUNT(*)::INTEGER FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema()
        AND t.typname IN ('user_role', 'employee_category')) AS enum_count,
    (SELECT COUNT(*)::INTEGER FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema()
        AND ((t.typname = 'user_role' AND e.enumlabel IN ('employee', 'engineer', 'admin'))
          OR (t.typname = 'employee_category' AND e.enumlabel IN ('Workman', 'Executive')))) AS expected_enum_label_count
`

export async function loadMigrations(migrationsDirectory) {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.toLowerCase().endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right, 'en'))

  const seenVersions = new Set()
  const migrations = []
  for (const file of files) {
    const match = file.match(MIGRATION_NAME)
    if (!match) throw new Error(`Invalid migration filename: ${file}`)
    const [, version, name] = match
    if (seenVersions.has(version)) throw new Error(`Duplicate migration version: ${version}`)
    seenVersions.add(version)
    const sql = await readFile(path.join(migrationsDirectory, file), 'utf8')
    migrations.push({ version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') })
  }
  return migrations
}

async function getInitialSchemaState(client) {
  const { rows } = await client.query(INITIAL_SCHEMA_STATE_SQL)
  const state = rows[0]
  if (!state) return 'partial'
  if (state.base_table_count === 0 && state.enum_count === 0) return 'empty'
  if (state.base_table_count === 3
      && state.expected_column_count === 18
      && state.enum_count === 2
      && state.expected_enum_label_count === 5) {
    return 'complete'
  }
  return 'partial'
}

async function recordMigration(client, migration) {
  await client.query(
    `INSERT INTO schema_migrations (version, name, checksum)
     VALUES ($1, $2, $3)`,
    [migration.version, migration.name, migration.checksum],
  )
}

/** Apply pending SQL migrations, or safely baseline the already-installed 001 schema. */
export async function runMigrations(pool, migrationsDirectory) {
  const migrations = await loadMigrations(migrationsDirectory)
  const client = await pool.connect()
  let lockAcquired = false

  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NAMESPACE, LOCK_KEY])
    lockAcquired = true

    const trackingTableResult = await client.query(
      "SELECT to_regclass(current_schema() || '.schema_migrations') IS NOT NULL AS exists",
    )
    if (!trackingTableResult.rows[0]?.exists) {
      const schemaState = await getInitialSchemaState(client)
      if (schemaState === 'partial') {
        throw new Error('Existing database has a partial initial schema; migration 001 was not run')
      }
      await client.query('BEGIN')
      try {
        await client.query(CREATE_MIGRATIONS_TABLE_SQL)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }

    const appliedRows = await client.query('SELECT version, checksum FROM schema_migrations')
    const applied = new Map(appliedRows.rows.map((row) => [row.version, row.checksum.trim()]))

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        if (applied.get(migration.version) !== migration.checksum) {
          throw new Error(`Checksum mismatch for applied migration ${migration.version}`)
        }
        continue
      }

      await client.query('BEGIN')
      try {
        if (migration.version === '001') {
          const schemaState = await getInitialSchemaState(client)
          if (schemaState === 'partial') {
            throw new Error('Existing database has a partial initial schema; migration 001 was not run')
          }
          if (schemaState === 'complete') {
            await recordMigration(client, migration)
            await client.query('COMMIT')
            applied.set(migration.version, migration.checksum)
            continue
          }
        }

        await client.query(migration.sql)
        await recordMigration(client, migration)
        await client.query('COMMIT')
        applied.set(migration.version, migration.checksum)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }

    return { appliedCount: migrations.filter((migration) => applied.has(migration.version)).length }
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, LOCK_KEY]).catch(() => {})
    }
    client.release()
  }
}
