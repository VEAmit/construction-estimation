import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { useAppStore } from '../../store/useAppStore'
import toast from 'react-hot-toast'

const NAV = [
  { path: '/dashboard', label: 'Dashboard', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  )},
  { path: '/drawings', label: 'Drawings', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  )},
]

export default function Header() {
  const navigate = useNavigate()
  const location = useLocation()
  const { userName, userEmail, userRole, clearAuth } = useAppStore()
  const [dropOpen, setDropOpen] = useState(false)
  const dropRef = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setDropOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

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
      background: '#0f172a',
      borderBottom: '1px solid #1e293b',
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      gap: '8px',
      flexShrink: 0,
      position: 'relative',
      zIndex: 100,
    }}>
      {/* Logo */}
      <Link to="/dashboard" style={{ display:'flex', alignItems:'center', gap:'8px', textDecoration:'none', marginRight:'8px' }}>
        <div style={{
          width:'32px', height:'32px', borderRadius:'8px',
          background:'linear-gradient(135deg,#1d6fdb,#0d47a1)',
          display:'flex', alignItems:'center', justifyContent:'center',
          boxShadow:'0 2px 8px rgba(29,111,219,.4)',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
        </div>
        <span style={{ color:'#f1f5f9', fontWeight:700, fontSize:'15px', letterSpacing:'-0.3px' }}>
          BuildTakeoff <span style={{ color:'#3b82f6' }}>Pro</span>
        </span>
      </Link>

      <div style={{ width:'1px', height:'24px', background:'#1e293b', margin:'0 4px' }} />

      {/* Nav */}
      <nav style={{ display:'flex', alignItems:'center', gap:'2px', flex:1 }}>
        {NAV.map(({ path, label, icon }) => {
          const active = location.pathname.startsWith(path)
          return (
            <Link key={path} to={path} style={{
              display:'flex', alignItems:'center', gap:'6px',
              padding:'5px 10px', borderRadius:'6px', textDecoration:'none',
              fontSize:'13px', fontWeight: active ? 600 : 400,
              color: active ? '#f1f5f9' : '#94a3b8',
              background: active ? '#1e293b' : 'transparent',
              transition:'all .15s',
            }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.color = '#cbd5e1' }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.color = '#94a3b8' }}
            >
              {icon}{label}
            </Link>
          )
        })}
      </nav>

      {/* Right actions */}
      <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
        {/* User menu */}
        <div ref={dropRef} style={{ position:'relative' }}>
          <button onClick={() => setDropOpen(o => !o)} style={{
            display:'flex', alignItems:'center', gap:'8px',
            background: dropOpen ? '#1e293b' : 'transparent',
            border:'1px solid', borderColor: dropOpen ? '#334155' : 'transparent',
            borderRadius:'8px', padding:'4px 8px 4px 4px', cursor:'pointer',
            transition:'all .15s',
          }}>
            <div style={{
              width:'28px', height:'28px', borderRadius:'50%',
              background:'linear-gradient(135deg,#1d6fdb,#7c3aed)',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:'11px', fontWeight:700, color:'#fff',
            }}>{initials}</div>
            <div style={{ textAlign:'left' }}>
              <div style={{ fontSize:'12px', fontWeight:600, color:'#f1f5f9', lineHeight:1.2 }}>
                {userName ?? 'User'}
              </div>
              <div style={{ fontSize:'10px', color:'#64748b', lineHeight:1.2 }}>
                {userRole ?? 'Member'}
              </div>
            </div>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2"
              style={{ transform: dropOpen ? 'rotate(180deg)' : 'none', transition:'transform .15s' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {dropOpen && (
            <div style={{
              position:'absolute', top:'calc(100% + 6px)', right:0,
              background:'#1e293b', border:'1px solid #334155', borderRadius:'10px',
              boxShadow:'0 16px 40px rgba(0,0,0,.5)', minWidth:'200px', zIndex:200,
              overflow:'hidden',
            }}>
              <div style={{ padding:'12px 14px', borderBottom:'1px solid #334155' }}>
                <div style={{ fontSize:'13px', fontWeight:600, color:'#f1f5f9' }}>{userName}</div>
                <div style={{ fontSize:'11px', color:'#64748b', marginTop:'2px' }}>{userEmail}</div>
              </div>
              <div style={{ padding:'6px' }}>
                <button onClick={handleLogout} style={{
                  width:'100%', display:'flex', alignItems:'center', gap:'8px',
                  padding:'8px 10px', borderRadius:'6px', border:'none',
                  background:'transparent', cursor:'pointer', color:'#f87171',
                  fontSize:'13px', textAlign:'left', transition:'background .15s',
                }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(248,113,113,.1)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
