import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { authService } from '../services/authService'
import { useAppStore } from '../store/useAppStore'
import { useBreakpoint } from '../utils/useBreakpoint'
import { APP_VERSION } from '../version'

export default function LoginPage() {
  const navigate = useNavigate()
  const { setAuth } = useAppStore()
  const { isMobile, isTablet } = useBreakpoint()

  const [email, setEmail]           = useState('admin@buildtakeoff.com')
  const [password, setPassword]     = useState('Admin@123')
  const [remember, setRemember]     = useState(true)
  const [loading, setLoading]       = useState(false)
  const [showPwd, setShowPwd]       = useState(false)
  const [navigating, setNavigating] = useState(false)

  useEffect(() => {
    const licenseMessage = sessionStorage.getItem('buildtakeoff-license-message')
    if (!licenseMessage) return

    sessionStorage.removeItem('buildtakeoff-license-message')
    toast.error(licenseMessage, { duration: 6000 })
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const auth = await authService.login(email, password)
      setAuth(auth.token, auth.email, auth.fullName, auth.role)
      setNavigating(true)
      toast.success(`Welcome back, ${auth.fullName}!`)
      navigate('/dashboard')
    } catch (err) {
      const code = err?.response?.data?.code
      const message = err?.response?.data?.message ?? 'Invalid email or password'
      toast.error(message, { duration: String(code ?? '').startsWith('LICENSE_') ? 6000 : 4000 })
      setLoading(false)
    }
  }

  if (navigating) return null

  /* ── Left panel — hidden completely on mobile ──────────────────────── */
  const leftPanel = !isMobile && (
    <div style={{
      flex: isTablet ? '0 0 42%' : '0 0 55%',
      position: 'relative',
      overflow: 'hidden',
      background: 'linear-gradient(145deg,#0A0E1A 0%,#100511 40%,#160008 70%,#0A0E1A 100%)',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: isTablet ? '36px 40px' : '48px 56px',
    }}>
      {/* Background grid */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `
          linear-gradient(rgba(239,35,60,.07) 1px, transparent 1px),
          linear-gradient(90deg, rgba(239,35,60,.07) 1px, transparent 1px)
        `,
        backgroundSize: '48px 48px',
        pointerEvents: 'none',
      }} />

      {/* Glow orbs */}
      <div style={{
        position: 'absolute', top: '-120px', right: '-80px',
        width: '440px', height: '440px',
        background: 'radial-gradient(circle, rgba(239,35,60,.22) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', bottom: '-80px', left: '-60px',
        width: '340px', height: '340px',
        background: 'radial-gradient(circle, rgba(217,4,41,.16) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      {/* Brand */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '46px', height: '46px', borderRadius: '10px',
            background: 'linear-gradient(135deg,#EF233C,#D90429)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 20px rgba(239,35,60,.45)', flexShrink: 0,
          }}>
            <img src="/small-logo.png" alt="BuildTakeoff Pro" style={{ width: '28px', height: '28px', objectFit: 'contain' }} />
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 800, color: '#fff', letterSpacing: '.1em', textTransform: 'uppercase' }}>
              BuildTakeoff
            </div>
            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,.4)', letterSpacing: '.12em', textTransform: 'uppercase' }}>
              Professional Platform
            </div>
          </div>
        </div>
      </div>

      {/* Headline */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{
            fontSize: isTablet ? '48px' : '62px', fontWeight: 900,
            lineHeight: 1, margin: '0 0 4px',
            color: '#FFFFFF', letterSpacing: '-2px', textTransform: 'uppercase',
          }}>
            CONSTRUCTION
          </h1>
          <h1 style={{
            fontSize: isTablet ? '48px' : '62px', fontWeight: 900,
            lineHeight: 1, margin: 0,
            color: '#EF233C', letterSpacing: '-2px', textTransform: 'uppercase',
          }}>
            ESTIMATION
          </h1>
        </div>
        <p style={{ fontSize: '15px', fontWeight: 500, color: 'rgba(255,255,255,.75)', margin: '0 0 28px', lineHeight: 1.6, maxWidth: '380px' }}>
          Professional quantity takeoff and cost estimation platform for construction projects.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {[
            { icon: '📐', text: 'PDF Measurement' },
            { icon: '⚖️', text: 'Steel Schedule' },
            { icon: '📊', text: 'Export Reports' },
            { icon: '🔧', text: 'Scale Calibration' },
          ].map(f => (
            <div key={f.text} style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '6px 13px', borderRadius: '20px',
              background: 'rgba(239,35,60,.1)', border: '1px solid rgba(239,35,60,.2)',
              fontSize: '12px', fontWeight: 500, color: 'rgba(255,255,255,.7)',
            }}>
              <span style={{ fontSize: '13px' }}>{f.icon}</span>
              {f.text}
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ width: '100%', height: '1px', background: 'rgba(255,255,255,.08)', marginBottom: '24px' }} />
        <div style={{ display: 'flex', gap: '32px' }}>
          {[
            { value: 'PDF', label: 'Quantity Takeoff' },
            { value: 'XLS/PDF', label: 'Export Ready' },
            { value: 'AS 4100', label: 'Steel Standard' },
          ].map(s => (
            <div key={s.label}>
              <div style={{ fontSize: '28px', fontWeight: 800, color: '#EF233C', lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,.45)', textTransform: 'uppercase', letterSpacing: '.06em', marginTop: '4px' }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex',
      fontFamily: "'Inter','Segoe UI',system-ui,sans-serif",
      background: '#080B12',
      overflowY: isMobile ? 'auto' : 'hidden',
    }}>
      {leftPanel}

      {/* ─── RIGHT FORM PANEL ─────────────────────────────────── */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: isMobile ? 'flex-start' : 'center',
        background: '#0B0F1A',
        padding: isMobile ? '32px 20px 40px' : isTablet ? '40px 44px' : '48px 56px',
        position: 'relative',
        overflowY: isMobile ? 'visible' : 'auto',
        minHeight: isMobile ? '100vh' : 'auto',
      }}>

        {/* Red top accent */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
          background: 'linear-gradient(90deg, #EF233C, rgba(239,35,60,.3), transparent)',
          pointerEvents: 'none',
        }} />

        <div style={{ width: '100%', maxWidth: isMobile ? '100%' : '360px' }}>

          {/* Mobile-only brand header */}
          {isMobile && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
              <div style={{
                width: '44px', height: '44px', borderRadius: '10px', flexShrink: 0,
                background: 'linear-gradient(135deg,#EF233C,#D90429)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(239,35,60,.45)',
              }}>
                <img src="/small-logo.png" alt="BuildTakeoff Pro" style={{ width: '26px', height: '26px', objectFit: 'contain' }} />
              </div>
              <div>
                <div style={{ fontSize: '16px', fontWeight: 800, color: '#fff', letterSpacing: '.04em', textTransform: 'uppercase' }}>
                  BuildTakeoff <span style={{ color: '#EF233C' }}>Pro</span>
                </div>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,.4)', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                  Construction Estimation
                </div>
              </div>
            </div>
          )}

          {/* Platform header (non-mobile) */}
          {!isMobile && (
            <div style={{ textAlign: 'center', marginBottom: '40px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginBottom: '6px' }}>
                <div style={{
                  width: '32px', height: '32px', borderRadius: '7px',
                  background: 'linear-gradient(135deg,#EF233C,#D90429)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 2px 12px rgba(239,35,60,.4)',
                }}>
                  <img src="/small-logo.png" alt="BuildTakeoff Pro" style={{ width: '20px', height: '20px', objectFit: 'contain' }} />
                </div>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: '13px', fontWeight: 800, color: '#fff', letterSpacing: '.08em', textTransform: 'uppercase', lineHeight: 1.1 }}>
                    BUILD TAKEOFF
                  </div>
                  <div style={{ fontSize: '9px', color: 'rgba(255,255,255,.35)', letterSpacing: '.12em', textTransform: 'uppercase' }}>
                    ESTIMATION PLATFORM
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Sign In heading */}
          <div style={{ marginBottom: '24px' }}>
            <h2 style={{ fontSize: isMobile ? '26px' : '30px', fontWeight: 900, margin: '0 0 6px', letterSpacing: '-0.5px' }}>
              <span style={{ color: '#fff' }}>SIGN </span>
              <span style={{ color: '#EF233C' }}>IN</span>
            </h2>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,.4)', margin: 0 }}>
              Enter your credentials to access your workspace
            </p>
            <div style={{ width: '100%', height: '1.5px', background: 'linear-gradient(90deg, #EF233C 60%, transparent)', marginTop: '16px', borderRadius: '2px' }} />
          </div>

          <form onSubmit={handleSubmit}>

            {/* Email */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '10px', fontWeight: 700, color: 'rgba(255,255,255,.5)',
                textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: '8px',
              }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
                User Name
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="e.g. admin@buildtakeoff.com"
                style={{
                  width: '100%', padding: '13px 14px',
                  background: 'rgba(255,255,255,.05)',
                  border: '1px solid rgba(255,255,255,.1)',
                  borderRadius: '8px', fontSize: '15px', color: '#fff',
                  outline: 'none', transition: 'border-color .15s, box-shadow .15s',
                  boxSizing: 'border-box',
                }}
                onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.15)' }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
              />
            </div>

            {/* Password */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '10px', fontWeight: 700, color: 'rgba(255,255,255,.5)',
                textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: '8px',
              }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                Password
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  style={{
                    width: '100%', padding: '13px 44px 13px 14px',
                    background: 'rgba(255,255,255,.05)',
                    border: '1px solid rgba(255,255,255,.1)',
                    borderRadius: '8px', fontSize: '15px', color: '#fff',
                    outline: 'none', transition: 'border-color .15s, box-shadow .15s',
                    boxSizing: 'border-box',
                  }}
                  onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.15)' }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(!showPwd)}
                  style={{
                    position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'rgba(255,255,255,.35)', padding: '4px',
                    display: 'flex', alignItems: 'center',
                  }}
                >
                  {showPwd
                    ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              </div>
            </div>

            {/* Remember me */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '28px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontSize: '14px', color: 'rgba(255,255,255,.5)' }}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={e => setRemember(e.target.checked)}
                  style={{ width: '17px', height: '17px', accentColor: '#EF233C', cursor: 'pointer' }}
                />
                Remember me
              </label>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%', padding: '15px',
                borderRadius: '8px',
                background: loading ? 'rgba(239,35,60,.4)' : 'linear-gradient(90deg,#EF233C,#D90429)',
                color: '#fff', fontWeight: 800, fontSize: '16px', border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer',
                boxShadow: loading ? 'none' : '0 4px 20px rgba(239,35,60,.45)',
                transition: 'opacity .15s, box-shadow .15s',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                letterSpacing: '.08em', textTransform: 'uppercase',
                touchAction: 'manipulation',
              }}
            >
              {loading && (
                <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
              )}
              {loading ? 'Signing in…' : 'Sign In →'}
            </button>
          </form>

          <button
            type="button"
            onClick={() => navigate('/system-settings')}
            style={{
              width: '100%',
              marginTop: '12px',
              padding: '12px',
              borderRadius: '8px',
              background: 'rgba(255,255,255,.025)',
              color: 'rgba(255,255,255,.62)',
              border: '1px solid rgba(255,255,255,.1)',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 700,
              letterSpacing: '.08em',
              textTransform: 'uppercase',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              transition: 'background .15s, color .15s, border-color .15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'rgba(239,35,60,.08)'
              e.currentTarget.style.borderColor = 'rgba(239,35,60,.32)'
              e.currentTarget.style.color = '#fff'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'rgba(255,255,255,.025)'
              e.currentTarget.style.borderColor = 'rgba(255,255,255,.1)'
              e.currentTarget.style.color = 'rgba(255,255,255,.62)'
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.1.4.3.8.6 1 .3.3.7.4 1.1.4h.1v4h-.1c-.4 0-.8.1-1.1.4-.3.2-.5.6-.6 1.2Z"/>
            </svg>
            System Settings
          </button>

          {/* Demo credentials */}
          {/* <div style={{
            marginTop: '24px', padding: '14px 16px',
            background: 'rgba(239,35,60,.06)',
            borderRadius: '8px', border: '1px solid rgba(239,35,60,.15)',
          }}>
            <p style={{ fontSize: '10px', fontWeight: 800, color: '#EF233C', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '.08em' }}>
              Demo Credentials
            </p>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,.5)', margin: '0 0 3px' }}>
              <span style={{ color: 'rgba(255,255,255,.3)' }}>Email:</span> admin@buildtakeoff.com
            </p>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,.5)', margin: 0 }}>
              <span style={{ color: 'rgba(255,255,255,.3)' }}>Password:</span> Admin@123
            </p>
          </div> */}

          <p style={{ textAlign: 'center', color: 'rgba(255,255,255,.2)', fontSize: '11px', marginTop: '24px' }}>
            © 2026 BuildTakeoff Pro. All rights reserved. · <span style={{ color: '#EF233C', fontWeight: 700 }}>v{APP_VERSION}</span>
          </p>
        </div>
      </div>
    </div>
  )
}
