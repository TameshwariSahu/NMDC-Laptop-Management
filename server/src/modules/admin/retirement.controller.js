import { pool } from '../../db/pool.js'
import { isValidSapId, normalizeSapId } from '../../utils/sapId.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function err(status, message) { return Object.assign(new Error(message), { status }) }
async function setActor(client, user) {
  await client.query("SELECT set_config('app.actor_user_id',$1,true), set_config('app.actor_sap_id',$2,true)", [user.userId, user.sapId])
}
async function audit(client, actor, action, entity, id, details) {
  await client.query(`INSERT INTO audit_log (actor_user_id,actor_sap_id,action,entity_type,entity_id,details)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [actor.userId, actor.sapId, action, entity, id, JSON.stringify(details)])
}
export async function searchClearances(req, res, next) {
  try {
    const sapId = normalizeSapId(req.query.sapId)
    if (!isValidSapId(sapId)) throw err(400, 'SAP ID must be exactly 8 characters')
    const result = await pool.query(`SELECT c.clearance_id AS "clearanceId", c.status, c.remarks, c.created_at AS "createdAt",
      c.cleared_at AS "clearedAt", c.officer_sap_id AS "officerSapId", e.employee_id AS "employeeId", e.sap_id AS "sapId",
      e.employee_name AS "employeeName", e.department,
      COALESCE((SELECT json_agg(json_build_object('checkId',k.check_id,'checkKey',k.check_key,'checkLabel',k.check_label,
        'isMandatory',k.is_mandatory,'isComplete',k.is_complete,'checkedBySapId',k.checked_by_sap_id,'checkedAt',k.checked_at,'remarks',k.remarks)
        ORDER BY k.created_at) FROM retirement_clearance_checks k WHERE k.clearance_id=c.clearance_id),'[]'::json) AS checks
      FROM employees e JOIN retirement_clearances c ON c.employee_id=e.employee_id WHERE upper(e.sap_id)=upper($1)
      ORDER BY c.created_at DESC`, [sapId])
    return res.json({ clearances: result.rows })
  } catch (error) { return next(error) }
}
export async function createClearance(req, res, next) {
  const client = await pool.connect()
  try {
    const sapId = normalizeSapId(req.body?.sapId)
    if (!isValidSapId(sapId)) throw err(400, 'SAP ID must be exactly 8 characters')
    if (!sapId) throw err(400, 'sapId is required')
    const extras = req.body?.additionalChecks ?? []
    if (!Array.isArray(extras) || extras.length > 30 || extras.some((c) => !c || typeof c.checkKey !== 'string' || !/^[a-z0-9_-]{2,80}$/i.test(c.checkKey) || typeof c.checkLabel !== 'string' || !c.checkLabel.trim() || (c.isMandatory !== undefined && typeof c.isMandatory !== 'boolean'))) throw err(400, 'Invalid additional checks')
    await client.query('BEGIN'); await setActor(client, req.currentUser)
    const employee = await client.query('SELECT employee_id FROM employees WHERE upper(sap_id)=upper($1)', [sapId])
    if (!employee.rowCount) throw err(404, 'Employee not found')
    const created = await client.query(`INSERT INTO retirement_clearances (employee_id,created_by_user_id,created_by_sap_id,remarks)
      VALUES ($1,$2,$3,$4) RETURNING clearance_id,status,created_at`, [employee.rows[0].employee_id, req.currentUser.userId, req.currentUser.sapId, req.body.remarks?.trim() || null])
    const checks = [
      { checkKey: 'asset_return', checkLabel: 'Laptop and asset return', isMandatory: true },
      { checkKey: 'license_check', checkLabel: 'Microsoft license check', isMandatory: true },
      ...extras.map((c) => ({ checkKey: c.checkKey.trim(), checkLabel: c.checkLabel.trim(), isMandatory: c.isMandatory ?? true })),
    ]
    for (const check of checks) await client.query(`INSERT INTO retirement_clearance_checks (clearance_id,check_key,check_label,is_mandatory)
      VALUES ($1,$2,$3,$4)`, [created.rows[0].clearance_id,check.checkKey,check.checkLabel,check.isMandatory])
    await audit(client, req.currentUser, 'retirement_clearance_created', 'retirement_clearance', created.rows[0].clearance_id, { employeeSapId: sapId, checks: checks.map((c) => c.checkKey) })
    await client.query('COMMIT')
    return res.status(201).json({ clearance: created.rows[0] })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error) }
  finally { client.release() }
}
export async function addClearanceCheck(req, res, next) {
  const client = await pool.connect()
  try {
    const clearanceId = req.params.clearanceId, { checkKey, checkLabel, isMandatory = true } = req.body ?? {}
    if (!UUID.test(clearanceId) || typeof checkKey !== 'string' || !/^[a-z0-9_-]{2,80}$/i.test(checkKey) || typeof checkLabel !== 'string' || !checkLabel.trim() || typeof isMandatory !== 'boolean') throw err(400, 'Invalid check')
    await client.query('BEGIN'); await setActor(client, req.currentUser)
    const parent = await client.query('SELECT status FROM retirement_clearances WHERE clearance_id=$1 FOR UPDATE', [clearanceId])
    if (!parent.rowCount) throw err(404, 'Clearance not found')
    if (parent.rows[0].status === 'CLEARED') throw err(409, 'Checks for a cleared clearance cannot be changed')
    const result = await client.query(`INSERT INTO retirement_clearance_checks (clearance_id,check_key,check_label,is_mandatory)
      VALUES ($1,$2,$3,$4) RETURNING check_id AS "checkId"`, [clearanceId,checkKey.trim(),checkLabel.trim(),isMandatory])
    if (!result.rowCount) throw err(404, 'Clearance not found')
    await client.query('COMMIT'); return res.status(201).json({ check: result.rows[0] })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error) }
  finally { client.release() }
}
export async function updateClearanceCheck(req, res, next) {
  const client = await pool.connect()
  try {
    const { clearanceId, checkId } = req.params, { isComplete, remarks } = req.body ?? {}
    if (!UUID.test(clearanceId) || !UUID.test(checkId) || typeof isComplete !== 'boolean' || (remarks !== undefined && typeof remarks !== 'string')) throw err(400, 'Invalid check update')
    await client.query('BEGIN'); await setActor(client, req.currentUser)
    const parent = await client.query('SELECT status FROM retirement_clearances WHERE clearance_id=$1 FOR UPDATE', [clearanceId])
    if (!parent.rowCount) throw err(404, 'Clearance not found')
    if (parent.rows[0].status === 'CLEARED') throw err(409, 'Checks for a cleared clearance cannot be changed')
    const r = await client.query(`UPDATE retirement_clearance_checks SET is_complete=$3,
      checked_by_user_id=CASE WHEN $3 THEN $4::uuid ELSE NULL END, checked_by_sap_id=CASE WHEN $3 THEN $5 ELSE NULL END,
      checked_at=CASE WHEN $3 THEN NOW() ELSE NULL END, remarks=$6
      WHERE clearance_id=$1 AND check_id=$2 RETURNING check_id AS "checkId",is_complete AS "isComplete",remarks`,
      [clearanceId,checkId,isComplete,req.currentUser.userId,req.currentUser.sapId,remarks?.trim() ?? null])
    if (!r.rowCount) throw err(404, 'Check not found')
    await client.query('COMMIT'); return res.json({ check: r.rows[0] })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error) }
  finally { client.release() }
}
export async function finalizeClearance(req, res, next) {
  const client = await pool.connect()
  try {
    const id = req.params.clearanceId, remarks = String(req.body?.remarks ?? '').trim()
    if (!UUID.test(id) || !remarks || remarks.length > 2000) throw err(400, 'Clearance ID and officer remarks are required')
    await client.query('BEGIN')
    const c = await client.query('SELECT clearance_id,status FROM retirement_clearances WHERE clearance_id=$1 FOR UPDATE', [id])
    if (!c.rowCount) throw err(404, 'Clearance not found')
    if (c.rows[0].status === 'CLEARED') throw err(409, 'Clearance is already finalized')
    const counts = await client.query(`SELECT COUNT(*) FILTER (WHERE is_mandatory)::int AS mandatory,
      COUNT(*) FILTER (WHERE is_mandatory AND NOT is_complete)::int AS incomplete
      FROM retirement_clearance_checks WHERE clearance_id=$1`, [id])
    if (!counts.rows[0].mandatory || counts.rows[0].incomplete) throw err(409, 'All mandatory checks must be complete before clearance')
    const update = await client.query(`UPDATE retirement_clearances SET status='CLEARED',officer_user_id=$2,officer_sap_id=$3,
      remarks=$4,cleared_at=NOW() WHERE clearance_id=$1 RETURNING clearance_id AS "clearanceId",status,cleared_at AS "clearedAt",officer_sap_id AS "officerSapId"`,
      [id,req.currentUser.userId,req.currentUser.sapId,remarks])
    await audit(client, req.currentUser, 'retirement_clearance_finalized', 'retirement_clearance', id, { status: 'CLEARED', remarks })
    await client.query('COMMIT'); return res.json({ clearance: update.rows[0] })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error) }
  finally { client.release() }
}
