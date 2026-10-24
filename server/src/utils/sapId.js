export function normalizeSapId(value) {
  return String(value ?? '').trim().toUpperCase()
}

export function isValidSapId(value) {
  return typeof value === 'string' && value.length === 8
}
