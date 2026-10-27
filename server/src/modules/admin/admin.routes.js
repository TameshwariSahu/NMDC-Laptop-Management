import { Router } from 'express'
import { requireDatabaseRole } from '../../middleware/databaseAuth.js'
import { createAccount, listAccounts, updateAccount } from './accounts.controller.js'
import { createClearance, finalizeClearance, searchClearances, updateClearanceCheck } from './retirement.controller.js'
import { exportReportsExcel } from '../reports/reports.controller.js'

const router = Router()
const adminOnly = requireDatabaseRole('admin')
router.get('/api/admin/accounts', ...adminOnly, listAccounts)
router.post('/api/admin/accounts', ...adminOnly, createAccount)
router.patch('/api/admin/accounts/:userId', ...adminOnly, updateAccount)
router.get('/api/admin/reports/export.xlsx', ...adminOnly, exportReportsExcel)
router.get('/api/admin/retirement-clearances', ...adminOnly, searchClearances)
router.post('/api/admin/retirement-clearances', ...adminOnly, createClearance)
router.patch('/api/admin/retirement-clearances/:clearanceId/checks/:checkId', ...adminOnly, updateClearanceCheck)
router.post('/api/admin/retirement-clearances/:clearanceId/clear', ...adminOnly, finalizeClearance)
export default router
