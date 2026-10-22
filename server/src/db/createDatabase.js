import pg from 'pg'
import { env } from '../config/env.js'

const { Client } = pg
const target = new URL(env.databaseUrl)
const databaseName = decodeURIComponent(target.pathname.slice(1))
if (!/^[a-zA-Z_][a-zA-Z0-9_$-]*$/.test(databaseName)) {
  throw new Error('DATABASE_URL must include a valid database name')
}
target.pathname = '/postgres'

const client = new Client({ connectionString: target.toString() })
try {
  await client.connect()
  const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName])
  if (result.rowCount === 0) {
    await client.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`)
    console.log(`Created PostgreSQL database: ${databaseName}`)
  } else {
    console.log(`PostgreSQL database already exists: ${databaseName}`)
  }
} catch (error) {
  console.error('Database creation failed:', error.message)
  process.exitCode = 1
} finally {
  await client.end()
}
