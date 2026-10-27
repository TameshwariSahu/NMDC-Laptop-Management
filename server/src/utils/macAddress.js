const MAC_ADDRESS_PATTERN = /^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2})$/i

export function normalizeMacAddress(value) {
  const input = String(value ?? '').trim()
  if (!MAC_ADDRESS_PATTERN.test(input)) return null
  return input.replaceAll(':', '').toUpperCase()
}
