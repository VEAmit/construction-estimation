import { useState } from 'react'
import { getUnitLabel } from '../../utils/calculations'

const UNITS = ['Mm', 'Cm', 'Meter', 'Feet', 'Inch']

const UNIT_HINTS = {
  Mm:    { label: 'mm', placeholder: '6000', hint: 'e.g. a wall labelled 6000 mm' },
  Cm:    { label: 'cm', placeholder: '600',  hint: 'e.g. a door width of 90 cm' },
  Meter: { label: 'm',  placeholder: '6',    hint: 'e.g. a room span of 6 m' },
  Feet:  { label: 'ft', placeholder: '20',   hint: 'e.g. a wall marked 20 ft' },
  Inch:  { label: 'in', placeholder: '240',  hint: 'e.g. 20 ft shown as 240 in' },
}

/**
 * One-time scale setup — pixel length is used internally only, never shown to users.
 */
export default function CalibrationModal({
  defaultUnit = 'Mm',
  onApply,
  onClose,
  saving,
  isFirstMeasure = false,
}) {
  const [len,  setLen]  = useState('')
  const [unit, setUnit] = useState(defaultUnit)

  const canApply = !saving && !!len && +len > 0
  const apply = () => { if (canApply) onApply(+len, unit) }
  const hint = UNIT_HINTS[unit]

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,.82)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, backdropFilter: 'blur(6px)',
      }}
    >
      <div style={{
        background: '#111827',
        border: '1px solid rgba(245,158,11,.25)',
        borderRadius: '14px', width: '480px', maxWidth: 'calc(100vw - 32px)',
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
            background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2">
              <path d="M2 12h3M19 12h3M12 2v3M12 19v3"/>
              <circle cx="12" cy="12" r="5"/>
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontSize: '16px', fontWeight: 800, color: '#f1f5f9', margin: 0 }}>
              {isFirstMeasure ? 'One-time scale setup' : 'Set drawing scale'}
            </h2>
            <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '6px', lineHeight: 1.5 }}>
              {isFirstMeasure
                ? 'You drew along a dimension on the plan. Enter the real-world length shown on the drawing (from a wall label, grid dimension, or door size).'
                : 'Enter the real-world length of the reference line you drew on a labelled dimension.'}
            </p>
          </div>
          <button onClick={onClose} type="button" aria-label="Close" style={{
            background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)',
            color: '#64748b', cursor: 'pointer', padding: '5px', borderRadius: '6px',
            display: 'flex', alignItems: 'center', flexShrink: 0,
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div style={{ padding: '20px' }}>

          <div style={{
            background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.15)',
            borderRadius: '9px', padding: '12px 14px', marginBottom: '18px',
            fontSize: '12px', color: '#cbd5e1', lineHeight: 1.55,
          }}>
            <strong style={{ color: '#F59E0B' }}>Tip:</strong> Look for numbers already printed on the plan
            (e.g. <span style={{ color: '#f1f5f9' }}>6000</span>, <span style={{ color: '#f1f5f9' }}>3.600</span>, or <span style={{ color: '#f1f5f9' }}>20&apos;-0&quot;</span>).
            Draw your line along that same dimension, then type that value below.
          </div>

          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: '7px' }}>
              Unit
            </div>
            <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
              {UNITS.map(u => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUnit(u)}
                  style={{
                    flex: '1 1 52px', padding: '7px 4px', borderRadius: '7px',
                    fontSize: '12px', fontWeight: unit === u ? 800 : 400,
                    cursor: 'pointer',
                    border: `1px solid ${unit === u ? 'rgba(245,158,11,.5)' : 'rgba(255,255,255,.08)'}`,
                    background: unit === u ? 'rgba(245,158,11,.12)' : 'rgba(255,255,255,.03)',
                    color: unit === u ? '#F59E0B' : '#64748b',
                  }}
                >
                  {getUnitLabel(u)}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: '6px' }}>
              Length on drawing ({getUnitLabel(unit)})
            </div>
            <div style={{ position: 'relative' }}>
              <input
                value={len}
                onChange={e => setLen(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && apply()}
                type="number" min="0" step="any"
                placeholder={hint?.placeholder ?? 'Enter length'}
                autoFocus
                style={{
                  width: '100%', padding: '13px 52px 13px 14px',
                  background: 'rgba(255,255,255,.04)',
                  border: '1px solid rgba(255,255,255,.1)',
                  borderRadius: '9px', fontSize: '20px', fontWeight: 700,
                  color: '#f1f5f9', outline: 'none', boxSizing: 'border-box',
                }}
                onFocus={e => { e.target.style.borderColor = '#F59E0B'; e.target.style.boxShadow = '0 0 0 3px rgba(245,158,11,.12)' }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
              />
              <span style={{
                position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)',
                fontSize: '14px', fontWeight: 700, color: '#F59E0B', pointerEvents: 'none',
              }}>
                {getUnitLabel(unit)}
              </span>
            </div>
            {hint?.hint && (
              <div style={{ fontSize: '11px', color: '#64748b', marginTop: '6px' }}>
                {hint.hint}
              </div>
            )}
          </div>

          <div style={{
            background: 'rgba(255,255,255,.02)', border: '1px dashed rgba(255,255,255,.08)',
            borderRadius: '8px', padding: '10px 14px', marginBottom: '18px',
            fontSize: '11px', color: '#64748b', textAlign: 'center', lineHeight: 1.5,
          }}>
            You only need to do this once per drawing. After that, all measurements show automatically.
          </div>

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={{
              padding: '10px 18px', borderRadius: '8px',
              border: '1px solid rgba(255,255,255,.1)', background: 'transparent',
              color: '#94a3b8', fontSize: '13px', cursor: 'pointer',
            }}>
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={!canApply}
              style={{
                padding: '10px 24px', borderRadius: '8px', border: 'none',
                background: canApply ? 'linear-gradient(90deg,#EF233C,#D90429)' : 'rgba(255,255,255,.04)',
                color: canApply ? '#fff' : '#334155',
                fontSize: '13px', fontWeight: 700,
                cursor: canApply ? 'pointer' : 'not-allowed',
              }}
            >
              {saving ? 'Saving…' : isFirstMeasure ? 'Save & continue measuring' : 'Confirm scale'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
