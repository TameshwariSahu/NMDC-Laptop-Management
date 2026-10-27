const PLAIN_KEY_PATTERN = /^[A-Za-z0-9]{25}$/
const GROUPED_KEY_PATTERN = /^[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}$/

export function normalizeLicenseKey(value) {
  const input = String(value ?? '')
  if (!input) return ''
  if (PLAIN_KEY_PATTERN.test(input)) return input.toUpperCase()
  if (GROUPED_KEY_PATTERN.test(input)) return input.replaceAll('-', '').toUpperCase()
  return null
}
