import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import { laptopApi } from '../services/laptopApi.js'

const initialAccount = { sapId: '', email: '', role: 'employee', employeeName: '', designation: '', employeeCategory: 'Executive', department: '' }

export function AccountsPage() {
  const { user } = useAuth()
  const [rows, setRows] = useState([])
  const [query, setQuery] = useState('')
  const [form, setForm] = useState(initialAccount)
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  async function refresh(search = query) {
    setLoading(true)
    try { setRows(await laptopApi.listAccounts({ q: search })) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh('') }, [])
  async function create(event) {
    event.preventDefault(); setError(''); setNotice('')
    try {
      const account = await laptopApi.createAccount(form)
      setRows((current) => [account, ...current.filter((row) => row.userId !== account.userId)])
      setQuery('')
      setForm(initialAccount); setShowForm(false); setNotice('Account created and audited.')
      await refresh('')
    } catch (e) { setError(e.message) }
  }
  async function toggleActive(account) {
    setError(''); setNotice('')
    try { await laptopApi.updateAccount(account.userId, { isActive: !account.isActive }); setNotice('Account status updated and audited.'); await refresh() }
    catch (e) { setError(e.message); await refresh() }
  }
  return <div className="page-stack">
    <div className="page-heading"><div><span className="eyebrow">ADMINISTRATION</span><h1>Account directory</h1><p>Review and manage employee, engineer, and admin accounts.</p></div><button className="button button-primary" onClick={() => setShowForm((value) => !value)}>＋ {showForm ? 'Close' : 'Add account'}</button></div>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="inline-success">{notice}</div>}
    {showForm && <section className="surface form-card"><h2>Create account</h2><form className="form-grid" autoComplete="off" onSubmit={create}>
      <label>SAP ID<input autoComplete="off" required minLength="8" maxLength="8" value={form.sapId} onChange={(e) => setForm({ ...form, sapId: e.target.value.toUpperCase().slice(0, 8) })} /></label>
      <label>Official email<input autoComplete="off" required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
      <label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="employee">Employee</option><option value="engineer">Engineer</option><option value="admin">Admin</option></select></label>
      {form.role === 'employee' && <>
        <label>Name<input autoComplete="off" name="new-account-name" required value={form.employeeName} onChange={(e) => setForm({ ...form, employeeName: e.target.value })} /></label>
        <label>Designation<input autoComplete="off" name="new-account-designation" required value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></label>
        <label>Category<select value={form.employeeCategory} onChange={(e) => setForm({ ...form, employeeCategory: e.target.value })}><option>Workman</option><option>Executive</option></select></label>
        <label>Department<input autoComplete="off" name="new-account-department" required value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></label>
      </>}
      <div className="form-actions span-2"><button className="button button-primary">Create account</button></div>
    </form></section>}
    <div className="surface table-surface"><div className="table-toolbar"><div><strong>Organization accounts</strong><span>Roles are set when an account is created. Activation changes are recorded in the audit log.</span></div><span className="count-pill">{rows.length} accounts</span></div>
      <form className="account-search" onSubmit={(e) => { e.preventDefault(); refresh() }}><input aria-label="Search accounts" placeholder="Search SAP ID, email, or employee name" value={query} onChange={(e) => setQuery(e.target.value)} /><button className="button button-quiet">Search</button></form>
      <div className="table-scroll"><table><thead><tr><th>PERSON</th><th>SAP ID</th><th>ROLE</th><th>DEPARTMENT</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody>{rows.map((account) => <tr key={account.userId}><td><div className="table-person"><div className="avatar small-avatar">{(account.employeeName || account.sapId).split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><strong>{account.employeeName || account.sapId}</strong></div></td><td className="mono-cell">{account.sapId}</td><td><span className={`role-pill role-${account.role}`}>{account.role}</span></td><td>{account.department || '—'}</td><td><span className={account.isActive ? 'active-status' : 'inactive-status'}><i />{account.isActive ? 'Active' : 'Deactivated'}</span></td><td><button className="button button-quiet button-small" disabled={account.userId === user.userId} onClick={() => toggleActive(account)}>{account.isActive ? 'Deactivate' : 'Activate'}</button></td></tr>)}</tbody></table></div>
      {loading && <p className="table-message">Loading accounts…</p>}{!loading && !rows.length && <p className="table-message">No accounts found.</p>}
    </div>
  </div>
}

export function ClearancePage() {
  const [sapId, setSapId] = useState('')
  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [remarks, setRemarks] = useState('')
  const [newCheck, setNewCheck] = useState({ checkKey: '', checkLabel: '', isMandatory: true })
  const [busy, setBusy] = useState(false)
  async function search(event) {
    event?.preventDefault(); setError(''); setNotice(''); setSelected(null); setResults([])
    try { const rows = await laptopApi.searchClearance(sapId); setResults(rows); setSelected(rows[0] ?? null) }
    catch (e) { setError(e.message) }
  }
  async function startClearance() {
    setBusy(true); setError('')
    try { await laptopApi.createClearance(sapId); setNotice('Clearance checklist created.'); await search() }
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
  async function addCheck(event) {
    event.preventDefault(); setError('')
    try { await laptopApi.addClearanceCheck(selected.clearanceId, newCheck); setNewCheck({ checkKey: '', checkLabel: '', isMandatory: true }); await search() }
    catch (e) { setError(e.message) }
  }
  async function finalize() {
    setBusy(true); setError('')
    try { await laptopApi.finalizeClearance(selected.clearanceId, remarks); setRemarks(''); setNotice('Clearance recorded.'); await search() }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const allMandatoryComplete = Boolean(selected?.checks?.some((c) => c.isMandatory) && selected.checks.filter((c) => c.isMandatory).every((c) => c.isComplete))
  return <div className="page-stack">
    <div className="page-heading"><div><span className="eyebrow">EMPLOYEE SERVICES</span><h1>Retirement clearance</h1><p>Search by SAP ID and complete the required no-dues checks.</p></div></div>
    <section className="surface clearance-search"><div className="section-heading"><div><span className="eyebrow">NO-DUES CHECK</span><h2>Find an employee</h2></div><div className="clearance-icon">✓</div></div><form className="search-form" onSubmit={search}><label>SAP ID<input value={sapId} onChange={(event) => setSapId(event.target.value.toUpperCase().slice(0, 8))} placeholder="8 characters" required minLength={8} maxLength={8} /></label><button className="button button-primary">Search <span>→</span></button></form>{error && <div className="form-error">{error}</div>}{notice && <div className="inline-success">{notice}</div>}</section>
    {results.length > 1 && <label className="clearance-history">Clearance record<select value={selected?.clearanceId ?? ''} onChange={(e) => setSelected(results.find((r) => r.clearanceId === e.target.value))}>{results.map((r) => <option key={r.clearanceId} value={r.clearanceId}>{r.status} · {new Date(r.createdAt).toLocaleDateString()}</option>)}</select></label>}
    {selected && <section className="surface clearance-result"><div className="result-person"><div className="avatar large-avatar">{selected.employeeName.split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><div><span className="eyebrow">EMPLOYEE RECORD</span><h2>{selected.employeeName}</h2><span>{selected.sapId} · {selected.department}</span></div><span className={selected.status === 'CLEARED' ? 'clearance-cleared' : 'clearance-blocked'}>{selected.status}</span></div>
      <div className="clearance-checks">{selected.checks.map((check) => <label key={check.checkId} className="check-row"><input type="checkbox" checked={check.isComplete} disabled={selected.status === 'CLEARED'} onChange={(e) => toggle(check, e.target.checked)} /><span><strong>{check.checkLabel}{check.isMandatory ? ' · Required' : ' · Optional'}</strong><small>{check.remarks || check.checkKey}{check.checkedBySapId ? ` · Completed by ${check.checkedBySapId}` : ''}</small></span><em>{check.isComplete ? 'Complete' : 'Incomplete'}</em></label>)}</div>
      {selected.status !== 'CLEARED' && <>
        <form className="add-check-form" onSubmit={addCheck}><input required placeholder="Check key" value={newCheck.checkKey} onChange={(e) => setNewCheck({ ...newCheck, checkKey: e.target.value })} /><input required placeholder="Additional clearance check" value={newCheck.checkLabel} onChange={(e) => setNewCheck({ ...newCheck, checkLabel: e.target.value })} /><label><input type="checkbox" checked={newCheck.isMandatory} onChange={(e) => setNewCheck({ ...newCheck, isMandatory: e.target.checked })} /> Mandatory</label><button className="button button-quiet">Add check</button></form>
        <div className="clearance-footer"><label>Officer remarks<input value={remarks} onChange={(e) => setRemarks(e.target.value)} required placeholder="Record clearance remarks" /></label><button className="button button-primary" disabled={!allMandatoryComplete || !remarks.trim() || busy} onClick={finalize}>Record clearance</button></div>
      </>}
      {selected.status === 'CLEARED' && <div className="clearance-footer"><span>Cleared by {selected.officerSapId || 'officer'} · {selected.clearedAt ? new Date(selected.clearedAt).toLocaleString() : ''}</span></div>}
    </section>}
    {sapId && !results.length && !error && <section className="surface clearance-result"><p>No clearance record exists for this SAP ID yet.</p><button className="button button-primary" disabled={busy} onClick={startClearance}>Start clearance checklist</button></section>}
  </div>
}
