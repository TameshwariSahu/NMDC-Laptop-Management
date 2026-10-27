import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import EmptyState from '../components/EmptyState.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { laptopApi } from '../services/laptopApi.js'

const initialFilters = { status: '', sapId: '', from: '', to: '', duplicateOnly: '' }
export default function ReportsPage() {
  const { user } = useAuth()
  const [reports, setReports] = useState([])
  const [pagination, setPagination] = useState({ limit: 25, offset: 0, total: 0 })
  const [filters, setFilters] = useState(initialFilters)
  const [activeFilters, setActiveFilters] = useState(initialFilters)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  async function refresh(offset = pagination.offset, query = activeFilters) {
    setLoading(true); setError('')
    try {
      const result = await laptopApi.listReports(user.role, { ...query, limit: pagination.limit, offset })
      setReports(result.reports); setPagination(result.pagination)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh(0, initialFilters) }, [user.role])
  function apply(event) { event.preventDefault(); setActiveFilters(filters); refresh(0, filters) }
  async function downloadExcel() {
    setExporting(true); setError('')
    try { await laptopApi.downloadReportExcel(activeFilters) }
    catch (e) { setError(e.message) }
    finally { setExporting(false) }
  }
  const duplicateCount = reports.filter((r) => r.duplicateKeyWarning).length
  const approvedCount = reports.filter((r) => r.status === 'APPROVED').length
  return <div className="page-stack">
    <div className="page-heading"><div><span className="eyebrow">INSIGHTS</span><h1>Report</h1><p>Review registrations and investigate potential duplicate MS-key matches.</p></div></div>
    {error && <div className="form-error">{error}</div>}
    <div className="stats-grid three-cols"><div className="surface stat-card"><div className="stat-icon tint-blue">▦</div><div><span>Matching requests</span><strong>{pagination.total}</strong></div></div><div className="surface stat-card"><div className="stat-icon tint-amber">⚠</div><div><span>Duplicates on page</span><strong>{duplicateCount}</strong></div></div><div className="surface stat-card"><div className="stat-icon tint-green">✓</div><div><span>Approved on page</span><strong>{approvedCount}</strong></div></div></div>
    <form className="report-filters surface" onSubmit={apply}>
      <label>Status<select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">All statuses</option><option>PENDING_ENGINEER</option><option>NEEDS_EMPLOYEE_CORRECTION</option><option>PENDING_ADMIN</option><option>NEEDS_ENGINEER_CORRECTION</option><option>APPROVED</option></select></label>
      <label>Employee SAP ID<input value={filters.sapId} onChange={(e) => setFilters({ ...filters, sapId: e.target.value.toUpperCase().slice(0, 8) })} minLength={filters.sapId ? 8 : undefined} maxLength={8} /></label>
      <label>From<input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
      <label>To<input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
      <label>License key<select value={filters.duplicateOnly} onChange={(e) => setFilters({ ...filters, duplicateOnly: e.target.value })}><option value="">All</option><option value="true">Duplicates only</option><option value="false">No filter</option></select></label>
      <button className="button button-primary">Apply filters</button>
    </form>
    <div className="surface table-surface"><div className="table-toolbar"><div><strong>Registration activity</strong><span>Duplicate matches are warnings for investigation, not proof of misuse.</span></div><div className="report-toolbar-actions"><span className="report-period">{pagination.total} RECORDS</span>{user.role === 'admin' && <button className="button button-primary button-small" type="button" disabled={exporting} onClick={downloadExcel}>{exporting ? 'Preparing…' : 'Download Excel'}</button>}</div></div>
      {loading ? <p className="table-message">Loading reports…</p> : reports.length ? <div className="table-scroll"><table><thead><tr><th>SERIAL NUMBER</th><th>EMPLOYEE</th><th>DEVICE</th><th>STATUS</th><th>MS KEY CHECK</th></tr></thead><tbody>{reports.map((r) => <tr key={r.id}><td className="mono-cell">{r.serialNumber}</td><td><strong>{r.employeeName}</strong><small className="table-subline">{r.employeeSapId}</small><small className="table-subline">{r.department || '—'}</small></td><td><strong>{r.modelNumber}</strong></td><td><StatusBadge status={r.status} /></td><td className="report-key-check">{r.windowsKeyPresent && <span>Windows: {r.windowsKeyDuplicateWarning ? <span className="warning-badge">Duplicate</span> : <span className="clear-badge">No match</span>}</span>}{r.officeKeyPresent && <span>MS Office: {r.officeKeyDuplicateWarning ? <span className="warning-badge">Duplicate</span> : <span className="clear-badge">No match</span>}</span>}{r.legacyKeyPresent && <span className="legacy-key-label">Legacy key</span>}{!r.windowsKeyPresent && !r.officeKeyPresent && !r.legacyKeyPresent && <span>—</span>}</td></tr>)}</tbody></table></div> : <EmptyState title="No report data" detail="No registrations match these filters." />}
      <div className="pagination-row"><span>{pagination.total ? `${pagination.offset + 1}–${Math.min(pagination.offset + pagination.limit, pagination.total)} of ${pagination.total}` : '0 records'}</span><div><button className="button button-quiet button-small" disabled={!pagination.offset || loading} onClick={() => refresh(Math.max(0, pagination.offset - pagination.limit))}>Previous</button><button className="button button-quiet button-small" disabled={pagination.offset + pagination.limit >= pagination.total || loading} onClick={() => refresh(pagination.offset + pagination.limit)}>Next</button></div></div>
    </div>
  </div>
}
