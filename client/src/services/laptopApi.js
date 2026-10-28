import { apiBlob, apiFetch } from '../api.js'
import { normalizeMacAddress } from '../utils/macAddress.js'
import { normalizeLicenseKey } from '../utils/licenseKey.js'
import { normalizeEmail } from '../utils/email.js'

function normalizeRequest(row) {
  const history = row.history ?? []
  const invoices = row.invoices ?? []
  return {
    ...row,
    id: row.requestId ?? row.request_id,
    serialNumber: row.serialNumber ?? row.serial_number,
    purchaseDate: row.purchaseDate ?? row.purchase_date,
    modelNumber: row.modelNumber ?? row.model_number,
    macAddress: row.macAddress ?? row.mac_address,
    operatingSystem: row.operatingSystem ?? row.operating_system,
    msOfficeAccountEmail: row.msOfficeAccountEmail ?? row.ms_office_account_email ?? null,
    registeredByUserId: row.registeredByUserId ?? row.registered_by_user_id ?? null,
    invoiceName: invoices.at(-1)?.originalName ?? '',
    duplicateKeyWarning: Boolean(row.duplicateLicenseWarning || row.windowsKeyDuplicateWarning || row.officeKeyDuplicateWarning),
    remarks: history.filter((item) => item.remarks).map((item) => ({
      actor: item.action?.replaceAll('_', ' ') ?? 'Reviewer',
      date: item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '',
      text: item.remarks,
    })),
  }
}

function correctionFields(form) {
  const msOfficeAccountEmail = normalizeEmail(form.msOfficeAccountEmail)
  if (msOfficeAccountEmail === false) throw new Error('Enter a valid MS Office account email.')
  const body = {
    serialNumber: form.serialNumber,
    purchaseDate: form.purchaseDate,
    modelNumber: form.modelNumber,
    macAddress: normalizeMacAddress(form.macAddress) ?? form.macAddress,
    operatingSystem: form.operatingSystem,
    msOfficeAccountEmail: msOfficeAccountEmail ?? '',
  }
  if (form.clearWindowsKey) body.windowsKey = null
  else if (form.windowsKey) {
    body.windowsKey = normalizeLicenseKey(form.windowsKey)
    if (!body.windowsKey) throw new Error('Invalid Windows key.')
  }
  if (form.clearOfficeKey) body.officeKey = null
  else if (form.officeKey) {
    body.officeKey = normalizeLicenseKey(form.officeKey)
    if (!body.officeKey) throw new Error('Invalid MS Office key.')
  }
  return body
}

async function uploadInvoice(path, file, expectedVersion, remarks) {
  const body = new FormData()
  body.set('invoice', file)
  body.set('expectedVersion', String(expectedVersion))
  if (remarks) body.set('remarks', remarks)
  return apiFetch(path, { method: 'POST', body })
}

export const laptopApi = {
  async listRequests(user) {
    const endpoint = user.role === 'employee'
      ? '/employee/requests'
      : user.role === 'engineer' ? '/engineer/requests?limit=100&offset=0' : '/admin/requests?limit=100&offset=0'
    const result = await apiFetch(endpoint)
    return (result.requests ?? []).map(normalizeRequest)
  },

  async listReviewQueue(user, offset = 0, limit = 25, status = null) {
    const role = user.role === 'engineer' ? 'engineer' : 'admin'
    if (role === 'engineer' && status === 'NEEDS_ENGINEER_CORRECTION') {
      const result = await apiFetch(`/engineer/reports?status=${status}&limit=${limit}&offset=${offset}`)
      const requests = await Promise.all(result.reports.map(async (row) => {
        const full = await this.getWorkflowRequest(role, row.id)
        return { ...full, department: row.department }
      }))
      return { requests, pagination: result.pagination }
    }
    const result = await apiFetch(`/${role}/requests?limit=${limit}&offset=${offset}`)
    return { ...result, requests: result.requests.map(normalizeRequest) }
  },

  async searchEmployeeBySapId(sapId) {
    const result = await apiFetch(`/engineer/employees/search?sapId=${encodeURIComponent(sapId)}`)
    return result.employee
  },

  async registerLaptopOnBehalf(sapId, form) {
    const body = new FormData()
    body.set('employeeSapId', sapId)
    for (const [key, value] of Object.entries(correctionFields(form))) body.set(key, value)
    if (!form.invoice) throw new Error('Attach the purchase invoice before submitting')
    body.set('invoice', form.invoice)
    const result = await apiFetch('/engineer/requests/register', { method: 'POST', body })
    return normalizeRequest(result.request)
  },

  async saveRequest(_user, form, id = null, currentRequest = null) {
    if (!id) {
      const body = new FormData()
      for (const [key, value] of Object.entries(correctionFields(form))) body.set(key, value)
      if (form.invoice) body.set('invoice', form.invoice)
      else throw new Error('Attach the purchase invoice before submitting')
      return normalizeRequest((await apiFetch('/employee/requests', { method: 'POST', body })).request)
    }
    if (!currentRequest) throw new Error('Reload this request before editing it')
    let version = currentRequest.version
    if (form.invoice) {
      const uploaded = await uploadInvoice(`/employee/requests/${id}/invoice`, form.invoice, version)
      version = uploaded.version
    }
    const result = await apiFetch(`/employee/requests/${id}/corrections`, {
      method: 'POST',
      body: { ...correctionFields(form), expectedVersion: version },
    })
    version = result.request.version
    return { ...normalizeRequest(result.request), version }
  },

  async decideRequest(_user, request, decision, remark) {
    const endpoint = request.status === 'PENDING_ENGINEER' ? 'engineer' : 'admin'
    const result = await apiFetch(`/${endpoint}/requests/${request.id}/decision`, {
      method: 'POST', body: { action: decision, remarks: remark, expectedVersion: request.version },
    })
    return normalizeRequest(result.request)
  },

  async editEngineerRequest(request, form, remarks) {
    const body = { ...correctionFields(form), expectedVersion: request.version, remarks }
    const result = await apiFetch(`/engineer/requests/${request.id}`, { method: 'PATCH', body })
    let version = result.request.version
    if (form.invoice) {
      const uploaded = await uploadInvoice(`/engineer/requests/${request.id}/invoice`, form.invoice, version, remarks)
      version = uploaded.version
    }
    return { ...request, ...form, id: request.id, version }
  },

  async submitEngineerCorrection(request, form, remarks = '') {
    if (form.invoice && !remarks.trim()) throw new Error('Add remarks when replacing an invoice')
    let version = request.version
    if (form.invoice) {
      const uploaded = await uploadInvoice(`/engineer/requests/${request.id}/invoice`, form.invoice, version, remarks)
      version = uploaded.version
    }
    const result = await apiFetch(`/engineer/requests/${request.id}/corrections`, {
      method: 'POST', body: { ...correctionFields(form), expectedVersion: version, remarks },
    })
    return normalizeRequest(result.request)
  },

  async getWorkflowRequest(role, requestId) {
    const result = await apiFetch(`/${role}/requests/${requestId}`)
    return normalizeRequest(result.request)
  },

  async downloadInvoice(fileId, filename) {
    const blob = await apiBlob(`/invoices/${fileId}/download`)
    const extension = ({ 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' })[blob.type]
    const safeName = String(filename || 'invoice').replace(/[\\/\r\n]/g, '_')
    const lastDot = safeName.lastIndexOf('.')
    const baseName = lastDot > 0 ? safeName.slice(0, lastDot) : safeName
    const downloadName = extension
      ? `${baseName || 'invoice'}${extension}`
      : safeName
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = downloadName
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  },

  async listReports(role, filters = {}) {
    const params = new URLSearchParams({ limit: String(filters.limit ?? 25), offset: String(filters.offset ?? 0) })
    for (const name of ['status', 'sapId', 'from', 'to', 'duplicateOnly']) {
      if (filters[name]) params.set(name, filters[name])
    }
    const result = await apiFetch(`/${role}/reports?${params}`)
    return { ...result, reports: result.reports.map(normalizeRequest) }
  },

  async downloadReportExcel(filters = {}) {
    const params = new URLSearchParams()
    for (const name of ['status', 'sapId', 'from', 'to', 'duplicateOnly']) {
      if (filters[name]) params.set(name, filters[name])
    }
    const blob = await apiBlob(`/admin/reports/export.xlsx?${params}`)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `laptop-report-${new Date().toISOString().slice(0, 10)}.xlsx`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  },

  async listAccounts({ limit = 25, offset = 0, q = '' } = {}) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    if (q) params.set('q', q)
    return apiFetch(`/admin/accounts?${params}`)
  },

  async listAudit({ limit = 25, offset = 0, sapId = '', action = '', from = '', to = '' } = {}) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    for (const [key, value] of Object.entries({ sapId, action, from, to })) if (value) params.set(key, value)
    return apiFetch(`/admin/audit?${params}`)
  },

  async downloadAuditExcel({ sapId = '', action = '', from = '', to = '' } = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries({ sapId, action, from, to })) if (value) params.set(key, value)
    const blob = await apiBlob(`/admin/audit/export.xlsx?${params}`)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `audit-${new Date().toISOString().slice(0, 10)}.xlsx`
    document.body.append(anchor); anchor.click(); anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  },

  async createAccount(account) {
    return (await apiFetch('/admin/accounts', { method: 'POST', body: account })).account
  },

  async updateAccount(userId, patch) {
    return (await apiFetch(`/admin/accounts/${userId}`, { method: 'PATCH', body: patch })).account
  },

  async updateAccountProfile(userId, profile) {
    return (await apiFetch(`/admin/accounts/${userId}/profile`, { method: 'PATCH', body: profile })).account
  },

  async searchClearance(sapId) {
    return (await apiFetch(`/admin/retirement-clearances?sapId=${encodeURIComponent(sapId)}`)).clearances
  },

  async createClearance(sapId, reason) {
    return (await apiFetch('/admin/retirement-clearances', { method: 'POST', body: { sapId, reason } })).clearance
  },

  async updateClearanceCheck(clearanceId, checkId, patch) {
    return (await apiFetch(`/admin/retirement-clearances/${clearanceId}/checks/${checkId}`, { method: 'PATCH', body: patch })).check
  },

  async finalizeClearance(clearanceId, remarks, reason) {
    return (await apiFetch(`/admin/retirement-clearances/${clearanceId}/clear`, { method: 'POST', body: { remarks, reason } })).clearance
  },
}
