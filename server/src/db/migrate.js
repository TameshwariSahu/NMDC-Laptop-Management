import path from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'
import { runMigrations } from './migrationRunner.js'

const migrationsDirectory = path.join(dirname(fileURLToPath(import.meta.url)), 'migrations')

try {
  const result = await runMigrations(pool, migrationsDirectory)
  console.log(`Database migrations are up to date (${result.appliedCount} recorded).`)
} catch (error) {
  console.error('Database migration failed:', error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
