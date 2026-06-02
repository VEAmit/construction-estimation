import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { authService } from '../services/authService'
import { useAppStore } from '../store/useAppStore'

export default function LoginPage() {
  const navigate = useNavigate()
  const { setAuth } = useAppStore()
  const [email, setEmail]         = useState('admin@buildtakeoff.com')
  const [password, setPassword]   = useState('Admin@123')
  const [remember, setRemember]   = useState(true)
  const [loading, setLoading]     = useState(false)
  const [showPwd, setShowPwd]     = useState(false)
  const [navigating, setNavigating] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const auth = await authService.login(email, password)
      setAuth(auth.token, auth.email, auth.fullName, auth.role)
      // Hide this page IMMEDIATELY — its position:fixed container stays in the
      // DOM for one render cycle after navigate() is called, covering the dashboard.
      setNavigating(true)
      toast.success(`Welcome back, ${auth.fullName}!`)
      navigate('/dashboard')
    } catch (err) {
      toast.error(err?.response?.data?.message ?? 'Invalid email or password')
      setLoading(false)
    }
  }

  // Return nothing while transitioning — removes the fixed viewport overlay instantly
  if (navigating) return null

  return (
    /* Full-viewport container — position:fixed guarantees centering regardless of #root */
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg,#0d1b3e 0%,#1a3a6b 50%,#0d2147 100%)',
      fontFamily: "'Inter','Segoe UI',system-ui,sans-serif",
      overflow: 'auto',
      padding: '24px',
    }}>

      {/* Decorative blobs */}
      <div style={{ position:'absolute', top:'-80px', right:'-80px', width:'360px', height:'360px',
        background:'rgba(29,111,219,.18)', borderRadius:'50%', filter:'blur(60px)' }} />
      <div style={{ position:'absolute', bottom:'-60px', left:'-60px', width:'280px', height:'280px',
        background:'rgba(29,111,219,.12)', borderRadius:'50%', filter:'blur(50px)' }} />

      <div style={{ width:'100%', maxWidth:'420px', position:'relative', zIndex:1 }}>

        {/* Brand */}
        <div style={{ textAlign:'center', marginBottom:'32px' }}>
          <div style={{ display:'inline-flex', alignItems:'center', justifyContent:'center',
            width:'64px', height:'64px', borderRadius:'16px',
            background:'linear-gradient(135deg,#1d6fdb,#0d47a1)',
            boxShadow:'0 8px 24px rgba(29,111,219,.4)', marginBottom:'16px' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </div>
          <h1 style={{ color:'#fff', fontSize:'26px', fontWeight:700, letterSpacing:'-0.5px', margin:0 }}>
            BuildTakeoff Pro
          </h1>
          <p style={{ color:'rgba(255,255,255,.55)', fontSize:'13px', marginTop:'6px' }}>
            Construction Estimation Platform
          </p>
        </div>

        {/* Card */}
        <div style={{
          background:'#fff', borderRadius:'16px',
          boxShadow:'0 24px 60px rgba(0,0,0,.35)',
          padding:'36px 36px 28px',
        }}>
          <h2 style={{ fontSize:'20px', fontWeight:700, color:'#1e293b', margin:'0 0 4px' }}>
            Sign In
          </h2>
          <p style={{ fontSize:'13px', color:'#64748b', margin:'0 0 24px' }}>
            Enter your credentials to access the platform
          </p>

          <form onSubmit={handleSubmit}>
            {/* Email */}
            <div style={{ marginBottom:'16px' }}>
              <label style={{ display:'block', fontSize:'12px', fontWeight:600,
                color:'#374151', marginBottom:'6px', textTransform:'uppercase', letterSpacing:'.05em' }}>
                Email Address
              </label>
              <div style={{ position:'relative' }}>
                <span style={{ position:'absolute', left:'12px', top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,12 2,6"/></svg>
                </span>
                <input
                  type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  required placeholder="admin@buildtakeoff.com"
                  style={{ width:'100%', padding:'10px 12px 10px 38px', border:'1.5px solid #e2e8f0',
                    borderRadius:'8px', fontSize:'14px', color:'#1e293b', outline:'none',
                    transition:'border-color .15s', boxSizing:'border-box' }}
                  onFocus={(e) => e.target.style.borderColor='#1d6fdb'}
                  onBlur={(e) => e.target.style.borderColor='#e2e8f0'}
                />
              </div>
            </div>

            {/* Password */}
            <div style={{ marginBottom:'20px' }}>
              <label style={{ display:'block', fontSize:'12px', fontWeight:600,
                color:'#374151', marginBottom:'6px', textTransform:'uppercase', letterSpacing:'.05em' }}>
                Password
              </label>
              <div style={{ position:'relative' }}>
                <span style={{ position:'absolute', left:'12px', top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </span>
                <input
                  type={showPwd ? 'text' : 'password'} value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required placeholder="••••••••"
                  style={{ width:'100%', padding:'10px 40px 10px 38px', border:'1.5px solid #e2e8f0',
                    borderRadius:'8px', fontSize:'14px', color:'#1e293b', outline:'none',
                    transition:'border-color .15s', boxSizing:'border-box' }}
                  onFocus={(e) => e.target.style.borderColor='#1d6fdb'}
                  onBlur={(e) => e.target.style.borderColor='#e2e8f0'}
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)}
                  style={{ position:'absolute', right:'12px', top:'50%', transform:'translateY(-50%)',
                    background:'none', border:'none', cursor:'pointer', color:'#9ca3af', padding:0 }}>
                  {showPwd
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                </button>
              </div>
            </div>

            {/* Remember + Forgot */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'24px' }}>
              <label style={{ display:'flex', alignItems:'center', gap:'8px', cursor:'pointer', fontSize:'13px', color:'#4b5563' }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
                  style={{ width:'15px', height:'15px', accentColor:'#1d6fdb' }} />
                Remember me
              </label>
              <button type="button" style={{ background:'none', border:'none', color:'#1d6fdb',
                fontSize:'13px', fontWeight:500, cursor:'pointer' }}>
                Forgot password?
              </button>
            </div>

            {/* Submit */}
            <button type="submit" disabled={loading}
              style={{ width:'100%', padding:'12px', borderRadius:'8px',
                background: loading ? '#93c5fd' : 'linear-gradient(90deg,#1d6fdb,#1558b0)',
                color:'#fff', fontWeight:700, fontSize:'15px', border:'none', cursor: loading ? 'not-allowed' : 'pointer',
                boxShadow:'0 4px 14px rgba(29,111,219,.35)', transition:'opacity .15s',
                display:'flex', alignItems:'center', justifyContent:'center', gap:'8px' }}>
              {loading && (
                <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
              )}
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          {/* Demo credentials */}
          <div style={{ marginTop:'20px', padding:'12px 14px', background:'#f0f7ff',
            borderRadius:'8px', border:'1px solid #bfdbfe' }}>
            <p style={{ fontSize:'11px', fontWeight:700, color:'#1d6fdb', marginBottom:'4px', textTransform:'uppercase', letterSpacing:'.05em' }}>
              Demo Credentials
            </p>
            <p style={{ fontSize:'12px', color:'#374151', margin:0 }}>
              <strong>Email:</strong> admin@buildtakeoff.com
            </p>
            <p style={{ fontSize:'12px', color:'#374151', margin:0 }}>
              <strong>Password:</strong> Admin@123
            </p>
          </div>
        </div>

        <p style={{ textAlign:'center', color:'rgba(255,255,255,.35)', fontSize:'11px', marginTop:'20px' }}>
          © 2026 BuildTakeoff Pro. All rights reserved.
        </p>
      </div>
    </div>
  )
}
