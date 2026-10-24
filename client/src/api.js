const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api').replace(/\/$/, '')
let bearerToken = localStorage.getItem('lms.session')

export function setApiToken(token) {
  bearerToken = token
  if (token) localStorage.setItem('lms.session', token)
  else localStorage.removeItem('lms.session')
}

export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || data.message || 'The request could not be completed')
  return data
}

export async function apiBlob(path) {
  const headers = new Headers()
  if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`)
  const response = await fetch(`${API_BASE_URL}${path}`, { headers })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || 'The file could not be downloaded')
  }
  return response.blob()
}

export { API_BASE_URL }
