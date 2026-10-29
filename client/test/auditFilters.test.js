import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultAuditDateRangeIfEmpty, defaultAuditFilters, formatAuditDateTime, localDateString } from '../src/utils/auditFilters.js'

test('Audit page opens with an empty range to show all entries', () => {
  const currentLocal = new Date(2026, 9, 29, 23, 58, 10)
  const filters = defaultAuditFilters(currentLocal)
  assert.equal(filters.from, '')
  assert.equal(filters.to, '')
  assert.equal(filters.sapIdScope, 'changedBy')
})

test('Audit table displays local dates as DD-MM-YYYY HH:mm', () => {
  const value = new Date(2026, 0, 7, 9, 5).toISOString()
  assert.equal(formatAuditDateTime(value), '07-01-2026 09:05')
})

test('Focusing an empty date filter defaults both bounds to today but preserves chosen dates', () => {
  const now = new Date(2026, 9, 29, 23, 58)
  const empty = defaultAuditFilters(now)
  const defaulted = defaultAuditDateRangeIfEmpty(empty, now)
  assert.deepEqual({ from: defaulted.from, to: defaulted.to }, { from: localDateString(now), to: localDateString(now) })
  const chosen = { ...defaulted, from: '2026-10-20' }
  assert.equal(defaultAuditDateRangeIfEmpty(chosen, now), chosen)
})
