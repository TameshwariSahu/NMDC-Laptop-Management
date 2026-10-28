import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/AuthContext.jsx'
import AppShell from './components/AppShell.jsx'
import LoginPage from './pages/LoginPage.jsx'
import EmployeePage from './pages/EmployeePage.jsx'
import ReviewQueuePage from './pages/ReviewQueuePage.jsx'
import EngineerRegisterPage from './pages/EngineerRegisterPage.jsx'
import ReportsPage from './pages/ReportsPage.jsx'
import { AccountsPage, ClearancePage } from './pages/AdminPages.jsx'
import AuditPage from './pages/AuditPage.jsx'

function homeForRole(role) {
  return role === 'employee' ? '/employee' : role === 'engineer' ? '/engineer' : '/admin'
}

function SignedIn() {
  const { user, loading } = useAuth()
  if (loading) return <div className="login-loading">Loading your workspace…</div>
  return user ? <Outlet /> : <Navigate to="/login" replace />
}

function RoleGate({ roles, children }) {
  const { user } = useAuth()
  return roles.includes(user.role) ? children : <Navigate to={homeForRole(user.role)} replace />
}

export default function App() {
  return <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route element={<SignedIn />}>
      <Route element={<AppShell />}>
        <Route path="/employee" element={<RoleGate roles={['employee']}><EmployeePage /></RoleGate>} />
        <Route path="/engineer" element={<RoleGate roles={['engineer']}><ReviewQueuePage mode="engineer" /></RoleGate>} />
        <Route path="/engineer/register" element={<RoleGate roles={['engineer']}><EngineerRegisterPage /></RoleGate>} />
        <Route path="/admin" element={<RoleGate roles={['admin']}><ReviewQueuePage mode="admin" /></RoleGate>} />
        <Route path="/admin/accounts" element={<RoleGate roles={['admin']}><AccountsPage /></RoleGate>} />
        <Route path="/admin/clearance" element={<RoleGate roles={['admin']}><ClearancePage /></RoleGate>} />
        <Route path="/admin/audit" element={<RoleGate roles={['admin']}><AuditPage /></RoleGate>} />
        <Route path="/reports" element={<RoleGate roles={['engineer', 'admin']}><ReportsPage /></RoleGate>} />
      </Route>
    </Route>
    <Route path="/" element={<RootRedirect />} />
    <Route path="*" element={<RootRedirect />} />
  </Routes>
}

function RootRedirect() {
  const { user, loading } = useAuth()
  if (loading) return <div className="login-loading">Loading your workspace…</div>
  return <Navigate to={user ? homeForRole(user.role) : '/login'} replace />
}
