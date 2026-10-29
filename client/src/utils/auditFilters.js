export function localDateString(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function defaultAuditFilters(date = new Date()) {
  return { sapId: '', sapIdScope: 'changedBy', action: '', from: '', to: '' }
}

export function defaultAuditDateRangeIfEmpty(filters, date = new Date()) {
  if (filters.from || filters.to) return filters
  const today = localDateString(date)
  return { ...filters, from: today, to: today }
}

export function formatAuditDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${day}-${month}-${year} ${hour}:${minute}`
}

export function auditTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
