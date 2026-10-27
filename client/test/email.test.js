import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeEmail } from '../src/utils/email.js'

test('Office account email is optional, trimmed, lowercase, and rejects malformed values', () => {
  assert.equal(normalizeEmail(''), null)
  assert.equal(normalizeEmail('  User.Name@Example.COM '), 'user.name@example.com')
  assert.equal(normalizeEmail('bad-email'), false)
  assert.equal(normalizeEmail('x'.repeat(321) + '@example.com'), false)
})
