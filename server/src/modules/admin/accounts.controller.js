import { pool } from '../../db/pool.js'
import { isValidSapId, normalizeSapId } from '../../utils/sapId.js'

const ROLES = ['employee', 'engineer', 'admin']
function err(status, message) { return Object.assign(new Error(message), { status }) }
async function audit(client, actor, action, id, details) {
  await client.query(`INSERT INTO audit_log (actor_user_id, actor_sap_id, action, entity_type, entity_id, details)
    VALUES ($1,$2,$3,'user',$4,$5::jsonb)`, [actor.userId, actor.sapId, action, id, JSON.stringify(details)])
}
function profileFields(body) {
  const f = ['employeeName', 'designation', 'employeeCategory', 'department']
  if (f.some((key) => typeof body[key] !== 'string' || !body[key].trim())) throw err(400, 'All accounts require employeeName, designation, employeeCategory and department')
  if (body.employeeName.trim().length > 160 || body.designation.trim().length > 120 || body.department.trim().length > 120) throw err(400, 'Name, designation or department is too long')
  if (!['Workman', 'Executive', 'JO'].includes(body.employeeCategory)) throw err(400, 'employeeCategory must be Workman, Executive or JO')
  return [body.employeeName.trim(), body.designation.trim(), body.employeeCategory, body.department.trim()]
}
export async function listAccounts(req, res, next) {
  try {
    const limit = Number(req.query.limit ?? 50), offset = Number(req.query.offset ?? 0)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw err(400, 'Invalid pagination')
    const q = String(req.query.q ?? '').trim()
    const values = q ? [`%${q}%`, limit, offset] : [limit, offset]
    const filter = q ? 'WHERE u.sap_id ILIKE $1 OR u.email ILIKE $1 OR e.employee_name ILIKE $1' : ''
    const [rows, count] = await Promise.all([
      pool.query(`SELECT u.user_id AS "userId",u.sap_id AS "sapId",u.email,u.role,u.is_active AS "isActive",
      e.employee_name AS "employeeName",e.designation,e.employee_category AS "employeeCategory",e.department,u.created_at AS "createdAt"
      FROM users u LEFT JOIN employees e ON e.user_id=u.user_id ${filter} ORDER BY u.created_at DESC LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}`, values),
      pool.query(`SELECT COUNT(*)::INTEGER AS total FROM users u LEFT JOIN employees e ON e.user_id=u.user_id ${filter}`, q ? [values[0]] : []),
    ])
    return res.json({ accounts: rows.rows, pagination: { limit, offset, total: count.rows[0].total } })
  } catch (error) { return next(error) }
}
export async function createAccount(req, res, next) {
  const client = await pool.connect()
  try {
    const { sapId, email, role } = req.body ?? {}
    const normalizedSapId = normalizeSapId(sapId)
    if (!isValidSapId(normalizedSapId) || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || !ROLES.includes(role)) throw err(400, 'Provide an 8-character SAP ID, valid email and role')
    const profile = profileFields(req.body)
    await client.query('BEGIN')
    const result = await client.query('INSERT INTO users (sap_id,email,role) VALUES ($1,$2,$3) RETURNING user_id,sap_id,email,role,is_active', [normalizedSapId, email.trim(), role])
    const user = result.rows[0]
    await client.query(`INSERT INTO employees (user_id,sap_id,employee_name,email,designation,employee_category,department)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [user.user_id, user.sap_id, profile[0], user.email, profile[1], profile[2], profile[3]])
    await audit(client, req.currentUser, 'account_created', user.user_id, {
      sapId: user.sap_id, role, changedFields: ['sapId','email','role','employeeProfile'],
      changes: {
        sapId: { old: null, new: user.sap_id }, email: { old: null, new: user.email },
        role: { old: null, new: role }, employeeName: { old: null, new: profile[0] },
        designation: { old: null, new: profile[1] }, employeeCategory: { old: null, new: profile[2] },
        department: { old: null, new: profile[3] },
      },
    })
    await client.query('COMMIT')
    return res.status(201).json({ account: {
      userId: user.user_id, sapId: user.sap_id, email: user.email, role, isActive: user.is_active,
      employeeName: profile[0], designation: profile[1], employeeCategory: profile[2], department: profile[3],
    } })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error) }
  finally { client.release() }
}

export async function updateAccountProfile(req, res, next) {
  const client = await pool.connect()
  try {
    const id = req.params.userId
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw err(400, 'Invalid account ID')
    const profile = profileFields(req.body ?? {})
    await client.query('BEGIN')
    const user = await client.query('SELECT user_id,sap_id,email,role FROM users WHERE user_id=$1 FOR UPDATE', [id])
    if (!user.rowCount) throw err(404, 'Account not found')
    const current = await client.query(`SELECT employee_id,employee_name,designation,employee_category,department
      FROM employees WHERE user_id=$1`, [id])
    const before = current.rows[0]
    if (current.rowCount) {
      await client.query(`UPDATE employees SET employee_name=$2,designation=$3,employee_category=$4,department=$5
        WHERE user_id=$1`, [id, ...profile])
    } else {
      await client.query(`INSERT INTO employees (user_id,sap_id,employee_name,email,designation,employee_category,department)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, user.rows[0].sap_id, profile[0], user.rows[0].email, profile[1], profile[2], profile[3]])
    }
    await audit(client, req.currentUser, current.rowCount ? 'account_profile_updated' : 'account_profile_created', id, {
      sapId: user.rows[0].sap_id, role: user.rows[0].role,
      changedFields: ['employeeName','designation','employeeCategory','department'],
      changes: Object.fromEntries(['employeeName','designation','employeeCategory','department'].map((field, index) => [
        field, { old: before ? before[{ employeeName: 'employee_name', designation: 'designation', employeeCategory: 'employee_category', department: 'department' }[field]] : null, new: profile[index] },
      ])),
    })
    await client.query('COMMIT')
    return res.json({ account: {
      userId: id, sapId: user.rows[0].sap_id, role: user.rows[0].role,
      employeeName: profile[0], designation: profile[1], employeeCategory: profile[2], department: profile[3],
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
    const result = await client.query('SELECT user_id,sap_id,email,role,is_active FROM users WHERE user_id=$1 FOR UPDATE', [id])
    const target = result.rows[0]
    if (!target) throw err(404, 'Account not found')
    const newRole = body.role ?? target.role, newActive = body.isActive ?? target.is_active
    if (target.user_id === req.currentUser.userId && (newRole !== 'admin' || !newActive)) throw err(409, 'An Admin cannot demote or deactivate their own account')
    if (target.role === 'admin' && target.is_active && (newRole !== 'admin' || !newActive)) {
      const n = await client.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND is_active=TRUE")
      if (n.rows[0].n <= 1) throw err(409, 'The last active Admin cannot be removed')
    }
    const changed = [], changes = {}
    if (body.role !== undefined && newRole !== target.role) changes.role = { old: target.role, new: newRole }
    if (body.isActive !== undefined && newActive !== target.is_active) changes.isActive = { old: target.is_active, new: newActive }
    if (newRole !== target.role) changed.push('role')
    if (newActive !== target.is_active) changed.push('isActive')
    await client.query('UPDATE users SET role=$2,is_active=$3,updated_at=NOW() WHERE user_id=$1', [id,newRole,newActive])
    if (newRole === 'employee') {
      const existing = await client.query(`SELECT employee_id,employee_name,designation,employee_category,department
        FROM employees WHERE user_id=$1`, [id])
      if (!existing.rowCount) {
        const profile = profileFields(body)
        await client.query(`INSERT INTO employees (user_id,sap_id,employee_name,email,designation,employee_category,department)
          SELECT user_id,sap_id,$2,email,$3,$4,$5 FROM users WHERE user_id=$1`, [id,profile[0],profile[1],profile[2],profile[3]])
        changed.push('employeeProfile')
        for (const [field, index] of [['employeeName',0],['designation',1],['employeeCategory',2],['department',3]]) changes[field] = { old: null, new: profile[index] }
      } else {
        const fields = ['employeeName','designation','employeeCategory','department'].filter((k) => body[k] !== undefined)
        if (fields.length) {
          const profile = profileFields({
            employeeName: body.employeeName ?? (await client.query('SELECT employee_name FROM employees WHERE user_id=$1',[id])).rows[0].employee_name,
            designation: body.designation ?? (await client.query('SELECT designation FROM employees WHERE user_id=$1',[id])).rows[0].designation,
            employeeCategory: body.employeeCategory ?? (await client.query('SELECT employee_category FROM employees WHERE user_id=$1',[id])).rows[0].employee_category,
            department: body.department ?? (await client.query('SELECT department FROM employees WHERE user_id=$1',[id])).rows[0].department,
          })
          await client.query('UPDATE employees SET employee_name=$2,designation=$3,employee_category=$4,department=$5 WHERE user_id=$1',[id,...profile]); changed.push('employeeProfile')
          const keys = ['employeeName','designation','employeeCategory','department']
          const columns = ['employee_name','designation','employee_category','department']
          keys.forEach((key, index) => {
            const old = existing.rows[0][columns[index]], value = profile[index]
            if (old !== value) changes[key] = { old, new: value }
          })
        }
      }
    }
    if (changed.length) await audit(client, req.currentUser, 'account_updated', id, {
      sapId: target.sap_id, changedFields: changed, changes, role: newRole, isActive: newActive,
    })
    await client.query('COMMIT')
    return res.json({ account: { userId: id, sapId: target.sap_id, role: newRole, isActive: newActive } })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error) }
  finally { client.release() }
}
