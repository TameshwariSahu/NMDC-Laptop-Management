import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CREATE_MIGRATIONS_TABLE_SQL,
  loadMigrations,
  runMigrations,
} from '../src/db/migrationRunner.js'

class FakePool {
  constructor({ schemaState = 'empty', applied = new Map() } = {}) {
    this.schemaState = schemaState
    this.applied = new Map(applied)
    this.trackingTableCreated = this.applied.size > 0
    this.executedMigrations = []
    this.client = {
      query: async (sql, params = []) => this.query(sql, params),
      release: () => {},
    }
  }

  async connect() {
    return this.client
  }

  async query(sql, params) {
    const normalized = sql.trim()
    if (normalized.startsWith('SELECT pg_advisory_')) return { rows: [] }
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') return { rows: [] }
    if (normalized.startsWith('SELECT to_regclass(')) return { rows: [{ exists: this.trackingTableCreated }] }
    if (normalized === CREATE_MIGRATIONS_TABLE_SQL.trim()) {
      this.trackingTableCreated = true
      return { rows: [] }
    }
    if (normalized === 'SELECT version, checksum FROM schema_migrations') {
      return { rows: [...this.applied].map(([version, checksum]) => ({ version, checksum })) }
    }
    if (normalized.includes('FROM information_schema.tables')) {
      const states = {
        empty: { base_table_count: 0, expected_column_count: 0, enum_count: 0, expected_enum_label_count: 0 },
        complete: { base_table_count: 3, expected_column_count: 18, enum_count: 2, expected_enum_label_count: 5 },
        partial: { base_table_count: 1, expected_column_count: 6, enum_count: 1, expected_enum_label_count: 1 },
      }
      return { rows: [states[this.schemaState]] }
    }
    if (normalized.startsWith('INSERT INTO schema_migrations')) {
      const [version, , checksum] = params
      this.applied.set(version, checksum)
      return { rows: [] }
    }
    this.executedMigrations.push(normalized)
    return { rows: [] }
  }
}

async function withMigrations(files, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lms-migrations-'))
  try {
    for (const [name, sql] of Object.entries(files)) await writeFile(path.join(directory, name), sql)
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('loads migrations in version order and rejects duplicate versions', async () => {
  await withMigrations({ '002_second.sql': 'SELECT 2;', '001_first.sql': 'SELECT 1;' }, async (directory) => {
    const migrations = await loadMigrations(directory)
    assert.deepEqual(migrations.map(({ version }) => version), ['001', '002'])
    assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/)
  })

  await withMigrations({ '001_first.sql': 'SELECT 1;', '001_duplicate.sql': 'SELECT 2;' }, async (directory) => {
    await assert.rejects(loadMigrations(directory), /Duplicate migration version: 001/)
  })
})

test('runs pending migrations on an empty database and records them', async () => {
  await withMigrations({ '001_initial.sql': 'SELECT 1;', '002_next.sql': 'SELECT 2;' }, async (directory) => {
    const pool = new FakePool()
    const result = await runMigrations(pool, directory)
    assert.equal(result.appliedCount, 2)
    assert.deepEqual(pool.executedMigrations, ['SELECT 1;', 'SELECT 2;'])
    assert.equal(pool.applied.size, 2)
  })
})

test('baselines a complete existing 001 schema without executing it', async () => {
  await withMigrations({ '001_initial.sql': 'SELECT 1;', '002_next.sql': 'SELECT 2;' }, async (directory) => {
    const pool = new FakePool({ schemaState: 'complete' })
    await runMigrations(pool, directory)
    assert.deepEqual(pool.executedMigrations, ['SELECT 2;'])
    assert.equal(pool.applied.has('001'), true)
    assert.equal(pool.applied.has('002'), true)
  })
})

test('stops before running migration 001 on a partial schema', async () => {
  await withMigrations({ '001_initial.sql': 'SELECT 1;' }, async (directory) => {
    const pool = new FakePool({ schemaState: 'partial' })
    await assert.rejects(runMigrations(pool, directory), /partial initial schema/)
    assert.equal(pool.trackingTableCreated, false)
    assert.deepEqual(pool.executedMigrations, [])
    assert.equal(pool.applied.size, 0)
  })
})

test('rejects changed SQL for an already-applied migration', async () => {
  await withMigrations({ '001_initial.sql': 'SELECT 1;' }, async (directory) => {
    const pool = new FakePool({ applied: new Map([['001', '0'.repeat(64)]]) })
    await assert.rejects(runMigrations(pool, directory), /Checksum mismatch for applied migration 001/)
    assert.deepEqual(pool.executedMigrations, [])
  })
})

test('002 defines nullable audit actors, connection metadata, and append-only triggers', async () => {
  const sql = await readFile(new URL('../src/db/migrations/002_auth_sessions_audit_log.sql', import.meta.url), 'utf8')
  assert.match(sql, /actor_user_id UUID,\s+actor_sap_id VARCHAR\(40\),/)
  assert.match(sql, /CREATE TABLE audit_log[\s\S]*?ip_address INET,[\s\S]*?user_agent TEXT/)
  assert.match(sql, /CREATE TABLE auth_sessions[\s\S]*?ip_address INET,[\s\S]*?user_agent TEXT/)
  assert.match(sql, /BEFORE UPDATE OR DELETE ON audit_log/)
  assert.match(sql, /BEFORE TRUNCATE ON audit_log/)
})
