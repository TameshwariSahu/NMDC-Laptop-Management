import { pool } from '../../db/pool.js'
import { isValidSapId, normalizeSapId } from '../../utils/sapId.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CLEARANCE_REASONS = ['Retirement', 'Transfer', 'Resignation']
function err(status, message) { return Object.assign(new Error(message), { status }) }
async function setActor(client, user) {
  await client.query("SELECT set_config('app.actor_user_id',$1,true), set_config('app.actor_sap_id',$2,true)", [user.userId, user.sapId])
}
async function audit(client, actor, action, entity, id, details) {
  await client.query(`INSERT INTO audit_log (actor_user_id,actor_sap_id,action,entity_type,entity_id,details)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [actor.userId, actor.sapId, action, entity, id, JSON.stringify(details)])
}
async function listEmployeeClearances(queryable, sapId) {
  const result = await queryable.query(`SELECT c.clearance_id AS "clearanceId", c.status, c.reason, c.remarks, c.created_at AS "createdAt",
      c.cleared_at AS "clearedAt", c.officer_sap_id AS "officerSapId", e.employee_id AS "employeeId", e.sap_id AS "sapId",
      e.employee_name AS "employeeName", e.department,
      COALESCE((SELECT json_agg(json_build_object('checkId',k.check_id,'checkKey',k.check_key,'checkLabel',k.check_label,
        'isMandatory',k.is_mandatory,'isComplete',k.is_complete,'checkedBySapId',k.checked_by_sap_id,'checkedAt',k.checked_at,'remarks',k.remarks)
        ORDER BY k.created_at) FROM retirement_clearance_checks k
        WHERE k.clearance_id=c.clearance_id AND k.is_mandatory
          AND k.check_key IN ('company_software_removal','antivirus_removal')),'[]'::json) AS checks
      FROM employees e JOIN retirement_clearances c ON c.employee_id=e.employee_id WHERE upper(e.sap_id)=upper($1)
      ORDER BY c.created_at DESC`, [sapId])
  return result.rows
}
export async function searchClearances(req, res, next) {
  try {
    const sapId = normalizeSapId(req.query.sapId)
    if (!isValidSapId(sapId)) throw err(400, 'SAP ID must be exactly 8 characters')
    return res.json({ clearances: await listEmployeeClearances(pool, sapId) })
  } catch (error) { return next(error) }
}
export async function createClearance(req, res, next) {
  const client = await pool.connect()
  let transactionOpen = false
  try {
    const sapId = normalizeSapId(req.body?.sapId)
    if (!isValidSapId(sapId)) throw err(400, 'SAP ID must be exactly 8 characters')
    if (!sapId) throw err(400, 'sapId is required')
    if (!CLEARANCE_REASONS.includes(req.body?.reason)) throw err(400, 'Choose Retirement, Transfer, or Resignation as the reason')
    if (req.body?.additionalChecks !== undefined) throw err(400, 'Additional clearance checks are not supported')
    await client.query('BEGIN'); transactionOpen = true; await setActor(client, req.currentUser)
    const employee = await client.query('SELECT employee_id FROM employees WHERE upper(sap_id)=upper($1)', [sapId])
    if (!employee.rowCount) throw err(404, 'Employee not found')
    const existing = await listEmployeeClearances(client, sapId)
    if (existing.length) {
      await client.query('COMMIT'); transactionOpen = false
      return res.json({ clearance: existing[0] })
    }
    const created = await client.query(`INSERT INTO retirement_clearances (employee_id,created_by_user_id,created_by_sap_id,reason,remarks)
      VALUES ($1,$2,$3,$4,$5) RETURNING clearance_id,status,created_at`, [employee.rows[0].employee_id, req.currentUser.userId, req.currentUser.sapId, req.body.reason, req.body.remarks?.trim() || null])
    const checks = [
      { checkKey: 'company_software_removal', checkLabel: 'Remove company-installed software', isMandatory: true },
      { checkKey: 'antivirus_removal', checkLabel: 'Remove antivirus', isMandatory: true },
    ]
    for (const check of checks) await client.query(`INSERT INTO retirement_clearance_checks (clearance_id,check_key,check_label,is_mandatory)
      VALUES ($1,$2,$3,$4)`, [created.rows[0].clearance_id,check.checkKey,check.checkLabel,check.isMandatory])
    await audit(client, req.currentUser, 'retirement_clearance_created', 'retirement_clearance', created.rows[0].clearance_id, { employeeSapId: sapId, reason: req.body.reason, checks: checks.map((c) => c.checkKey) })
    const clearance = (await listEmployeeClearances(client, sapId))[0]
    await client.query('COMMIT'); transactionOpen = false
    return res.status(201).json({ clearance })
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
    if (error.code === '23505' && error.constraint === 'retirement_clearances_one_blocked_per_employee') {
      try {
        const existing = await listEmployeeClearances(pool, normalizeSapId(req.body?.sapId))
        if (existing.length) return res.json({ clearance: existing[0] })
      } catch (lookupError) { return next(lookupError) }
    }
    return next(error)
  }
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
    const id = req.params.clearanceId, remarks = String(req.body?.remarks ?? '').trim(), requestedReason = req.body?.reason
    if (!UUID.test(id) || !remarks || remarks.length > 2000) throw err(400, 'Clearance ID and officer remarks are required')
    if (requestedReason !== undefined && !CLEARANCE_REASONS.includes(requestedReason)) throw err(400, 'Choose Retirement, Transfer, or Resignation as the reason')
    await client.query('BEGIN')
    const c = await client.query('SELECT clearance_id,status,reason FROM retirement_clearances WHERE clearance_id=$1 FOR UPDATE', [id])
    if (!c.rowCount) throw err(404, 'Clearance not found')
    if (c.rows[0].status === 'CLEARED') throw err(409, 'Clearance is already finalized')
    const reason = c.rows[0].reason ?? requestedReason
    if (!CLEARANCE_REASONS.includes(reason)) throw err(400, 'Choose a reason before clearing this employee')
    const counts = await client.query(`SELECT COUNT(*) FILTER (WHERE is_mandatory)::int AS mandatory,
      COUNT(*) FILTER (WHERE is_mandatory AND NOT is_complete)::int AS incomplete
      FROM retirement_clearance_checks WHERE clearance_id=$1`, [id])
    if (!counts.rows[0].mandatory || counts.rows[0].incomplete) throw err(409, 'All mandatory checks must be complete before clearance')
    const update = await client.query(`UPDATE retirement_clearances SET status='CLEARED',reason=$5,officer_user_id=$2,officer_sap_id=$3,
      remarks=$4,cleared_at=NOW() WHERE clearance_id=$1 RETURNING clearance_id AS "clearanceId",status,reason,cleared_at AS "clearedAt",officer_sap_id AS "officerSapId"`,
      [id,req.currentUser.userId,req.currentUser.sapId,remarks,reason])
    await audit(client, req.currentUser, 'retirement_clearance_finalized', 'retirement_clearance', id, { status: 'CLEARED', reason, remarks })
    await client.query('COMMIT'); return res.json({ clearance: update.rows[0] })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); return next(error) }
  finally { client.release() }
}
