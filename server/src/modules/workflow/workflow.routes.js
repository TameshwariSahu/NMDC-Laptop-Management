import { Router, raw } from 'express'
import { requireDatabaseRole } from '../../middleware/databaseAuth.js'
import { uploadRequestInvoice } from '../laptopRequests/laptopRequests.controller.js'
import {
  decideRequest,
  downloadInvoice,
  editEngineerRequest,
  getWorkflowRequest,
  listWorkflowQueue,
  submitCorrection,
} from './workflow.controller.js'

const router = Router()
const engineerOnly = requireDatabaseRole('engineer')
const adminOnly = requireDatabaseRole('admin')
const reviewerOrOwner = requireDatabaseRole('employee', 'engineer', 'admin')
const employeeOrEngineer = requireDatabaseRole('employee', 'engineer')

router.get('/api/engineer/requests', ...engineerOnly, listWorkflowQueue)
router.get('/api/engineer/requests/:requestId', ...engineerOnly, getWorkflowRequest)
router.patch('/api/engineer/requests/:requestId', ...engineerOnly, editEngineerRequest)
router.post('/api/engineer/requests/:requestId/decision', ...engineerOnly, decideRequest)
router.post('/api/engineer/requests/:requestId/corrections', ...engineerOnly, submitCorrection)
router.post('/api/engineer/requests/:requestId/invoice', ...engineerOnly, (req, res, next) => {
  if (!req.is('multipart/form-data')) return res.status(415).json({ error: 'Use multipart/form-data and include an invoice' })
  return next()
}, raw({ type: 'multipart/form-data', limit: '6mb' }), uploadRequestInvoice)

router.get('/api/admin/requests', ...adminOnly, listWorkflowQueue)
router.get('/api/admin/requests/:requestId', ...adminOnly, getWorkflowRequest)
router.post('/api/admin/requests/:requestId/decision', ...adminOnly, decideRequest)

router.post('/api/employee/requests/:requestId/corrections', ...requireDatabaseRole('employee'), submitCorrection)
router.get('/api/invoices/:fileId/download', ...reviewerOrOwner, downloadInvoice)

export default router
