const KNOWN_FIELDS = new Map([
  ['laptop_requests_serial_number_unique', ['serialNumber', 'Serial number already exists.']],
  ['laptop_requests_mac_address_unique', ['macAddress', 'MAC address already exists.']],
  ['users_sap_id_key', ['sapId', 'SAP ID already exists.']],
  ['users_sap_id_case_insensitive_idx', ['sapId', 'SAP ID already exists.']],
  ['employees_sap_id_key', ['sapId', 'SAP ID already exists.']],
  ['employees_sap_id_case_insensitive_idx', ['sapId', 'SAP ID already exists.']],
  ['employees_sap_id_matches_user', ['sapId', 'SAP ID already exists.']],
  ['users_email_key', ['email', 'Email address already exists.']],
  ['users_email_unique_idx', ['email', 'Email address already exists.']],
  ['users_email_case_insensitive_idx', ['email', 'Email address already exists.']],
  ['employees_email_key', ['email', 'Email address already exists.']],
  ['employees_email_unique_idx', ['email', 'Email address already exists.']],
  ['employees_email_case_insensitive_idx', ['email', 'Email address already exists.']],
])

export function getUniqueViolationField(error) {
  if (error?.code !== '23505') return null
  const constraint = String(error.constraint ?? '').toLowerCase()
  const known = KNOWN_FIELDS.get(constraint)
  if (known) return { field: known[0], message: known[1] }
  if (constraint.includes('email')) return { field: 'email', message: 'Email address already exists.' }
  if (constraint.includes('sap_id') || constraint.includes('sapid')) return { field: 'sapId', message: 'SAP ID already exists.' }
  if (constraint.includes('serial')) return { field: 'serialNumber', message: 'Serial number already exists.' }
  if (constraint.includes('mac')) return { field: 'macAddress', message: 'MAC address already exists.' }
  return null
}
