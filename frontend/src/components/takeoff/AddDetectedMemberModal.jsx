import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '11px 12px',
  borderRadius: '8px',
  border: '1px solid rgba(255,255,255,.12)',
  background: '#0B1220',
  color: '#f1f5f9',
  fontSize: '13px',
  outline: 'none',
}

function FieldLabel({ children }) {
  return (
    <label style={{
      display: 'block', marginBottom: '6px', color: '#94a3b8',
      fontSize: '10px', fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase',
    }}>
      {children}
    </label>
  )
}

export default function AddDetectedMemberModal({
  detectedValue,
  color = '#3B82F6',
  saving = false,
  error = '',
  onAdd,
  onCancel,
}) {
  const [mark, setMark] = useState(detectedValue ?? '')
  const [sectionSize, setSectionSize] = useState(detectedValue ?? '')
  const [validationError, setValidationError] = useState('')

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && !saving) onCancel?.()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel, saving])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  const handleSubmit = event => {
    event.preventDefault()
    const nextMark = mark.trim()
    const nextSectionSize = sectionSize.trim()
    if (!nextMark || !nextSectionSize) {
      setValidationError('Mark and Section Size are required.')
      return
    }
    setValidationError('')
    onAdd?.({ mark: nextMark, sectionSize: nextSectionSize })
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="detected-member-title"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !saving) onCancel?.()
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10020,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px', boxSizing: 'border-box',
        background: 'rgba(0,0,0,.82)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: '440px', maxWidth: '100%', overflow: 'hidden',
          borderRadius: '14px', border: '1px solid rgba(239,35,60,.28)',
          background: '#111827', boxShadow: '0 32px 90px rgba(0,0,0,.85)',
        }}
      >
        <div style={{
          padding: '18px 20px', display: 'flex', gap: '12px', alignItems: 'flex-start',
          borderBottom: '1px solid rgba(255,255,255,.07)',
          background: 'linear-gradient(135deg,#0D1526,#111827)',
        }}>
          <div style={{
            width: '40px', height: '40px', borderRadius: '10px', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#EF233C', fontSize: '25px', fontWeight: 300,
            background: 'rgba(239,35,60,.12)', border: '1px solid rgba(239,35,60,.25)',
          }}>
            +
          </div>
          <div>
            <h2 id="detected-member-title" style={{ margin: 0, color: '#f1f5f9', fontSize: '16px', fontWeight: 800 }}>
              Do you want to add this item to the schedule?
            </h2>
            <p style={{ margin: '7px 0 0', color: '#94a3b8', fontSize: '12px', lineHeight: 1.5 }}>
              This detected item is not in the Project Member Schedule. You can edit its details before adding it.
            </p>
          </div>
        </div>

        <div style={{ padding: '18px 20px 10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <FieldLabel>Mark</FieldLabel>
              <input
                autoFocus
                value={mark}
                onChange={event => setMark(event.target.value)}
                disabled={saving}
                style={inputStyle}
                onFocus={event => { event.currentTarget.style.borderColor = '#EF233C' }}
                onBlur={event => { event.currentTarget.style.borderColor = 'rgba(255,255,255,.12)' }}
              />
            </div>
            <div>
              <FieldLabel>Section Size</FieldLabel>
              <input
                value={sectionSize}
                onChange={event => setSectionSize(event.target.value)}
                disabled={saving}
                style={inputStyle}
                onFocus={event => { event.currentTarget.style.borderColor = '#EF233C' }}
                onBlur={event => { event.currentTarget.style.borderColor = 'rgba(255,255,255,.12)' }}
              />
            </div>
          </div>

          <div style={{
            marginTop: '14px', padding: '10px 12px', borderRadius: '8px',
            display: 'flex', alignItems: 'center', gap: '10px',
            color: '#94a3b8', fontSize: '12px',
            background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.07)',
          }}>
            <span style={{
              width: '22px', height: '22px', borderRadius: '6px', flexShrink: 0,
              background: color, border: '1px solid rgba(255,255,255,.3)',
              boxShadow: `0 0 12px ${color}55`,
            }} />
            <span><strong style={{ color: '#cbd5e1' }}>Color:</strong> Automatically assigned default color</span>
          </div>

          {(validationError || error) && (
            <div style={{ marginTop: '12px', color: '#fda4af', fontSize: '12px' }}>
              {validationError || error}
            </div>
          )}
        </div>

        <div style={{
          padding: '14px 20px 18px', display: 'flex', justifyContent: 'flex-end', gap: '10px',
          background: 'rgba(0,0,0,.15)',
        }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            style={{
              minWidth: '88px', padding: '10px 18px', borderRadius: '8px',
              border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.04)',
              color: '#cbd5e1', fontSize: '13px', fontWeight: 700,
              cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? .6 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            style={{
              minWidth: '150px', padding: '10px 18px', border: 0, borderRadius: '8px',
              background: saving ? 'rgba(239,35,60,.5)' : 'linear-gradient(90deg,#EF233C,#D90429)',
              color: '#fff', fontSize: '13px', fontWeight: 800,
              cursor: saving ? 'not-allowed' : 'pointer',
              boxShadow: saving ? 'none' : '0 4px 14px rgba(239,35,60,.35)',
            }}
          >
            {saving ? 'Adding…' : 'Add to Schedule'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
