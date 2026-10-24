import { apiFetch } from '../api.js'

// Demo identities map SAP IDs to records. The UI never submits or selects a role.
const demoUsers = {
  EMP00001: { userId: 'demo-employee-1', sapId: 'EMP00001', email: 'asha.rao@example.test', role: 'employee', employeeName: 'Asha Rao', department: 'Procurement' },
  ENG00001: { userId: 'demo-engineer-1', sapId: 'ENG00001', email: 'rohan.kumar@example.test', role: 'engineer', employeeName: 'Rohan Kumar', department: 'IT Services' },
  ADM00001: { userId: 'demo-admin-1', sapId: 'ADM00001', email: 'meera.shah@example.test', role: 'admin', employeeName: 'Meera Shah', department: 'Administration' },
}
const demoMode = import.meta.env.VITE_DEMO_MODE === 'true'
const demoSessionKey = 'lms.demo.user'

export const api = {
  async requestOtp(sapId) {
    if (!demoMode) return apiFetch('/auth/request-otp', { method: 'POST', body: { sapId } })
    // Same response for known and unknown SAP IDs, as in the backend contract.
    return { message: 'If the account is active, a login code has been sent to its registered email.' }
  },

  async verifyOtp(sapId, otp) {
    if (!demoMode) return apiFetch('/auth/verify-otp', { method: 'POST', body: { sapId, otp } })
    const account = demoUsers[sapId.trim().toUpperCase()]
    if (!account || otp !== '123456') throw new Error('Invalid or expired login code')
    const token = `demo.${account.userId}`
    localStorage.setItem(demoSessionKey, JSON.stringify({ token, user: account }))
    return { token }
  },

  async me() {
    if (!demoMode) {
      const result = await apiFetch('/auth/me')
      const user = result.user
      return { user: { ...user, employeeName: user.employee?.employeeName || user.employeeName, department: user.employee?.department || user.department } }
    }
    const session = JSON.parse(localStorage.getItem(demoSessionKey) || 'null')
    if (!session || !session.token) throw new Error('Demo session has expired')
    return { user: { ...session.user, isDemo: true } }
  },
}

export const isDemoMode = demoMode
