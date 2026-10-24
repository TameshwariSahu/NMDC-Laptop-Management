import { pool } from '../src/db/pool.js'

const demoAccounts = [
  {
    sapId: 'DEMP0001', email: 'employee@example.invalid', role: 'employee',
    employee: {
      name: 'Demo Employee', designation: 'Demo Analyst', category: 'Executive', department: 'Demo Department',
    },
  },
  { sapId: 'DENG0001', email: 'engineer@example.invalid', role: 'engineer' },
  { sapId: 'DADM0001', email: 'admin@example.invalid', role: 'admin' },
]

const client = await pool.connect()
try {
  await client.query('BEGIN')
  for (const account of demoAccounts) {
    const userResult = await client.query(
      `INSERT INTO users (sap_id, email, role)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [account.sapId, account.email, account.role],
    )
    let userId = userResult.rows[0]?.user_id
    if (!userId) {
      const existing = await client.query('SELECT user_id FROM users WHERE upper(sap_id) = upper($1)', [account.sapId])
      userId = existing.rows[0]?.user_id
    }
    if (!userId) throw new Error(`Could not resolve synthetic seed account ${account.sapId}`)
    if (account.employee) {
      await client.query(
        `INSERT INTO employees
           (user_id, sap_id, employee_name, email, designation, employee_category, department)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, account.sapId, account.employee.name, account.email,
          account.employee.designation, account.employee.category, account.employee.department],
      )
    }
  }
  await client.query('COMMIT')
  console.log('Inserted or retained synthetic demo accounts: 1 employee, 1 engineer, 1 admin.')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  console.error('Synthetic seed failed:', error.message)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
