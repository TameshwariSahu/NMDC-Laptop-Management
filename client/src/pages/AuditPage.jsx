import { useCallback, useEffect, useState } from 'react'
import { laptopApi } from '../services/laptopApi.js'
import { defaultAuditFilters } from '../utils/auditFilters.js'

const PAGE_SIZE = 25
const FIELD_LABELS = {
  serialNumber: 'Serial number', purchaseDate: 'Purchase date', modelNumber: 'Model number',
  macAddress: 'MAC address', operatingSystem: 'Operating system', msOfficeAccountEmail: 'MS Office account email',
  employeeName: 'Name', designation: 'Designation', employeeCategory: 'Category', department: 'Department',
  sapId: 'SAP ID', email: 'Email', role: 'Role', isActive: 'Account status', windowsKey: 'Windows key', officeKey: 'MS Office key',
}
function dateTime(value) { return value ? new Date(value).toLocaleString() : '—' }
function changeText(entry) {
  const parts = []
  for (const [field, change] of Object.entries(entry.changes ?? {})) {
    const label = FIELD_LABELS[field] ?? field
    if (change === 'changed') parts.push(`${label}: changed`)
    else if (change && typeof change === 'object') parts.push(`${label}: ${change.old ?? 'empty'} → ${change.new ?? 'empty'}`)
  }
  for (const field of entry.changedFields ?? []) {
    if (!Object.hasOwn(entry.changes ?? {}, field)) parts.push(`${FIELD_LABELS[field] ?? field}: recorded (legacy)`)
  }
  if (entry.oldStatus || entry.newStatus) parts.push(`Status: ${entry.oldStatus ?? 'New'} → ${entry.newStatus ?? ''}`)
  return parts.length ? parts.join('; ') : 'No field values recorded'
}

export default function AuditPage() {
  const [filters, setFilters] = useState(() => defaultAuditFilters())
  const [active, setActive] = useState(() => defaultAuditFilters())
  const [entries, setEntries] = useState([])
  const [pagination, setPagination] = useState({ limit: PAGE_SIZE, offset: 0, total: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (offset = 0, query = active) => {
    setBusy(true); setError('')
    try {
      const result = await laptopApi.listAudit({ ...query, limit: PAGE_SIZE, offset })
      setEntries(result.entries); setPagination(result.pagination)
    } catch (err) { setError(err.message || 'Could not load audit entries.') }
    finally { setBusy(false) }
  }, [active])

  useEffect(() => { load(0, active) }, [active, load])
  const apply = (event) => { event.preventDefault(); setPagination((page) => ({ ...page, offset: 0 })); setActive({ ...filters, sapId: filters.sapId.trim().toUpperCase(), action: filters.action.trim() }) }
  const download = async () => {
    setBusy(true); setError('')
    try { await laptopApi.downloadAuditExcel(active) }
    catch (err) { setError(err.message || 'Could not export audit entries.') }
    finally { setBusy(false) }
  }

  return <div className="page-stack">
    <div className="page-heading"><div><span className="eyebrow">ADMIN WORKSPACE</span><h1>Audit</h1><p>Read-only history of account and laptop request activity.</p></div></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    <section className="surface table-surface">
      <form className="report-filters audit-filters" onSubmit={apply}>
        <label>Person SAP ID<input value={filters.sapId} onChange={(e) => setFilters({ ...filters, sapId: e.target.value })} maxLength={40} /></label>
        <label>Match SAP ID<select value={filters.sapIdScope} onChange={(e) => setFilters({ ...filters, sapIdScope: e.target.value })}><option value="changedBy">Changed by</option><option value="affectedEmployee">Affected employee</option></select></label>
        <label>Search action<input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} maxLength={100} placeholder="Search action label or name" /></label>
        <label>From<input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
        <label>To<input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
        <button className="button button-primary" type="submit" disabled={busy}>Apply filters</button>
        <button className="button button-quiet" type="button" onClick={download} disabled={busy}>Download Excel</button>
      </form>
      <div className="table-scroll"><table className="audit-table"><thead><tr><th>WHEN</th><th>WHO</th><th>ACTION</th><th>AFFECTED RECORD</th><th>WHAT CHANGED</th></tr></thead>
        <tbody>{entries.map((entry, index) => <tr key={`${entry.occurredAt}-${entry.action}-${index}`}>
          <td>{dateTime(entry.occurredAt)}</td><td>{entry.who}</td><td>{entry.actionLabel}</td><td>{entry.affectedRecord}</td><td>{changeText(entry)}</td>
        </tr>)}
        {!entries.length && <tr><td colSpan="5" className="table-message">{busy ? 'Loading audit entries…' : 'No audit entries match these filters.'}</td></tr>}</tbody>
      </table></div>
      <div className="pagination-row"><span>{pagination.total ? `${pagination.offset + 1}–${Math.min(pagination.offset + pagination.limit, pagination.total)} of ${pagination.total}` : '0 entries'}</span>
        <div><button className="button button-quiet" disabled={busy || pagination.offset === 0} onClick={() => load(Math.max(0, pagination.offset - pagination.limit))}>Previous</button>
          <button className="button button-quiet" disabled={busy || pagination.offset + pagination.limit >= pagination.total} onClick={() => load(pagination.offset + pagination.limit)}>Next</button></div>
      </div>
    </section>
  </div>
}
