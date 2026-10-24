import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { api } from '../services/authApi.js'
import { setApiToken } from '../api.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('lms.session')
    if (!token) {
      setLoading(false)
      return
    }
    api.me().then((result) => setUser(result.user)).catch(() => {
      setApiToken(null)
      setUser(null)
    }).finally(() => setLoading(false))
  }, [])

  const value = useMemo(() => ({
    user,
    loading,
    requestOtp: api.requestOtp,
    async login(sapId, otp) {
      const result = await api.verifyOtp(sapId, otp)
      setApiToken(result.token)
      const current = await api.me()
      setUser(current.user)
      return current.user
    },
    logout() {
      setApiToken(null)
      localStorage.removeItem('lms.demo.user')
      setUser(null)
    },
  }), [user, loading])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
