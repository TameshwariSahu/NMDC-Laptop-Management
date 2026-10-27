import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import EmptyState from '../components/EmptyState.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { laptopApi } from '../services/laptopApi.js'
import { formatPurchaseDate } from '../utils/formatDate.js'
import { normalizeMacAddress } from '../utils/macAddress.js'
import { normalizeLicenseKey } from '../utils/licenseKey.js'
import { normalizeEmail } from '../utils/email.js'

export default function ReviewQueuePage({ mode }) {
  const { user } = useAuth()
  const engineerMode = mode === 'engineer'
  const [queueStatus, setQueueStatus] = useState(engineerMode ? 'PENDING_ENGINEER' : 'PENDING_ADMIN')
  const [allRequests, setAllRequests] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [remark, setRemark] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [editForm, setEditForm] = useState(null)
  const [keyErrors, setKeyErrors] = useState({ windowsKey: '', officeKey: '' })
  const [officeEmailError, setOfficeEmailError] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [pagination, setPagination] = useState({ limit: 25, offset: 0, total: 0 })

  async function refresh() {
    const result = await laptopApi.listReviewQueue(user, pagination.offset, pagination.limit, queueStatus)
    const items = result.requests
    setAllRequests(items)
    setPagination(result.pagination)
    const nextQueue = items.filter((item) => item.status === queueStatus)
    if (!nextQueue.some((item) => item.id === selectedId)) setSelectedId(nextQueue[0]?.id || null)
  }
  useEffect(() => { refresh() }, [user.sapId, queueStatus, pagination.offset])

  const queue = useMemo(() => allRequests.filter((item) => item.status === queueStatus), [allRequests, queueStatus])
  const selected = queue.find((item) => item.id === selectedId) || queue[0]
  const latestRemark = selected?.remarks.at(-1)
  useEffect(() => {
    if (selected) { setEditForm({ serialNumber: selected.serialNumber, purchaseDate: String(selected.purchaseDate).slice(0, 10), modelNumber: selected.modelNumber, macAddress: selected.macAddress, operatingSystem: selected.operatingSystem, windowsKey: '', officeKey: '', msOfficeAccountEmail: selected.msOfficeAccountEmail ?? '', clearWindowsKey: false, clearOfficeKey: false, invoice: null }); setKeyErrors({ windowsKey: '', officeKey: '' }); setOfficeEmailError(''); setFieldErrors({}) }
  }, [selected?.id, selected?.version])

  async function decide(decision) {
    setError(''); setNotice('')
    if (engineerMode && decision === 'approve' && selected?.registeredByUserId === user.userId) {
      setError('Another Engineer must approve a request you registered.')
      return
    }
    if (decision === 'reject' && !remark.trim()) { setError('A remark is required to reject this request.'); return }
    setBusy(true)
    try {
      await laptopApi.decideRequest(user, selected, decision, remark)
      setRemark('')
      setNotice(decision === 'approve' ? 'Request approved and moved to the next review stage.' : 'Request returned with your remarks.')
      await refresh()
    } catch (decisionError) { setError(decisionError.message) }
    finally { setBusy(false) }
  }

  async function saveEdit() {
    if (!normalizeMacAddress(editForm?.macAddress)) { setError('Enter a valid MAC address.'); return }
    const nextKeyErrors = {
      windowsKey: editForm.windowsKey && normalizeLicenseKey(editForm.windowsKey) === null ? 'Invalid Windows key.' : '',
      officeKey: editForm.officeKey && normalizeLicenseKey(editForm.officeKey) === null ? 'Invalid MS Office key.' : '',
    }
    setKeyErrors(nextKeyErrors)
    if (nextKeyErrors.windowsKey || nextKeyErrors.officeKey) { setError('Correct the invalid license key.'); return }
    const normalizedOfficeEmail = normalizeEmail(editForm?.msOfficeAccountEmail)
    if (normalizedOfficeEmail === false || (editForm?.officeKey && !normalizedOfficeEmail)) {
      setOfficeEmailError(normalizedOfficeEmail === false ? 'Enter a valid MS Office account email.' : 'MS Office account email is required when an MS Office key is entered.')
      return
    }
    setOfficeEmailError('')
    if (selected.status === 'PENDING_ENGINEER' && !remark.trim()) { setError('Remarks are required when editing a request.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      if (selected.status === 'NEEDS_ENGINEER_CORRECTION') {
        await laptopApi.submitEngineerCorrection(selected, editForm, remark)
        setNotice('Correction submitted to the Engineer review queue.')
      } else {
        await laptopApi.editEngineerRequest(selected, editForm, remark)
        setNotice('Request details saved and audit logged.')
      }
      setRemark(''); await refresh()
    } catch (editError) {
      setFieldErrors(editError.fieldErrors ?? {})
      setError(Object.keys(editError.fieldErrors ?? {}).length ? '' : editError.message)
    }
    finally { setBusy(false) }
  }

  return (
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">{engineerMode ? 'ENGINEER WORKSPACE' : 'ADMIN WORKSPACE'}</span><h1>{engineerMode ? 'Engineer review queue' : 'Final approval'}</h1><p>{engineerMode ? 'Review device information and invoice details before forwarding to Admin.' : 'Complete the final review of engineer-approved laptop registrations.'}</p></div><div className="queue-counter"><strong>{pagination.total.toString().padStart(2, '0')}</strong><span>AWAITING REVIEW</span><div className="queue-paging"><button disabled={!pagination.offset} onClick={() => setPagination((p) => ({ ...p, offset: Math.max(0, p.offset - p.limit) }))}>‹</button><button disabled={pagination.offset + pagination.limit >= pagination.total} onClick={() => setPagination((p) => ({ ...p, offset: p.offset + p.limit }))}>›</button></div></div></div>
      {engineerMode && <div className="queue-tabs"><button className={queueStatus === 'PENDING_ENGINEER' ? 'active' : ''} onClick={() => { setQueueStatus('PENDING_ENGINEER'); setPagination((p) => ({ ...p, offset: 0 })); setSelectedId(null) }}>Pending review</button><button className={queueStatus === 'NEEDS_ENGINEER_CORRECTION' ? 'active' : ''} onClick={() => { setQueueStatus('NEEDS_ENGINEER_CORRECTION'); setPagination((p) => ({ ...p, offset: 0 })); setSelectedId(null) }}>Returned by Admin</button></div>}
      {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="inline-success">{notice}</div>}
      <div className="review-layout">
        <section className="surface queue-panel"><div className="section-heading"><div><span className="eyebrow">INCOMING</span><h2>Requests <span className="count-pill">{queue.length}</span></h2></div></div>
          <div className="queue-list">{queue.length ? queue.map((item) => <button key={item.id} className={`queue-item${selected?.id === item.id ? ' selected' : ''}`} onClick={() => { setSelectedId(item.id); setRemark('') }}><div className="queue-item-top"><StatusBadge status={item.status} />{item.duplicateKeyWarning && <span className="warning-dot" title="Duplicate MS key warning">!</span>}</div><strong>{item.modelNumber}</strong><span>{item.employeeName} · {item.employeeSapId} · {item.department}</span><small>{item.serialNumber}</small></button>) : <EmptyState title="Queue is clear" detail="New requests will appear here when they are submitted." />}</div>
        </section>
        {selected ? <section className="surface review-detail">
          <div className="detail-heading"><div><span className="eyebrow">REQUEST DETAILS</span><h2>{selected.modelNumber}</h2><span>{selected.serialNumber} · {selected.employeeName} · {selected.employeeSapId}</span></div><StatusBadge status={selected.status} /></div>
          {(selected.windowsKeyDuplicateWarning || selected.officeKeyDuplicateWarning || selected.duplicateKeyWarning) && <div className="duplicate-warning"><div className="warning-symbol">!</div><div><strong>Duplicate key match</strong><p>{selected.windowsKeyDuplicateWarning && 'Windows key matches another Windows key. '}{selected.officeKeyDuplicateWarning && 'MS Office key matches another MS Office key. '}Review the warning during approval.</p></div><span>CHECK REQUIRED</span></div>}
          {selected.legacyKeyPresent && <div className="legacy-key-label">Legacy key</div>}
          <div className="detail-grid"><Detail label="Serial number" value={selected.serialNumber} /><Detail label="Purchase date" value={formatPurchaseDate(selected.purchaseDate)} /><Detail label="Model number" value={selected.modelNumber} /><Detail label="MAC address" value={selected.macAddress} /><Detail label="Operating system" value={selected.operatingSystem} /><Detail label="Employee department" value={selected.department} /><Detail label="MS Office account email" value={selected.msOfficeAccountEmail} /><Detail label="Created by" value={selected.createdByName ? `${selected.createdByName} (${selected.createdBySapId})` : selected.createdBySapId} /></div>
          <div className="invoice-row"><div className="invoice-icon">{invoiceTypeLabel(selected.invoices?.at(-1)?.mimeType)}</div><div><strong>{selected.invoiceName || 'Invoice pending'}</strong><span>{selected.needsInvoiceReplacement ? 'Needs replacement' : 'Current private invoice'}</span></div>{selected.invoices?.at(-1) && <button className="button button-quiet button-small" onClick={() => laptopApi.downloadInvoice(selected.invoices.at(-1).fileId, selected.invoices.at(-1).originalName)}>Download ↗</button>}</div>
          {selected.needsInvoiceReplacement && <div className="invoice-replacement-notice">This invoice remains available for review, but the Employee must upload a replacement before resubmission.</div>}
          {engineerMode && <div className="detail-grid engineer-edit-grid">
            <label className="detail-cell"><span>Serial number</span><input value={editForm?.serialNumber ?? ''} onChange={(e) => { setEditForm((f) => ({ ...f, serialNumber: e.target.value })); setFieldErrors((current) => ({ ...current, serialNumber: '' })) }} />{fieldErrors.serialNumber && <small className="field-error" role="alert">{fieldErrors.serialNumber}</small>}</label>
            <label className="detail-cell"><span>Purchase date</span><input type="date" value={editForm?.purchaseDate ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, purchaseDate: e.target.value }))} /></label>
            <label className="detail-cell"><span>Model number</span><input value={editForm?.modelNumber ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, modelNumber: e.target.value }))} /></label>
            <label className="detail-cell"><span>MAC address</span><input value={editForm?.macAddress ?? ''} onChange={(e) => { setEditForm((f) => ({ ...f, macAddress: e.target.value })); setFieldErrors((current) => ({ ...current, macAddress: '' })) }} />{fieldErrors.macAddress && <small className="field-error" role="alert">{fieldErrors.macAddress}</small>}</label>
            <label className="detail-cell"><span>Operating system</span><select value={editForm?.operatingSystem ?? 'Windows'} onChange={(e) => setEditForm((f) => ({ ...f, operatingSystem: e.target.value, ...(e.target.value === 'macOS' ? { windowsKey: '' } : {}) }))}><option>Windows</option><option>macOS</option></select></label>
            <label className="detail-cell"><span>Replace invoice</span><input type="file" accept=".pdf,image/*" onChange={(e) => setEditForm((f) => ({ ...f, invoice: e.target.files?.[0] ?? null }))} /></label>
            <label className="detail-cell"><span>Windows key (optional)</span><input type="password" autoComplete="off" disabled={editForm?.operatingSystem === 'macOS'} value={editForm?.windowsKey ?? ''} onChange={(e) => { const value=e.target.value; setEditForm((f) => ({ ...f, windowsKey: value })); setKeyErrors((current) => ({ ...current, windowsKey: value && normalizeLicenseKey(value) === null ? 'Invalid Windows key.' : '' })) }} placeholder={editForm?.operatingSystem === 'macOS' ? 'Not used for macOS' : 'Enter only if assigned'} />{keyErrors.windowsKey && <small className="field-error" role="alert">{keyErrors.windowsKey}</small>}</label>
            <label className="detail-cell"><span>MS Office key (optional)</span><input type="password" autoComplete="off" value={editForm?.officeKey ?? ''} onChange={(e) => { const value=e.target.value; setEditForm((f) => ({ ...f, officeKey: value })); setKeyErrors((current) => ({ ...current, officeKey: value && normalizeLicenseKey(value) === null ? 'Invalid MS Office key.' : '' })) }} />{keyErrors.officeKey && <small className="field-error" role="alert">{keyErrors.officeKey}</small>}</label>
            <label className="detail-cell"><span>MS Office account email</span><input type="email" autoComplete="off" value={editForm?.msOfficeAccountEmail ?? ''} onChange={(e) => { const value = e.target.value; setEditForm((f) => ({ ...f, msOfficeAccountEmail: value })); setOfficeEmailError(normalizeEmail(value) === false ? 'Enter a valid MS Office account email.' : '') }} />{officeEmailError && <small className="field-error" role="alert">{officeEmailError}</small>}</label>
            {selected.windowsKeyPresent && <label className="detail-cell key-clear-option"><input type="checkbox" checked={editForm?.clearWindowsKey ?? false} onChange={(e) => setEditForm((f) => ({ ...f, clearWindowsKey: e.target.checked }))} /><span>Clear saved Windows key. Save the removal before changing this device to macOS.</span></label>}
            {selected.officeKeyPresent && <label className="detail-cell key-clear-option"><input type="checkbox" checked={editForm?.clearOfficeKey ?? false} onChange={(e) => setEditForm((f) => ({ ...f, clearOfficeKey: e.target.checked }))} /><span>Remove saved MS Office key</span></label>}
          </div>}
          {latestRemark && <div className="previous-remark"><span>PREVIOUS REMARK</span><p>{latestRemark.text}</p><small>{latestRemark.actor} · {latestRemark.date}</small></div>}
          <label className="review-remark">{selected.status === 'NEEDS_ENGINEER_CORRECTION' ? 'Correction remarks' : 'Decision remarks'} {selected.status !== 'NEEDS_ENGINEER_CORRECTION' && <span className="optional-label">Required for rejection</span>}<textarea rows="3" value={remark} onChange={(event) => setRemark(event.target.value)} placeholder={engineerMode ? 'Add your review notes…' : 'Add your final review notes…'} /></label>
          <div className="decision-actions">{engineerMode && <button className="button button-quiet" disabled={busy} onClick={saveEdit}>{selected.status === 'NEEDS_ENGINEER_CORRECTION' ? 'Submit correction' : 'Save edits'}</button>}{selected.status !== 'NEEDS_ENGINEER_CORRECTION' && <><button className="button button-danger" disabled={busy} onClick={() => decide('reject')}>Return for correction</button><button className="button button-primary" disabled={busy || (engineerMode && selected.registeredByUserId === user.userId)} onClick={() => decide('approve')}>{engineerMode ? 'Approve for Admin' : 'final approval'}<span>→</span></button></>}</div>
        </section> : <section className="surface review-empty"><EmptyState title="Select a request" detail="Choose a request from the queue to review its details." /></section>}
      </div>
    </div>
  )
}

function Detail({ label, value }) { return <div className="detail-cell"><span>{label}</span><strong>{value || '—'}</strong></div> }
function invoiceTypeLabel(mimeType) { return mimeType === 'image/jpeg' ? 'JPG' : mimeType === 'image/png' ? 'PNG' : mimeType === 'application/pdf' ? 'PDF' : 'FILE' }
