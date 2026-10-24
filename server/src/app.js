import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { env } from './config/env.js'
import authRoutes from './modules/auth/auth.routes.js'
import laptopRequestRoutes from './modules/laptopRequests/laptopRequests.routes.js'
import workflowRoutes from './modules/workflow/workflow.routes.js'
import adminRoutes from './modules/admin/admin.routes.js'
import { listReports } from './modules/reports/reports.controller.js'
import { requireDatabaseRole } from './middleware/databaseAuth.js'

export const app = express()
app.use(helmet())
app.use(cors({ origin: env.clientOrigin, credentials: true }))
app.use(express.json({ limit: '32kb' }))
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/api/auth', authRoutes)
app.use('/api/employee', laptopRequestRoutes)
app.use(workflowRoutes)
app.get('/api/engineer/reports', ...requireDatabaseRole('engineer'), listReports)
app.get('/api/admin/reports', ...requireDatabaseRole('admin'), listReports)
app.use(adminRoutes)
app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }))
app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON request body' })
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body exceeds the allowed size' })
  if (error.code === '23505') return res.status(409).json({ error: 'A record with a conflicting unique value already exists' })
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: error.message })
  }
  console.error('Unhandled API error:', error.message)
  return res.status(500).json({ error: 'Internal server error' })
})
