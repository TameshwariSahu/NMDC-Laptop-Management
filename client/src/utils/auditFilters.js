export function localDateString(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function defaultAuditFilters(date = new Date()) {
  const today = localDateString(date)
  return { sapId: '', sapIdScope: 'changedBy', action: '', from: today, to: today }
}

export function auditTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
