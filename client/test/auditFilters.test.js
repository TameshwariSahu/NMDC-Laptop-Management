import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultAuditFilters, localDateString } from '../src/utils/auditFilters.js'

test('Audit page defaults both date filters to the current local date', () => {
  const currentLocal = new Date(2026, 9, 29, 23, 58, 10)
  const filters = defaultAuditFilters(currentLocal)
  assert.equal(filters.from, localDateString(currentLocal))
  assert.equal(filters.to, localDateString(currentLocal))
  assert.equal(filters.sapIdScope, 'changedBy')
})
