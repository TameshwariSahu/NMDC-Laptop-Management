import { Router, raw } from 'express'
import { requireDatabaseRole } from '../../middleware/databaseAuth.js'
import {
  createLaptopRequest,
  listOwnLaptopRequests,
  uploadRequestInvoice,
} from './laptopRequests.controller.js'

const router = Router()
const employeeOnly = requireDatabaseRole('employee')
const employeeOrEngineer = requireDatabaseRole('employee', 'engineer')
const parseInvoiceBody = raw({ type: 'multipart/form-data', limit: '6mb' })

router.post('/requests', ...employeeOnly, (req, res, next) => {
  if (!req.currentUser.employeeId) return res.status(403).json({ error: 'Employee profile is required' })
  return next()
}, parseInvoiceBody, createLaptopRequest)

router.post('/requests/:requestId/invoice', ...employeeOrEngineer, parseInvoiceBody, uploadRequestInvoice)

router.get('/requests', ...employeeOnly, (req, res, next) => {
  if (!req.currentUser.employeeId) return res.status(403).json({ error: 'Employee profile is required' })
  return next()
}, listOwnLaptopRequests)

export default router
