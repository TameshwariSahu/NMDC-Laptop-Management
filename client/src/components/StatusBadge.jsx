const labels = {
  PENDING_ENGINEER: 'Pending engineer',
  NEEDS_EMPLOYEE_CORRECTION: 'Needs correction',
  PENDING_ADMIN: 'Pending admin',
  NEEDS_ENGINEER_CORRECTION: 'Needs engineer review',
  APPROVED: 'Approved',
}

export default function StatusBadge({ status }) {
  return <span className={`status-badge status-${status?.toLowerCase()}`}>{labels[status] || status}</span>
}

export { labels as statusLabels }
