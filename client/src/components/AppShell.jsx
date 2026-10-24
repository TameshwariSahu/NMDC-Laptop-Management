import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import nmdcLogo from '../assets/nmdclogo.png'

const navByRole = {
  employee: [{ to: '/employee', label: 'My workspace', icon: '▦' }],
  engineer: [{ to: '/engineer', label: 'Review queue', icon: '◉' }, { to: '/reports', label: 'Reports', icon: '▤' }],
  admin: [{ to: '/admin', label: 'Final review', icon: '◉' }, { to: '/admin/accounts', label: 'Accounts', icon: '♙' }, { to: '/admin/clearance', label: 'No-dues clearance', icon: '✓' }, { to: '/reports', label: 'Reports', icon: '▤' }],
}

export default function AppShell() {
  const { user, logout } = useAuth()
  const [theme, setTheme] = useState(() => localStorage.getItem('lms.theme') === 'dark' ? 'dark' : 'light')
  const links = navByRole[user.role] || []
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('lms.theme', theme)
  }, [theme])
  return (
    <div className="app-frame" data-theme={theme}>
      <aside className="sidebar">
        <div className="brand-lockup"><img className="brand-logo" src={nmdcLogo} alt="NMDC" /><div><strong>Laptop Desk</strong></div></div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav">
          {links.map((item) => <NavLink key={item.to} to={item.to} end={item.to === '/admin'} className={({ isActive }) => `side-link${isActive ? ' active' : ''}`}><span className="nav-icon">{item.icon}</span>{item.label}</NavLink>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card"><span className="help-icon">?</span><strong>Need a hand?</strong><p>Contact your IT service desk for help with a request.</p></div>
          <div className="sidebar-foot"><span className="online-dot" /> System operational</div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-separator">/</span><strong>{links.find((link) => link.to === window.location.pathname)?.label || 'Laptop Desk'}</strong></div>
          <div className="topbar-right">
            {user.isDemo && <span className="demo-chip"><span className="demo-dot" /> Demo login</span>}
            <div className="profile"><div className="avatar">{user.employeeName?.split(' ').map((word) => word[0]).join('').slice(0, 2) || 'U'}</div><div className="profile-copy"><strong>{user.employeeName || user.sapId}</strong><span>{user.role} · {user.sapId}</span></div></div>
            <button type="button" className="button button-quiet theme-button" aria-pressed={theme === 'dark'} onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀ Light mode' : '◐ Dark mode'}</button>
            <button type="button" className="button button-quiet logout-button" onClick={logout}><span aria-hidden="true">↗</span> Logout</button>
          </div>
        </header>
        <main className="page-content"><Outlet /></main>
      </div>
    </div>
  )
}
