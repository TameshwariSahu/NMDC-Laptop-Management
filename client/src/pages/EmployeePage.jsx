import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import EmptyState from '../components/EmptyState.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { laptopApi } from '../services/laptopApi.js'
import { formatPurchaseDate } from '../utils/formatDate.js'
import { normalizeMacAddress } from '../utils/macAddress.js'
import { normalizeLicenseKey } from '../utils/licenseKey.js'
import { normalizeEmail } from '../utils/email.js'

const blankForm = { serialNumber: '', purchaseDate: '', modelNumber: '', macAddress: '', operatingSystem: 'Windows', windowsKey: '', officeKey: '', msOfficeAccountEmail: '', clearWindowsKey: false, clearOfficeKey: false, invoice: null }
const correctionStatuses = ['NEEDS_EMPLOYEE_CORRECTION', 'NEEDS_ENGINEER_CORRECTION']

export default function EmployeePage() {
  const { user } = useAuth()
  const [requests, setRequests] = useState([])
  const [form, setForm] = useState(blankForm)
  const [editingId, setEditingId] = useState(null)
  const [editingRequest, setEditingRequest] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [macError, setMacError] = useState('')
  const [keyErrors, setKeyErrors] = useState({ windowsKey: '', officeKey: '' })
  const [officeEmailError, setOfficeEmailError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try { setRequests(await laptopApi.listRequests(user)) }
    catch (loadError) { setError(loadError.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [user.sapId])

  function setField(name, value) {
    setForm((current) => ({ ...current, [name]: value }))
    setFieldErrors((current) => ({ ...current, [name]: '' }))
  }
  function setLicenseField(name, value) {
    setField(name, value)
    setKeyErrors((current) => ({ ...current, [name]: value && normalizeLicenseKey(value) === null ? `Invalid ${name === 'officeKey' ? 'MS Office' : 'Windows'} key.` : '' }))
  }
  function startCorrection(request) {
    setEditingId(request.id)
    setEditingRequest(request)
    setForm({ ...blankForm, serialNumber: request.serialNumber, purchaseDate: String(request.purchaseDate).slice(0, 10), modelNumber: request.modelNumber, macAddress: normalizeMacAddress(request.macAddress) ?? '', operatingSystem: request.operatingSystem, msOfficeAccountEmail: request.msOfficeAccountEmail ?? '' })
    setError(''); setNotice('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  async function submit(event) {
    event.preventDefault(); setError(''); setNotice(''); setFieldErrors({})
    if (!normalizeMacAddress(form.macAddress)) {
      setMacError('Enter a valid MAC address.')
      return
    }
    setMacError('')
    const nextKeyErrors = {
      windowsKey: form.windowsKey && normalizeLicenseKey(form.windowsKey) === null ? 'Invalid Windows key.' : '',
      officeKey: form.officeKey && normalizeLicenseKey(form.officeKey) === null ? 'Invalid MS Office key.' : '',
    }
    setKeyErrors(nextKeyErrors)
    if (nextKeyErrors.windowsKey || nextKeyErrors.officeKey) return
    const normalizedOfficeEmail = normalizeEmail(form.msOfficeAccountEmail)
    if (normalizedOfficeEmail === false || (form.officeKey && !normalizedOfficeEmail)) {
      setOfficeEmailError(normalizedOfficeEmail === false ? 'Enter a valid MS Office account email.' : 'MS Office account email is required when an MS Office key is entered.')
      return
    }
    setOfficeEmailError('')
    if (editingId && editingRequest?.needsInvoiceReplacement && !form.invoice) {
      setError('Attach a replacement invoice before resubmitting this request.')
      return
    }
    try {
      await laptopApi.saveRequest(user, form, editingId, editingRequest)
      setForm(blankForm); setEditingId(null); setEditingRequest(null); setNotice(editingId ? 'Your correction has been sent back to the Engineer queue.' : 'Laptop request submitted to the Engineer queue.')
      await refresh()
    } catch (submitError) {
      setFieldErrors(submitError.fieldErrors ?? {})
      setError(Object.keys(submitError.fieldErrors ?? {}).length ? '' : submitError.message)
    }
  }

  return (
    <div className="page-stack">
      <div className="stats-grid three-cols">
        <Stat label="Total requests" value={requests.length} icon="▦" tint="blue" />
        <Stat label="In review" value={requests.filter((request) => ['PENDING_ENGINEER', 'PENDING_ADMIN'].includes(request.status)).length} icon="◷" tint="amber" />
        <Stat label="Approved" value={requests.filter((request) => request.status === 'APPROVED').length} icon="✓" tint="green" />
      </div>
      <div className="content-grid employee-grid">
        <section className="surface form-card">
          <div className="section-heading"><div><span className="eyebrow">DEVICE DETAILS</span><h2>{editingId ? 'Update returned request' : 'Laptop request'}</h2></div><span className="step-count">{editingId ? 'CORRECTION' : 'STEP 1 OF 1'}</span></div>
          {editingId && <div className="notice-banner"><span>↻</span> Returned request for correction</div>}
          {editingRequest?.legacyKeyPresent && <div className="legacy-key-label">Legacy key</div>}
          {editingRequest?.needsInvoiceReplacement && <div className="invoice-replacement-notice">The current invoice needs replacement. Attach a new invoice to resubmit.</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          {notice && <div className="inline-success" role="status">{notice}</div>}
          <form className="form-grid" autoComplete="off" onSubmit={submit}>
            <label className="span-2">Serial number<input value={form.serialNumber} onChange={(event) => setField('serialNumber', event.target.value)} required placeholder="e.g. PF4X9L2" />{fieldErrors.serialNumber && <span className="field-error" role="alert">{fieldErrors.serialNumber}</span>}</label>
            <label>Purchase date<input type="date" value={form.purchaseDate} onChange={(event) => setField('purchaseDate', event.target.value)} required /></label>
            <label>Model number<input value={form.modelNumber} onChange={(event) => setField('modelNumber', event.target.value)} required placeholder="e.g. ThinkPad T14" /></label>
            <label className="span-2">MAC address<input type="text" autoComplete="new-password" autoCapitalize="characters" autoCorrect="off" spellCheck="false" name={`device-mac-${user.sapId}`} value={form.macAddress} onFocus={(event) => { if (!normalizeMacAddress(event.currentTarget.value) && !normalizeMacAddress(form.macAddress)) { event.currentTarget.value = ''; setField('macAddress', ''); setMacError('') } }} onChange={(event) => { setField('macAddress', event.target.value); setMacError(event.target.value && !normalizeMacAddress(event.target.value) ? 'Enter a valid MAC address.' : '') }} required />{fieldErrors.macAddress && <span className="field-error" role="alert">{fieldErrors.macAddress}</span>}</label>
            {macError && <p className="field-error span-2" role="alert">{macError}</p>}
            <label>Operating system<select value={form.operatingSystem} onChange={(event) => { setField('operatingSystem', event.target.value); if (event.target.value === 'macOS') { setField('windowsKey', ''); setKeyErrors((current) => ({ ...current, windowsKey: '' })) } }}><option>Windows</option><option>macOS</option></select></label>
            <label>Windows key <span className="optional-label">Optional</span><input type="password" autoComplete="off" disabled={form.operatingSystem === 'macOS'} value={form.windowsKey} onChange={(event) => setLicenseField('windowsKey', event.target.value)} placeholder={form.operatingSystem === 'macOS' ? 'Not used for macOS' : 'Enter only if assigned'} />{keyErrors.windowsKey && <span className="field-error" role="alert">{keyErrors.windowsKey}</span>}</label>
            <label>MS Office key <span className="optional-label">Optional</span><input type="password" autoComplete="off" value={form.officeKey} onChange={(event) => setLicenseField('officeKey', event.target.value)} placeholder="Enter only if assigned" />{keyErrors.officeKey && <span className="field-error" role="alert">{keyErrors.officeKey}</span>}</label>
            <label className="span-2">MS Office account email <span className="optional-label">Required with MS Office key</span><input type="email" autoComplete="off" value={form.msOfficeAccountEmail} onChange={(event) => { const value = event.target.value; setField('msOfficeAccountEmail', value); const normalized = normalizeEmail(value); setOfficeEmailError(normalized === false ? 'Enter a valid MS Office account email.' : '') }} />{officeEmailError && <span className="field-error" role="alert">{officeEmailError}</span>}</label>
            {editingRequest?.windowsKeyPresent && <label className="span-2 key-clear-option"><input type="checkbox" checked={form.clearWindowsKey} onChange={(event) => setField('clearWindowsKey', event.target.checked)} /> Clear the saved Windows key before changing this device to macOS. Save the removal first.</label>}
            {editingRequest?.officeKeyPresent && <label className="span-2 key-clear-option"><input type="checkbox" checked={form.clearOfficeKey} onChange={(event) => setField('clearOfficeKey', event.target.checked)} /> Remove the saved MS Office key</label>}
            <label className="span-2">Purchase invoice <span className="optional-label">PDF or image</span><input className="file-input" type="file" accept=".pdf,image/*" required={Boolean(editingRequest?.needsInvoiceReplacement)} onChange={(event) => setField('invoice', event.target.files?.[0] || null)} /></label>
            <div className="form-note span-2"><span>ⓘ</span> The invoice is stored privately. You can attach a replacement while correcting a returned request.</div>
            <div className="form-actions span-2">
              {editingId && <button type="button" className="button button-quiet" onClick={() => { setEditingId(null); setEditingRequest(null); setForm(blankForm); setError('') }}>Cancel</button>}
              <button className="button button-primary">{editingId ? 'Resubmit correction' : 'Submit laptop request'}<span>→</span></button>
            </div>
          </form>
        </section>
        <section className="requests-section">
          <div className="section-heading section-heading-loose"><div><span className="eyebrow">YOUR ACTIVITY</span><h2>My requests <span className="count-pill">{requests.length}</span></h2></div></div>
          <div className="request-list">
            {loading ? <p>Loading your requests…</p> : requests.length ? requests.map((request) => <RequestCard key={request.id} request={request} onCorrect={startCorrection} />) : <EmptyState title="No requests yet" detail="Your submitted laptop requests will appear here." />}
          </div>
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value, icon, tint }) {
  return <div className="surface stat-card"><div className={`stat-icon tint-${tint}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong></div><span className="stat-trend">↗</span></div>
}

function RequestCard({ request, onCorrect }) {
  const latestRemark = request.remarks.at(-1)
  return <article className="surface request-card">
    <div className="request-top"><div><span className="request-date">{formatPurchaseDate(request.purchaseDate)}</span></div><StatusBadge status={request.status} /></div>
    <h3>{request.modelNumber}</h3>
    <div className="request-meta"><span>Serial <b>{request.serialNumber}</b></span><span>{request.operatingSystem}</span></div>
    {request.legacyKeyPresent && <div className="legacy-key-label">Legacy key</div>}
    {request.duplicateKeyWarning && <div className="duplicate-inline">⚠ Duplicate MS-key match needs review</div>}
    {request.needsInvoiceReplacement && <div className="invoice-replacement-notice">Current invoice needs replacement before resubmission.</div>}
    {latestRemark && <div className="remark-box"><span>REVIEWER REMARK</span><p>“{latestRemark.text}”</p><small>{latestRemark.actor} · {latestRemark.date}</small></div>}
    {request.invoices?.map((invoice) => <button key={invoice.fileId} className="text-button" onClick={() => laptopApi.downloadInvoice(invoice.fileId, invoice.originalName)}>Download invoice: {invoice.originalName}</button>)}
    {correctionStatuses.includes(request.status) && <button className="button button-outline button-small" onClick={() => onCorrect(request)}>Edit and resubmit <span>→</span></button>}
  </article>
}
