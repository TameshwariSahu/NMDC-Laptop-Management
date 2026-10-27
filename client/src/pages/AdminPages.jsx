import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import { laptopApi } from '../services/laptopApi.js'
import { employeeCategoryLabel } from '../utils/employeeCategory.js'

const initialAccount = { sapId: '', email: '', role: 'employee', employeeName: '', designation: '', employeeCategory: 'Executive', department: '' }

export function AccountsPage() {
  const { user } = useAuth()
  const [rows, setRows] = useState([])
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [pagination, setPagination] = useState({ limit: 25, offset: 0, total: 0 })
  const [form, setForm] = useState(initialAccount)
  const [profileTarget, setProfileTarget] = useState(null)
  const [profileForm, setProfileForm] = useState({ employeeName: '', designation: '', employeeCategory: 'Executive', department: '' })
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  async function refresh(offset = 0, search = activeQuery) {
    setLoading(true); setError('')
    try {
      const result = await laptopApi.listAccounts({ q: search, limit: pagination.limit, offset })
      setRows(result.accounts); setPagination(result.pagination)
    }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh(0, '') }, [])
  async function create(event) {
    event.preventDefault(); setError(''); setNotice('')
    try {
      const account = await laptopApi.createAccount(form)
      setRows((current) => [account, ...current.filter((row) => row.userId !== account.userId)])
      setQuery(''); setActiveQuery('')
      setForm(initialAccount); setShowForm(false); setNotice('Account created and audited.')
      await refresh(0, '')
    } catch (e) { setError(e.message) }
  }
  async function toggleActive(account) {
    setError(''); setNotice('')
    try { await laptopApi.updateAccount(account.userId, { isActive: !account.isActive }); setNotice('Account status updated and audited.'); await refresh(pagination.offset, activeQuery) }
    catch (e) { setError(e.message); await refresh(pagination.offset, activeQuery) }
  }
  async function saveProfile(event) {
    event.preventDefault(); setError(''); setNotice('')
    try {
      const account = await laptopApi.updateAccountProfile(profileTarget.userId, profileForm)
      setNotice('Account profile saved and audited.')
      setProfileTarget(null)
      await refresh(pagination.offset, activeQuery)
      setRows((current) => current.map((row) => row.userId === account.userId ? { ...row, ...account } : row))
    } catch (e) { setError(e.message) }
  }
  return <div className="page-stack">
    <div className="page-heading"><div><span className="eyebrow">ADMINISTRATION</span><h1>Account directory</h1><p>Review and manage employee, engineer, and admin accounts.</p></div><button className="button button-primary" onClick={() => setShowForm((value) => !value)}>＋ {showForm ? 'Close' : 'Add account'}</button></div>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="inline-success">{notice}</div>}
    {showForm && <section className="surface form-card"><h2>Create account</h2><form className="form-grid" autoComplete="off" onSubmit={create}>
      <label>SAP ID<input autoComplete="off" required minLength="8" maxLength="8" value={form.sapId} onChange={(e) => setForm({ ...form, sapId: e.target.value.toUpperCase().slice(0, 8) })} /></label>
      <label>Official email<input autoComplete="off" required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
      <label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="employee">Employee</option><option value="engineer">Engineer</option><option value="admin">Admin</option></select></label>
      <label>Name<input autoComplete="off" name="new-account-name" required value={form.employeeName} onChange={(e) => setForm({ ...form, employeeName: e.target.value })} /></label>
      <label>Designation<input autoComplete="off" name="new-account-designation" required value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></label>
      <label>Category<select value={form.employeeCategory} onChange={(e) => setForm({ ...form, employeeCategory: e.target.value })}><option value="Workman">Workman</option><option value="Executive">Executive</option><option value="JO">JO (Junior Officer)</option></select></label>
      <label>Department<input autoComplete="off" name="new-account-department" required value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></label>
      <div className="form-actions span-2"><button className="button button-primary">Create account</button></div>
    </form></section>}
    {profileTarget && <section className="surface form-card"><div className="section-heading"><h2>Edit profile · {profileTarget.sapId}</h2><button type="button" className="button button-quiet" onClick={() => setProfileTarget(null)}>Close</button></div><form className="form-grid" autoComplete="off" onSubmit={saveProfile}>
      <label>Name<input autoComplete="off" required value={profileForm.employeeName} onChange={(e) => setProfileForm({ ...profileForm, employeeName: e.target.value })} /></label>
      <label>Designation<input autoComplete="off" required value={profileForm.designation} onChange={(e) => setProfileForm({ ...profileForm, designation: e.target.value })} /></label>
      <label>Category<select value={profileForm.employeeCategory} onChange={(e) => setProfileForm({ ...profileForm, employeeCategory: e.target.value })}><option value="Workman">Workman</option><option value="Executive">Executive</option><option value="JO">JO (Junior Officer)</option></select></label>
      <label>Department<input autoComplete="off" required value={profileForm.department} onChange={(e) => setProfileForm({ ...profileForm, department: e.target.value })} /></label>
      <div className="form-actions span-2"><button className="button button-primary">Save profile</button></div>
    </form></section>}
    <div className="surface table-surface"><div className="table-toolbar"><div><strong>Organization accounts</strong><span>Roles are set when an account is created. Activation changes are recorded in the audit log.</span></div><span className="count-pill">{pagination.total} accounts</span></div>
      <form className="account-search" onSubmit={(e) => { e.preventDefault(); const search = query.trim(); setActiveQuery(search); refresh(0, search) }}><input aria-label="Search accounts" placeholder="Search SAP ID, email, or employee name" value={query} onChange={(e) => setQuery(e.target.value)} /><button className="button button-quiet">Search</button></form>
      <div className="table-scroll"><table><thead><tr><th>PERSON</th><th>SAP ID</th><th>ROLE</th><th>DEPARTMENT</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody>{rows.map((account) => <tr key={account.userId}><td><div className="table-person"><div className="avatar small-avatar">{(account.employeeName || account.sapId).split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><div><strong>{account.employeeName || account.sapId}</strong>{account.employeeCategory && <small className="table-subline">{employeeCategoryLabel(account.employeeCategory)}</small>}</div></div></td><td className="mono-cell">{account.sapId}</td><td><span className={`role-pill role-${account.role}`}>{account.role}</span></td><td>{account.department || '—'}</td><td><span className={account.isActive ? 'active-status' : 'inactive-status'}><i />{account.isActive ? 'Active' : 'Deactivated'}</span></td><td><button className="button button-quiet button-small" onClick={() => { setProfileTarget(account); setProfileForm({ employeeName: account.employeeName ?? '', designation: account.designation ?? '', employeeCategory: account.employeeCategory ?? 'Executive', department: account.department ?? '' }) }}>Edit profile</button> <button className="button button-quiet button-small" disabled={account.userId === user.userId} onClick={() => toggleActive(account)}>{account.isActive ? 'Deactivate' : 'Activate'}</button></td></tr>)}</tbody></table></div>
      {loading && <p className="table-message">Loading accounts…</p>}{!loading && !rows.length && <p className="table-message">No accounts found.</p>}
      <div className="pagination-row"><span>{pagination.total ? `${pagination.offset + 1}–${Math.min(pagination.offset + pagination.limit, pagination.total)} of ${pagination.total}` : '0 accounts'}</span><div><button className="button button-quiet button-small" disabled={!pagination.offset || loading} onClick={() => refresh(Math.max(0, pagination.offset - pagination.limit), activeQuery)}>Previous</button><button className="button button-quiet button-small" disabled={pagination.offset + pagination.limit >= pagination.total || loading} onClick={() => refresh(pagination.offset + pagination.limit, activeQuery)}>Next</button></div></div>
    </div>
  </div>
}

export function ClearancePage() {
  const [sapId, setSapId] = useState('')
  const [searchedSapId, setSearchedSapId] = useState('')
  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)
  async function search(event) {
    event?.preventDefault(); setError(''); setNotice(''); setSelected(null); setResults([]); setSearchedSapId('')
    const searchedId = sapId.trim()
    try {
      const rows = await laptopApi.searchClearance(searchedId)
      setResults(rows); setSelected(rows[0] ?? null); setReason(rows[0]?.reason ?? ''); setSearchedSapId(searchedId)
    } catch (e) { setError(e.message) }
  }
  async function startClearance() {
    setBusy(true); setError('')
    try { await laptopApi.createClearance(sapId, reason); setNotice('Clearance checklist created.'); await search() }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  async function toggle(check, complete) {
    setError('')
    try {
      await laptopApi.updateClearanceCheck(selected.clearanceId, check.checkId, { isComplete: complete, remarks: check.remarks ?? '' })
      await search()
    } catch (e) { setError(e.message) }
  }
  async function finalize() {
    setBusy(true); setError('')
    try { await laptopApi.finalizeClearance(selected.clearanceId, remarks, selected.reason || reason); setRemarks(''); setNotice('Clearance recorded.'); await search() }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const allMandatoryComplete = Boolean(selected?.checks?.some((c) => c.isMandatory) && selected.checks.filter((c) => c.isMandatory).every((c) => c.isComplete))
  return <div className="page-stack">
    <div className="page-heading"><div><span className="eyebrow">EMPLOYEE SERVICES</span><h1>No-dues clearance</h1><p>Search by SAP ID and complete the required no-dues checks.</p></div></div>
    <section className="surface clearance-search"><div className="section-heading"><div><span className="eyebrow">NO-DUES CHECK</span><h2>Find an employee</h2></div><div className="clearance-icon">✓</div></div><form className="search-form" onSubmit={search}><label>SAP ID<input value={sapId} onChange={(event) => { setSapId(event.target.value.toUpperCase().slice(0, 8)); setSearchedSapId(''); setSelected(null); setResults([]); setReason('') }} placeholder="8 characters" required minLength={8} maxLength={8} /></label><button className="button button-primary">Search <span>→</span></button></form>{error && <div className="form-error">{error}</div>}{notice && <div className="inline-success">{notice}</div>}</section>
    {results.length > 1 && <label className="clearance-history">Clearance record<select value={selected?.clearanceId ?? ''} onChange={(e) => { const row = results.find((r) => r.clearanceId === e.target.value); setSelected(row); setReason(row?.reason ?? '') }}>{results.map((r) => <option key={r.clearanceId} value={r.clearanceId}>{r.status} · {new Date(r.createdAt).toLocaleDateString()}</option>)}</select></label>}
    {selected && <section className="surface clearance-result"><div className="result-person"><div className="avatar large-avatar">{selected.employeeName.split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><div><span className="eyebrow">EMPLOYEE RECORD</span><h2>{selected.employeeName}</h2><span>{selected.sapId} · {selected.department}</span></div><span className={selected.status === 'CLEARED' ? 'clearance-cleared' : 'clearance-blocked'}>{selected.status === 'CLEARED' ? 'Cleared' : 'Pending'}</span></div>
      <div className="clearance-reason"><strong>Reason</strong>{selected.reason ? <span>{selected.reason}</span> : selected.status === 'CLEARED' ? <span>Not recorded (legacy)</span> : <label><select value={reason} onChange={(e) => setReason(e.target.value)} required><option value="">Choose a reason</option><option>Retirement</option><option>Transfer</option><option>Resignation</option></select></label>}</div>
      <div className="clearance-checks">{selected.checks.map((check) => <label key={check.checkId} className="check-row"><input type="checkbox" checked={check.isComplete} disabled={selected.status === 'CLEARED'} onChange={(e) => toggle(check, e.target.checked)} /><span><strong>{check.checkLabel}{check.isMandatory ? ' · Required' : ' · Optional'}</strong><small>{check.remarks || check.checkKey}{check.checkedBySapId ? ` · Completed by ${check.checkedBySapId}` : ''}</small></span><em>{check.isComplete ? 'Complete' : 'Incomplete'}</em></label>)}</div>
      {selected.status !== 'CLEARED' && <>
        <div className="clearance-footer"><label>Officer remarks<input value={remarks} onChange={(e) => setRemarks(e.target.value)} required placeholder="Record clearance remarks" /></label><button className="button button-primary" disabled={!allMandatoryComplete || !remarks.trim() || !(selected.reason || reason) || busy} onClick={finalize}>Record clearance</button></div>
      </>}
      {selected.status === 'CLEARED' && <div className="clearance-footer"><span>Cleared by {selected.officerSapId || 'officer'} · {selected.clearedAt ? new Date(selected.clearedAt).toLocaleString() : ''}</span></div>}
    </section>}
    {searchedSapId && searchedSapId === sapId && !results.length && !error && <section className="surface clearance-result"><p>No clearance record exists for this SAP ID yet.</p><label className="clearance-reason">Reason<select value={reason} onChange={(e) => setReason(e.target.value)} required><option value="">Choose a reason</option><option>Retirement</option><option>Transfer</option><option>Resignation</option></select></label><button className="button button-primary" disabled={!reason || busy} onClick={startClearance}>Start clearance checklist</button></section>}
  </div>
}
