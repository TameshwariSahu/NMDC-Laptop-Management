export function normalizeEmail(value) {
  const email = String(value ?? '').trim()
  if (!email) return null
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false
  return email.toLowerCase()
}
