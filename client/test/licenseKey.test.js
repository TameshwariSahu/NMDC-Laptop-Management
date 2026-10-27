import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeLicenseKey } from '../src/utils/licenseKey.js'

test('normalizes 25 character license keys with or without dashes to uppercase', () => {
  assert.equal(normalizeLicenseKey('abcde12345fghij67890klmno'), 'ABCDE12345FGHIJ67890KLMNO')
  assert.equal(normalizeLicenseKey('abcde-12345-fghij-67890-klmno'), 'ABCDE12345FGHIJ67890KLMNO')
})

test('keeps license keys optional and rejects malformed values', () => {
  assert.equal(normalizeLicenseKey(''), '')
  for (const invalid of ['ABCD12345FGHIJ67890KLMNO', 'ABCDE-12345-FGHIJ-67890', 'ABCDE_12345_FGHIJ_67890_KLMNO', 'ABCDE-12345-FGHIJ-67890-KLMN!', ' ABCDE12345FGHIJ67890KLMNO ']) {
    assert.equal(normalizeLicenseKey(invalid), null)
  }
})
