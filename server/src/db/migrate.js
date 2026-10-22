import { readFile } from 'node:fs/promises'
import { pool } from './pool.js'

try {
  const migration = await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8')
  await pool.query(migration)
  console.log('Database migration complete')
} catch (error) {
  console.error('Database migration failed:', error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
