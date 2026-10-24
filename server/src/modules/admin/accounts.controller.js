import { pool } from '../../db/pool.js'
import { isValidSapId, normalizeSapId } from '../../utils/sapId.js'

const ROLES = ['employee', 'engineer', 'admin']
function err(status, message) { return Object.assign(new Error(message), { status }) }
async function audit(client, actor, action, id, details) {
  await client.query(`INSERT INTO audit_log (actor_user_id, actor_sap_id, action, entity_type, entity_id, details)
    VALUES ($1,$2,$3,'user',$4,$5::jsonb)`, [actor.userId, actor.sapId, action, id, JSON.stringify(details)])
}
function employeeFields(body) {
  const f = ['employeeName', 'designation', 'employeeCategory', 'department']
  if (f.some((key) => typeof body[key] !== 'string' || !body[key].trim())) throw err(400, 'Employee accounts require employeeName, designation, employeeCategory and department')
  if (!['Workman', 'Executive'].includes(body.employeeCategory)) throw err(400, 'employeeCategory must be Workman or Executive')
  return [body.employeeName.trim(), body.designation.trim(), body.employeeCategory, body.department.trim()]
}
export async function listAccounts(req, res, next) {
  try {
    const limit = Number(req.query.limit ?? 50), offset = Number(req.query.offset ?? 0)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw err(400, 'Invalid pagination')
    const q = String(req.query.q ?? '').trim()
    const values = q ? [`%${q}%`, limit, offset] : [limit, offset]
    const filter = q ? 'WHERE u.sap_id ILIKE $1 OR u.email ILIKE $1 OR e.employee_name ILIKE $1' : ''
    const rows = await pool.query(`SELECT u.user_id AS "userId",u.sap_id AS "sapId",u.email,u.role,u.is_active AS "isActive",
      e.employee_name AS "employeeName",e.designation,e.employee_category AS "employeeCategory",e.department,u.created_at AS "createdAt"
      FROM users u LEFT JOIN employees e ON e.user_id=u.user_id ${filter} ORDER BY u.created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values)
    return res.json({ accounts: rows.rows, pagination: { limit, offset } })
  } catch (error) { return next(error) }
}
export async function createAccount(req, res, next) {
  const client = await pool.connect()
  try {
    const { sapId, email, role } = req.body ?? {}
    const normalizedSapId = normalizeSapId(sapId)
    if (!isValidSapId(normalizedSapId) || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || !ROLES.includes(role)) throw err(400, 'Provide an 8-character SAP ID, valid email and role')
    const profile = role === 'employee' ? employeeFields(req.body) : null
    await client.query('BEGIN')
    const result = await client.query('INSERT INTO users (sap_id,email,role) VALUES ($1,$2,$3) RETURNING user_id,sap_id,email,role,is_active', [normalizedSapId, email.trim(), role])
    const user = result.rows[0]
    if (profile) await client.query(`INSERT INTO employees (user_id,sap_id,employee_name,email,designation,employee_category,department)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [user.user_id, user.sap_id, profile[0], user.email, profile[1], profile[2], profile[3]])
    await audit(client, req.currentUser, 'account_created', user.user_id, { sapId: user.sap_id, role, changedFields: ['sapId','email','role', ...(profile ? ['employeeProfile'] : [])] })
    await client.query('COMMIT')
    return res.status(201).json({ account: {
      userId: user.user_id, sapId: user.sap_id, email: user.email, role, isActive: user.is_active,
      ...(profile ? { employeeName: profile[0], designation: profile[1], employeeCategory: profile[2], department: profile[3] } : {}),
    } })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error) }
  finally { client.release() }
}
export async function updateAccount(req, res, next) {
  const client = await pool.connect()
  try {
    const id = req.params.userId, body = req.body ?? {}
    if (!/^[0-9a-f-]{36}$/i.test(id) || Object.keys(body).some((k) => !['role','isActive','employeeName','designation','employeeCategory','department'].includes(k))) throw err(400, 'Invalid account update')
    if (body.role !== undefined && !ROLES.includes(body.role)) throw err(400, 'Invalid role')
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') throw err(400, 'isActive must be boolean')
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(731943, 1)')
    const result = await client.query('SELECT user_id,sap_id,role,is_active FROM users WHERE user_id=$1 FOR UPDATE', [id])
    const target = result.rows[0]
    if (!target) throw err(404, 'Account not found')
    const newRole = body.role ?? target.role, newActive = body.isActive ?? target.is_active
    if (target.user_id === req.currentUser.userId && (newRole !== 'admin' || !newActive)) throw err(409, 'An Admin cannot demote or deactivate their own account')
    if (target.role === 'admin' && target.is_active && (newRole !== 'admin' || !newActive)) {
      const n = await client.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND is_active=TRUE")
      if (n.rows[0].n <= 1) throw err(409, 'The last active Admin cannot be removed')
    }
    const changed = []
    if (newRole !== target.role) changed.push('role')
    if (newActive !== target.is_active) changed.push('isActive')
    await client.query('UPDATE users SET role=$2,is_active=$3,updated_at=NOW() WHERE user_id=$1', [id,newRole,newActive])
    if (newRole === 'employee') {
      const existing = await client.query('SELECT employee_id FROM employees WHERE user_id=$1', [id])
      if (!existing.rowCount) {
        const profile = employeeFields(body)
        await client.query(`INSERT INTO employees (user_id,sap_id,employee_name,email,designation,employee_category,department)
          SELECT user_id,sap_id,$2,email,$3,$4,$5 FROM users WHERE user_id=$1`, [id,profile[0],profile[1],profile[2],profile[3]])
        changed.push('employeeProfile')
      } else {
        const fields = ['employeeName','designation','employeeCategory','department'].filter((k) => body[k] !== undefined)
        if (fields.length) {
          const profile = employeeFields({
            employeeName: body.employeeName ?? (await client.query('SELECT employee_name FROM employees WHERE user_id=$1',[id])).rows[0].employee_name,
            designation: body.designation ?? (await client.query('SELECT designation FROM employees WHERE user_id=$1',[id])).rows[0].designation,
            employeeCategory: body.employeeCategory ?? (await client.query('SELECT employee_category FROM employees WHERE user_id=$1',[id])).rows[0].employee_category,
            department: body.department ?? (await client.query('SELECT department FROM employees WHERE user_id=$1',[id])).rows[0].department,
          })
          await client.query('UPDATE employees SET employee_name=$2,designation=$3,employee_category=$4,department=$5 WHERE user_id=$1',[id,...profile]); changed.push('employeeProfile')
        }
      }
    }
    if (changed.length) await audit(client, req.currentUser, 'account_updated', id, { sapId: target.sap_id, changedFields: changed, role: newRole, isActive: newActive })
    await client.query('COMMIT')
    return res.json({ account: { userId: id, sapId: target.sap_id, role: newRole, isActive: newActive } })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error) }
  finally { client.release() }
}
