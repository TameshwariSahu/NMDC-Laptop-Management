import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import nmdcLogo from '../assets/nmdclogo.png'
import { isDemoMode } from '../services/authApi.js'

function homeForRole(role) {
  return role === 'employee' ? '/employee' : role === 'engineer' ? '/engineer' : '/admin'
}

export default function LoginPage() {
  const { user, loading, requestOtp, login } = useAuth()
  const navigate = useNavigate()
  const [sapId, setSapId] = useState('')
  const [otp, setOtp] = useState('')
  const [step, setStep] = useState('sap')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  if (loading) return <div className="login-loading">Loading your workspace…</div>
  if (user) return <Navigate to={homeForRole(user.role)} replace />

  async function handleRequestOtp(event) {
    event.preventDefault()
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await requestOtp(sapId)
      setMessage(result.message)
      setStep('otp')
    } catch (requestError) { setError(requestError.message) }
    finally { setBusy(false) }
  }

  async function handleLogin(event) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const currentUser = await login(sapId, otp)
      navigate(homeForRole(currentUser.role), { replace: true })
    } catch (loginError) { setError(loginError.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="login-page">
      <section className="login-story">
        <div className="brand-lockup login-brand"><img className="brand-logo" src={nmdcLogo} alt="NMDC" /><div><strong>Laptop Desk</strong></div></div>
        <div className="story-content">
          <span className="eyebrow light-eyebrow">ASSET MANAGEMENT PORTAL</span>
          <h1>One place for every<br /><em>laptop request.</em></h1>
          <p>Register devices, follow reviews, and keep your organization’s laptop records in order.</p>
          <div className="story-stats"><div><strong>01</strong><span>Submit once</span></div><i /><div><strong>02</strong><span>Track clearly</span></div><i /><div><strong>03</strong><span>Close confidently</span></div></div>
        </div>
        <div className="story-footer"><span>SECURE ORGANIZATION ACCESS</span><span>NMDC · IT SERVICES</span></div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <span className="eyebrow">WELCOME BACK</span>
          <h2>{step === 'sap' ? 'Sign in to your account' : 'Check your email'}</h2>
          <p className="login-subtitle">{step === 'sap' ? 'Use your SAP ID to continue to the laptop workspace.' : `Enter the verification code sent to the email registered to ${sapId}.`}</p>
          {isDemoMode && <div className="demo-note"><div className="demo-note-icon">✦</div><div><strong>Demo login only</strong><p>Use <b>EMP00001</b>, <b>ENG00001</b>, or <b>ADM00001</b> with code <b>123456</b>. Business data still loads from the backend and requires a real authenticated session.</p></div></div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          {message && step === 'otp' && !isDemoMode && <div className="inline-success">{message}</div>}
          {step === 'sap' ? (
            <form onSubmit={handleRequestOtp} className="form-stack">
              <label>SAP ID<input autoComplete="username" placeholder="8 characters" value={sapId} onChange={(event) => setSapId(event.target.value.toUpperCase().slice(0, 8))} required minLength={8} maxLength={8} /></label>
              <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Sending code…' : 'Continue with SAP ID'}<span>→</span></button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="form-stack">
              <label>6-digit verification code<input className="otp-input" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} required minLength={6} maxLength={6} /></label>
              <button className="button button-primary button-wide" disabled={busy || otp.length !== 6}>{busy ? 'Verifying…' : 'Verify and sign in'}<span>→</span></button>
              <button type="button" className="text-button centered" onClick={() => { setStep('sap'); setOtp(''); setError('') }}>← Use a different SAP ID</button>
            </form>
          )}
          <div className="login-security"><span>▣</span> Your access is protected with email verification</div>
        </div>
        <div className="login-legal">© 2026 NMDC · Internal use only</div>
      </section>
    </div>
  )
}
