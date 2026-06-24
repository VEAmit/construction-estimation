import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * App-styled confirmation dialog — replaces native window.confirm().
 * Rendered via portal so it centers on the viewport (not inside transformed sidebars).
 */
export default function ConfirmModal({
  open,
  title = 'Confirm',
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  loading = false,
  danger = true,
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.()
      if (e.key === 'Enter' && !loading) onConfirm?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, loading, onConfirm, onCancel])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  const accent = danger ? '#EF233C' : '#3b82f6'
  const accentBg = danger ? 'rgba(239,35,60,.12)' : 'rgba(59,130,246,.12)'
  const accentBorder = danger ? 'rgba(239,35,60,.25)' : 'rgba(59,130,246,.25)'

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onClick={e => e.target === e.currentTarget && !loading && onCancel?.()}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        margin: 0,
        padding: '16px',
        boxSizing: 'border-box',
        background: 'rgba(0,0,0,.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div style={{
        background: '#111827',
        border: `1px solid ${accentBorder}`,
        borderRadius: '14px', width: '420px', maxWidth: '100%',
        boxShadow: '0 32px 90px rgba(0,0,0,.85)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '18px 20px',
          borderBottom: '1px solid rgba(255,255,255,.07)',
          background: 'linear-gradient(135deg,#0D1526,#111827)',
          display: 'flex', alignItems: 'flex-start', gap: '12px',
        }}>
          <div style={{
            width: '40px', height: '40px', borderRadius: '10px', flexShrink: 0,
            background: accentBg, border: `1px solid ${accentBorder}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="confirm-modal-title" style={{ fontSize: '16px', fontWeight: 800, color: '#f1f5f9', margin: 0 }}>
              {title}
            </h2>
            {message && (
              <p style={{
                fontSize: '13px', color: '#94a3b8', marginTop: '8px', marginBottom: 0,
                lineHeight: 1.55, wordBreak: 'break-word',
              }}>
                {message}
              </p>
            )}
          </div>
        </div>

        <div style={{
          padding: '14px 20px 18px',
          display: 'flex', gap: '10px', justifyContent: 'flex-end',
          background: 'rgba(0,0,0,.15)',
        }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            style={{
              padding: '10px 20px', borderRadius: '8px',
              border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.04)',
              color: '#cbd5e1', fontSize: '13px', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1, minWidth: '88px',
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            style={{
              padding: '10px 20px', borderRadius: '8px', border: 'none',
              background: loading ? 'rgba(239,35,60,.5)' : `linear-gradient(90deg,${accent},${danger ? '#D90429' : '#2563eb'})`,
              color: '#fff', fontSize: '13px', fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              minWidth: '88px',
              boxShadow: loading ? 'none' : `0 4px 14px ${danger ? 'rgba(239,35,60,.35)' : 'rgba(59,130,246,.35)'}`,
            }}
          >
            {loading ? 'Please wait…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
