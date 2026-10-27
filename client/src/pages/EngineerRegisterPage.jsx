import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { laptopApi } from '../services/laptopApi.js'
import { normalizeEmail } from '../utils/email.js'
import { normalizeLicenseKey } from '../utils/licenseKey.js'
import { normalizeMacAddress } from '../utils/macAddress.js'

const emptyForm = { serialNumber: '', purchaseDate: '', modelNumber: '', macAddress: '', operatingSystem: 'Windows', windowsKey: '', officeKey: '', msOfficeAccountEmail: '', invoice: null }

export default function EngineerRegisterPage() {
  const navigate = useNavigate()
  const [sapId, setSapId] = useState('')
  const [employee, setEmployee] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [fieldErrors, setFieldErrors] = useState({})

  async function search(event) {
    event.preventDefault(); setError(''); setNotice(''); setEmployee(null)
    try { setEmployee(await laptopApi.searchEmployeeBySapId(sapId.trim())) }
    catch (searchError) { setError(searchError.message) }
  }

  async function submit(event) {
    event.preventDefault(); setError(''); setNotice(''); setFieldErrors({})
    if (!normalizeMacAddress(form.macAddress)) { setError('Enter a valid MAC address.'); return }
    if (form.windowsKey && normalizeLicenseKey(form.windowsKey) === null) { setError('Invalid Windows key.'); return }
    if (form.officeKey && normalizeLicenseKey(form.officeKey) === null) { setError('Invalid MS Office key.'); return }
    const email = normalizeEmail(form.msOfficeAccountEmail)
    if (email === false) { setError('Enter a valid MS Office account email.'); return }
    if (form.officeKey && !email) { setError('MS Office account email is required when an MS Office key is entered.'); return }
    setBusy(true)
    try {
      await laptopApi.registerLaptopOnBehalf(employee.sapId, form)
      setNotice('Laptop request registered and sent to Engineer review. You cannot approve a request you registered.')
      setForm(emptyForm)
      window.setTimeout(() => navigate('/engineer'), 900)
    } catch (submitError) {
      setFieldErrors(submitError.fieldErrors ?? {})
      setError(Object.keys(submitError.fieldErrors ?? {}).length ? '' : submitError.message)
    }
    finally { setBusy(false) }
  }

  return <div className="page-stack">
    <section className="surface form-card">
      <div className="section-heading"><div><span className="eyebrow">EMPLOYEE DEVICE REGISTRATION</span><h2>Register on behalf</h2></div></div>
      <form className="search-form" onSubmit={search}>
        <label>Employee SAP ID<input value={sapId} maxLength={8} onChange={(event) => setSapId(event.target.value)} required /></label>
        <button className="button button-primary">Search employee</button>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="inline-success" role="status">{notice}</div>}
      {employee && <>
        <div className="notice-banner"><span>✓</span> {employee.employeeName} · {employee.sapId} · {employee.designation} · {employee.department}</div>
        <form className="form-grid" autoComplete="off" onSubmit={submit}>
          <label>Serial number<input value={form.serialNumber} onChange={(event) => { setForm({ ...form, serialNumber: event.target.value }); setFieldErrors((current) => ({ ...current, serialNumber: '' })) }} required />{fieldErrors.serialNumber && <span className="field-error" role="alert">{fieldErrors.serialNumber}</span>}</label>
          <label>Purchase date<input type="date" value={form.purchaseDate} onChange={(event) => setForm({ ...form, purchaseDate: event.target.value })} required /></label>
          <label>Model number<input value={form.modelNumber} onChange={(event) => setForm({ ...form, modelNumber: event.target.value })} required /></label>
          <label>MAC address<input autoComplete="off" value={form.macAddress} onChange={(event) => { setForm({ ...form, macAddress: event.target.value }); setFieldErrors((current) => ({ ...current, macAddress: '' })) }} required />{fieldErrors.macAddress && <span className="field-error" role="alert">{fieldErrors.macAddress}</span>}</label>
          <label>Operating system<select value={form.operatingSystem} onChange={(event) => setForm({ ...form, operatingSystem: event.target.value, ...(event.target.value === 'macOS' ? { windowsKey: '' } : {}) })}><option>Windows</option><option>macOS</option></select></label>
          <label>Windows key <span className="optional-label">Optional</span><input type="password" autoComplete="off" disabled={form.operatingSystem === 'macOS'} value={form.windowsKey} onChange={(event) => setForm({ ...form, windowsKey: event.target.value })} /></label>
          <label>MS Office key <span className="optional-label">Optional</span><input type="password" autoComplete="off" value={form.officeKey} onChange={(event) => setForm({ ...form, officeKey: event.target.value })} /></label>
          <label>MS Office account email <span className="optional-label">Required with MS Office key</span><input type="email" autoComplete="off" value={form.msOfficeAccountEmail} onChange={(event) => setForm({ ...form, msOfficeAccountEmail: event.target.value })} /></label>
          <label className="span-2">Purchase invoice<input className="file-input" type="file" accept=".pdf,image/*" onChange={(event) => setForm({ ...form, invoice: event.target.files?.[0] ?? null })} required /></label>
          <div className="form-actions span-2"><button className="button button-primary" disabled={busy}>{busy ? 'Registering…' : 'Register laptop'}</button></div>
        </form>
      </>}
    </section>
  </div>
}
