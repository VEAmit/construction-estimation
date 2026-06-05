import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useAppStore } from '../../store/useAppStore'
import { useBreakpoint } from '../../utils/useBreakpoint'
import toast from 'react-hot-toast'

const NAV = [
  { path: '/dashboard', label: 'Dashboard', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  )},
  { path: '/drawings', label: 'Drawings', icon: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  )},
]

export default function Header() {
  const navigate = useNavigate()
  const location = useLocation()
  const { userName, userEmail, userRole, clearAuth } = useAppStore()
  const { isMobile, isSmallMobile } = useBreakpoint()

  const [dropOpen,  setDropOpen]  = useState(false)
  const [menuOpen,  setMenuOpen]  = useState(false)
  const dropRef = useRef(null)
  const menuRef = useRef(null)

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setDropOpen(false)
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close mobile menu on route change
  useEffect(() => { setMenuOpen(false) }, [location.pathname])

  const handleLogout = () => {
    clearAuth()
    toast.success('Logged out successfully')
    navigate('/login')
  }

  const initials = userName
    ? userName.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)
    : 'U'

  return (
    <header style={{
      height: '52px',
      background: '#0B1320',
      borderBottom: '1px solid rgba(255,255,255,0.07)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px 0 12px',
      gap: '8px',
      flexShrink: 0,
      position: 'relative',
      zIndex: 100,
      boxShadow: '0 1px 12px rgba(0,0,0,.5)',
    }}>

      {/* Red top accent */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
        background: 'linear-gradient(90deg, #EF233C 0%, rgba(239,35,60,.3) 60%, transparent 100%)',
      }} />

      {/* Logo */}
      <Link to="/dashboard" style={{ display: 'flex', alignItems: 'center', gap: '9px', textDecoration: 'none', flexShrink: 0 }}>
        <div style={{
          width: '32px', height: '32px', borderRadius: '7px',
          background: 'linear-gradient(135deg,#EF233C,#D90429)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 10px rgba(239,35,60,.45)', flexShrink: 0,
        }}>
          <img src="/small-logo.png" alt="BuildTakeoff Pro" style={{ width: '20px', height: '20px', objectFit: 'contain' }} />
        </div>
        {!isSmallMobile && (
          <div>
            <div style={{ color: '#fff', fontWeight: 800, fontSize: '13px', letterSpacing: '.04em', lineHeight: 1.1, textTransform: 'uppercase' }}>
              BuildTakeoff <span style={{ color: '#EF233C' }}>Pro</span>
            </div>
            {!isMobile && (
              <div style={{ color: 'rgba(255,255,255,.3)', fontSize: '9px', letterSpacing: '.08em', textTransform: 'uppercase' }}>
                Estimation Platform
              </div>
            )}
          </div>
        )}
      </Link>

      {/* Desktop / Tablet nav */}
      {!isMobile && (
        <>
          <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,.07)', margin: '0 4px' }} />
          <nav style={{ display: 'flex', alignItems: 'center', gap: '2px', flex: 1 }}>
            {NAV.map(({ path, label, icon }) => {
              const active = location.pathname.startsWith(path)
              return (
                <Link key={path} to={path} style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '5px 12px', borderRadius: '6px', textDecoration: 'none',
                  fontSize: '12px', fontWeight: active ? 700 : 400,
                  color: active ? '#fff' : '#64748b',
                  background: active ? 'rgba(239,35,60,.12)' : 'transparent',
                  border: `1px solid ${active ? 'rgba(239,35,60,.25)' : 'transparent'}`,
                  transition: 'all .15s', position: 'relative',
                }}
                  onMouseEnter={e => { if (!active) { e.currentTarget.style.color = '#cbd5e1'; e.currentTarget.style.background = 'rgba(255,255,255,.05)' }}}
                  onMouseLeave={e => { if (!active) { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.background = 'transparent' }}}
                >
                  {active && (
                    <span style={{
                      position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
                      width: '3px', height: '16px', borderRadius: '2px', background: '#EF233C',
                    }} />
                  )}
                  <span style={{ color: active ? '#EF233C' : 'currentColor' }}>{icon}</span>
                  {label}
                </Link>
              )
            })}
          </nav>
        </>
      )}

      {/* Spacer on mobile */}
      {isMobile && <div style={{ flex: 1 }} />}

      {/* Right section */}
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '6px' : '8px' }}>

        {/* Mobile hamburger */}
        {isMobile && (
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              style={{
                background: menuOpen ? 'rgba(239,35,60,.1)' : 'transparent',
                border: `1px solid ${menuOpen ? 'rgba(239,35,60,.3)' : 'rgba(255,255,255,.07)'}`,
                borderRadius: '7px', padding: '6px 8px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#94a3b8', transition: 'all .15s',
              }}
              aria-label="Navigation menu"
            >
              {menuOpen
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              }
            </button>

            {menuOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                background: '#111827', border: '1px solid rgba(255,255,255,.08)',
                borderRadius: '10px', boxShadow: '0 16px 48px rgba(0,0,0,.7)',
                minWidth: '180px', zIndex: 200, overflow: 'hidden',
                animation: 'fadeUp .15s ease-out',
              }}>
                {NAV.map(({ path, label, icon }) => {
                  const active = location.pathname.startsWith(path)
                  return (
                    <Link key={path} to={path} style={{
                      display: 'flex', alignItems: 'center', gap: '10px',
                      padding: '12px 16px', textDecoration: 'none',
                      fontSize: '14px', fontWeight: active ? 700 : 400,
                      color: active ? '#EF233C' : '#94a3b8',
                      background: active ? 'rgba(239,35,60,.08)' : 'transparent',
                      borderLeft: active ? '3px solid #EF233C' : '3px solid transparent',
                      transition: 'all .15s',
                    }}>
                      {icon}
                      {label}
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* User menu */}
        <div ref={dropRef} style={{ position: 'relative' }}>
          <button onClick={() => setDropOpen(o => !o)} style={{
            display: 'flex', alignItems: 'center', gap: isMobile ? '6px' : '8px',
            background: dropOpen ? 'rgba(239,35,60,.1)' : 'transparent',
            border: '1px solid', borderColor: dropOpen ? 'rgba(239,35,60,.3)' : 'rgba(255,255,255,.07)',
            borderRadius: '8px', padding: isMobile ? '4px 8px 4px 4px' : '4px 10px 4px 4px',
            cursor: 'pointer', transition: 'all .15s',
          }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg,#EF233C,#D90429)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '11px', fontWeight: 700, color: '#fff',
              boxShadow: '0 2px 8px rgba(239,35,60,.4)',
            }}>{initials}</div>
            {!isMobile && (
              <>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#f1f5f9', lineHeight: 1.2 }}>
                    {userName ?? 'User'}
                  </div>
                  <div style={{ fontSize: '10px', color: '#475569', lineHeight: 1.2 }}>
                    {userRole ?? 'Member'}
                  </div>
                </div>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2"
                  style={{ transform: dropOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </>
            )}
          </button>

          {dropOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0,
              background: '#111827', border: '1px solid rgba(255,255,255,.07)',
              borderRadius: '10px', boxShadow: '0 16px 48px rgba(0,0,0,.7)',
              minWidth: '200px', zIndex: 200, overflow: 'hidden',
              animation: 'fadeUp .15s ease-out',
            }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9' }}>{userName}</div>
                <div style={{ fontSize: '11px', color: '#475569', marginTop: '2px' }}>{userEmail}</div>
              </div>
              <div style={{ padding: '6px' }}>
                <button onClick={handleLogout} style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '10px 10px', borderRadius: '6px', border: 'none',
                  background: 'transparent', cursor: 'pointer', color: '#f87171',
                  fontSize: '13px', textAlign: 'left', transition: 'background .15s',
                  touchAction: 'manipulation',
                }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,35,60,.1)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                    <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                  </svg>
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
