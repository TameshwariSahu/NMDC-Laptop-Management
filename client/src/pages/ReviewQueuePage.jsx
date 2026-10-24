import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import EmptyState from '../components/EmptyState.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import { laptopApi } from '../services/laptopApi.js'
import { formatPurchaseDate } from '../utils/formatDate.js'

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
    if (selected) setEditForm({ serialNumber: selected.serialNumber, purchaseDate: String(selected.purchaseDate).slice(0, 10), modelNumber: selected.modelNumber, macAddress: selected.macAddress, operatingSystem: selected.operatingSystem, msLicenseKey: '', invoice: null })
  }, [selected?.id, selected?.version])

  async function decide(decision) {
    setError(''); setNotice('')
    if (!remark.trim()) { setError('A reviewer remark is required before you can decide.'); return }
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
    } catch (editError) { setError(editError.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="page-stack">
      <div className="page-heading"><div><span className="eyebrow">{engineerMode ? 'ENGINEER WORKSPACE' : 'ADMIN WORKSPACE'}</span><h1>{engineerMode ? 'Engineer review queue' : 'Final approval'}</h1><p>{engineerMode ? 'Review device information and invoice details before forwarding to Admin.' : 'Complete the final review of engineer-approved laptop registrations.'}</p></div><div className="queue-counter"><strong>{pagination.total.toString().padStart(2, '0')}</strong><span>AWAITING REVIEW</span><div className="queue-paging"><button disabled={!pagination.offset} onClick={() => setPagination((p) => ({ ...p, offset: Math.max(0, p.offset - p.limit) }))}>‹</button><button disabled={pagination.offset + pagination.limit >= pagination.total} onClick={() => setPagination((p) => ({ ...p, offset: p.offset + p.limit }))}>›</button></div></div></div>
      {engineerMode && <div className="queue-tabs"><button className={queueStatus === 'PENDING_ENGINEER' ? 'active' : ''} onClick={() => { setQueueStatus('PENDING_ENGINEER'); setPagination((p) => ({ ...p, offset: 0 })); setSelectedId(null) }}>Pending review</button><button className={queueStatus === 'NEEDS_ENGINEER_CORRECTION' ? 'active' : ''} onClick={() => { setQueueStatus('NEEDS_ENGINEER_CORRECTION'); setPagination((p) => ({ ...p, offset: 0 })); setSelectedId(null) }}>Returned by Admin</button></div>}
      {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="inline-success">{notice}</div>}
      <div className="review-layout">
        <section className="surface queue-panel"><div className="section-heading"><div><span className="eyebrow">INCOMING</span><h2>Requests <span className="count-pill">{queue.length}</span></h2></div></div>
          <div className="queue-list">{queue.length ? queue.map((item) => <button key={item.id} className={`queue-item${selected?.id === item.id ? ' selected' : ''}`} onClick={() => { setSelectedId(item.id); setRemark('') }}><div className="queue-item-top"><span className="request-id">{item.id}</span>{item.duplicateKeyWarning && <span className="warning-dot" title="Duplicate MS key warning">!</span>}</div><strong>{item.modelNumber}</strong><span>{item.employeeName} · {item.department}</span><small>{item.serialNumber}</small></button>) : <EmptyState title="Queue is clear" detail="New requests will appear here when they are submitted." />}</div>
        </section>
        {selected ? <section className="surface review-detail">
          <div className="detail-heading"><div><span className="eyebrow">REQUEST DETAILS</span><h2>{selected.modelNumber}</h2><span className="request-id">{selected.id} · Submitted by {selected.employeeName}</span></div><StatusBadge status={selected.status} /></div>
          {selected.duplicateKeyWarning && <div className="duplicate-warning"><div className="warning-symbol">!</div><div><strong>Duplicate MS-key match</strong><p>A match exists in another laptop record. Review this warning during approval.</p></div><span>CHECK REQUIRED</span></div>}
          <div className="detail-grid"><Detail label="Serial number" value={selected.serialNumber} /><Detail label="Purchase date" value={formatPurchaseDate(selected.purchaseDate)} /><Detail label="Model number" value={selected.modelNumber} /><Detail label="MAC address" value={selected.macAddress} /><Detail label="Operating system" value={selected.operatingSystem} /><Detail label="Employee department" value={selected.department} /></div>
          <div className="invoice-row"><div className="invoice-icon">{invoiceTypeLabel(selected.invoices?.at(-1)?.mimeType)}</div><div><strong>{selected.invoiceName || 'Invoice pending'}</strong><span>{selected.needsInvoiceReplacement ? 'Needs replacement' : 'Current private invoice'}</span></div>{selected.invoices?.at(-1) && <button className="button button-quiet button-small" onClick={() => laptopApi.downloadInvoice(selected.invoices.at(-1).fileId, selected.invoices.at(-1).originalName)}>Download ↗</button>}</div>
          {selected.needsInvoiceReplacement && <div className="invoice-replacement-notice">This invoice remains available for review, but the Employee must upload a replacement before resubmission.</div>}
          {engineerMode && <div className="detail-grid engineer-edit-grid">
            <label className="detail-cell"><span>Serial number</span><input value={editForm?.serialNumber ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, serialNumber: e.target.value }))} /></label>
            <label className="detail-cell"><span>Purchase date</span><input type="date" value={editForm?.purchaseDate ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, purchaseDate: e.target.value }))} /></label>
            <label className="detail-cell"><span>Model number</span><input value={editForm?.modelNumber ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, modelNumber: e.target.value }))} /></label>
            <label className="detail-cell"><span>MAC address</span><input value={editForm?.macAddress ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, macAddress: e.target.value }))} /></label>
            <label className="detail-cell"><span>Operating system</span><select value={editForm?.operatingSystem ?? 'Windows'} onChange={(e) => setEditForm((f) => ({ ...f, operatingSystem: e.target.value }))}><option>Windows</option><option>macOS</option></select></label>
            <label className="detail-cell"><span>Replace invoice</span><input type="file" accept=".pdf,image/*" onChange={(e) => setEditForm((f) => ({ ...f, invoice: e.target.files?.[0] ?? null }))} /></label>
            <label className="detail-cell"><span>Replace MS key (optional)</span><input type="password" autoComplete="off" value={editForm?.msLicenseKey ?? ''} onChange={(e) => setEditForm((f) => ({ ...f, msLicenseKey: e.target.value }))} /></label>
          </div>}
          {latestRemark && <div className="previous-remark"><span>PREVIOUS REMARK</span><p>{latestRemark.text}</p><small>{latestRemark.actor} · {latestRemark.date}</small></div>}
          <label className="review-remark">{selected.status === 'NEEDS_ENGINEER_CORRECTION' ? 'Correction remarks' : 'Your decision remark'} {selected.status !== 'NEEDS_ENGINEER_CORRECTION' && <span className="required-label">Required</span>}<textarea rows="3" value={remark} onChange={(event) => setRemark(event.target.value)} placeholder={engineerMode ? 'Add your review notes…' : 'Add your final review notes…'} /></label>
          <div className="decision-actions">{engineerMode && <button className="button button-quiet" disabled={busy} onClick={saveEdit}>{selected.status === 'NEEDS_ENGINEER_CORRECTION' ? 'Submit correction' : 'Save edits'}</button>}{selected.status !== 'NEEDS_ENGINEER_CORRECTION' && <><button className="button button-danger" disabled={busy} onClick={() => decide('reject')}>Return for correction</button><button className="button button-primary" disabled={busy} onClick={() => decide('approve')}>{engineerMode ? 'Approve for Admin' : 'Give final approval'}<span>→</span></button></>}</div>
        </section> : <section className="surface review-empty"><EmptyState title="Select a request" detail="Choose a request from the queue to review its details." /></section>}
      </div>
    </div>
  )
}

function Detail({ label, value }) { return <div className="detail-cell"><span>{label}</span><strong>{value || '—'}</strong></div> }
function invoiceTypeLabel(mimeType) { return mimeType === 'image/jpeg' ? 'JPG' : mimeType === 'image/png' ? 'PNG' : mimeType === 'application/pdf' ? 'PDF' : 'FILE' }
