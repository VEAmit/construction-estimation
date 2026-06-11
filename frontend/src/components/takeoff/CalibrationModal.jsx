import { useState } from 'react'
import { computeScaleRatio, getUnitLabel, convertFromMm } from '../../utils/calculations'

const UNITS = ['Mm', 'Cm', 'Meter', 'Feet', 'Inch']

const UNIT_EXAMPLES = {
  Mm:    { label: 'mm', example: 'e.g. 6000' },
  Cm:    { label: 'cm', example: 'e.g. 600' },
  Meter: { label: 'm',  example: 'e.g. 6' },
  Feet:  { label: 'ft', example: 'e.g. 20' },
  Inch:  { label: 'in', example: 'e.g. 240' },
}

export default function CalibrationModal({ pixelLength, onApply, onClose, saving }) {
  const [len,  setLen]  = useState('')
  const [unit, setUnit] = useState('Meter')

  const scaleRatio = (len && +len > 0 && pixelLength)
    ? computeScaleRatio(+len, unit, pixelLength)
    : null

  // Human-readable scale: "1 px = X [unit]"
  const humanScale = scaleRatio != null
    ? (() => {
        const val = convertFromMm(scaleRatio, unit)
        const u   = getUnitLabel(unit)
        if (val >= 0.001) return `1 px = ${val >= 100 ? val.toFixed(1) : val >= 10 ? val.toFixed(2) : val.toFixed(4)} ${u}`
        const inv = 1 / val
        return `${inv.toFixed(1)} px = 1 ${u}`
      })()
    : null

  const canApply = !saving && !!len && +len > 0 && pixelLength > 0

  const apply = () => { if (canApply) onApply(+len, unit) }

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
        borderRadius: '14px', width: '460px',
        boxShadow: '0 32px 90px rgba(0,0,0,.85)',
        overflow: 'hidden', animation: 'fadeUp .18s ease-out',
      }}>

        {/* ── Header ── */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255,255,255,.07)',
          background: 'linear-gradient(135deg,#0D1526,#111827)',
          display: 'flex', alignItems: 'center', gap: '12px',
        }}>
          <div style={{
            width: '40px', height: '40px', borderRadius: '10px', flexShrink: 0,
            background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2">
              <path d="M2 12h3M19 12h3M12 2v3M12 19v3"/>
              <circle cx="12" cy="12" r="5"/>
              <line x1="5" y1="19" x2="8.5" y2="15.5" strokeWidth="1.5"/>
              <line x1="19" y1="5" x2="15.5" y2="8.5" strokeWidth="1.5"/>
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontSize: '15px', fontWeight: 800, color: '#f1f5f9', margin: 0 }}>
              Enter Actual Dimension
            </h2>
            <p style={{ fontSize: '11px', color: '#64748b', marginTop: '3px' }}>
              What is the real-world length of the line you just drew?
            </p>
          </div>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)',
            color: '#64748b', cursor: 'pointer', padding: '5px', borderRadius: '6px',
            display: 'flex', alignItems: 'center',
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div style={{ padding: '20px' }}>

          {/* ── Step indicator ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px' }}>
            {[
              { n: '✓', label: 'Drew reference line', done: true },
              { n: '2', label: 'Enter real dimension', done: false, active: true },
              { n: '3', label: 'Scale saved',          done: false },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: i < 2 ? 1 : 'none' }}>
                <div style={{
                  width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '10px', fontWeight: 800,
                  background: s.done ? '#22c55e' : s.active ? 'rgba(245,158,11,.15)' : 'rgba(255,255,255,.04)',
                  border: `1px solid ${s.done ? '#22c55e' : s.active ? 'rgba(245,158,11,.5)' : 'rgba(255,255,255,.08)'}`,
                  color: s.done ? '#fff' : s.active ? '#F59E0B' : '#475569',
                }}>
                  {s.done ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg> : s.n}
                </div>
                <span style={{ fontSize: '10px', color: s.done ? '#22c55e' : s.active ? '#fbbf24' : '#334155', whiteSpace: 'nowrap' }}>
                  {s.label}
                </span>
                {i < 2 && <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,.06)' }} />}
              </div>
            ))}
          </div>

          {/* ── Drawn line info badge ── */}
          <div style={{
            background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.15)',
            borderRadius: '9px', padding: '10px 14px', marginBottom: '18px',
            display: 'flex', alignItems: 'center', gap: '12px',
          }}>
            <div style={{
              width: '34px', height: '34px', borderRadius: '7px', flexShrink: 0,
              background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2">
                <line x1="5" y1="19" x2="19" y2="5"/>
                <circle cx="5" cy="19" r="2" fill="#F59E0B"/>
                <circle cx="19" cy="5" r="2" fill="#F59E0B"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: '10px', color: '#475569', marginBottom: '2px' }}>
                Reference line drawn on drawing
              </div>
              <div style={{ fontSize: '19px', fontWeight: 800, color: '#F59E0B', lineHeight: 1.1 }}>
                {Math.round(pixelLength ?? 0)}
                <span style={{ fontSize: '11px', fontWeight: 400, color: '#475569', marginLeft: '5px' }}>pixels</span>
              </div>
            </div>
            <div style={{ marginLeft: 'auto', fontSize: '10px', color: '#334155', textAlign: 'right', lineHeight: 1.5 }}>
              Now tell the system<br/>what this equals
            </div>
          </div>

          {/* ── Unit selector (toggle buttons) ── */}
          <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: '7px' }}>
              Unit
            </div>
            <div style={{ display: 'flex', gap: '5px' }}>
              {UNITS.map(u => (
                <button
                  key={u}
                  onClick={() => setUnit(u)}
                  style={{
                    flex: 1, padding: '7px 4px', borderRadius: '7px',
                    fontSize: '12px', fontWeight: unit === u ? 800 : 400,
                    cursor: 'pointer',
                    border: `1px solid ${unit === u ? 'rgba(245,158,11,.5)' : 'rgba(255,255,255,.08)'}`,
                    background: unit === u ? 'rgba(245,158,11,.12)' : 'rgba(255,255,255,.03)',
                    color: unit === u ? '#F59E0B' : '#64748b',
                    transition: 'all .12s',
                  }}
                >
                  {getUnitLabel(u)}
                </button>
              ))}
            </div>
          </div>

          {/* ── Dimension input ── */}
          <div style={{ marginBottom: '14px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: '6px' }}>
              Actual length in {getUnitLabel(unit)}
            </div>
            <div style={{ position: 'relative' }}>
              <input
                value={len}
                onChange={e => setLen(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && apply()}
                type="number" min="0" step="any"
                placeholder={UNIT_EXAMPLES[unit]?.example ?? 'e.g. 6'}
                autoFocus
                style={{
                  width: '100%', padding: '13px 52px 13px 14px',
                  background: 'rgba(255,255,255,.04)',
                  border: '1px solid rgba(255,255,255,.1)',
                  borderRadius: '9px', fontSize: '20px', fontWeight: 700,
                  color: '#f1f5f9', outline: 'none',
                  transition: 'border-color .15s, box-shadow .15s',
                  boxSizing: 'border-box',
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
          </div>

          {/* ── Scale preview ── */}
          {humanScale ? (
            <div style={{
              background: 'rgba(34,197,94,.06)', border: '1px solid rgba(34,197,94,.2)',
              borderRadius: '8px', padding: '10px 14px', marginBottom: '18px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '3px' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span style={{ fontSize: '11px', color: '#22c55e', fontWeight: 700 }}>Scale calculated</span>
              </div>
              <div style={{ fontSize: '14px', fontWeight: 800, color: '#f1f5f9', paddingLeft: '19px' }}>
                {humanScale}
              </div>
              <div style={{ fontSize: '10px', color: '#334155', paddingLeft: '19px', marginTop: '2px' }}>
                All measurements will use this scale automatically
              </div>
            </div>
          ) : (
            <div style={{
              background: 'rgba(255,255,255,.02)', border: '1px dashed rgba(255,255,255,.06)',
              borderRadius: '8px', padding: '10px 14px', marginBottom: '18px',
              fontSize: '11px', color: '#334155', textAlign: 'center',
            }}>
              Enter a dimension above to preview the scale
            </div>
          )}

          {/* ── Buttons ── */}
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={{
              padding: '10px 18px', borderRadius: '8px',
              border: '1px solid rgba(255,255,255,.1)', background: 'transparent',
              color: '#94a3b8', fontSize: '13px', cursor: 'pointer',
            }}>
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={!canApply}
              style={{
                padding: '10px 24px', borderRadius: '8px', border: 'none',
                background: canApply ? 'linear-gradient(90deg,#EF233C,#D90429)' : 'rgba(255,255,255,.04)',
                color: canApply ? '#fff' : '#334155',
                fontSize: '13px', fontWeight: 700,
                cursor: canApply ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', gap: '7px',
                boxShadow: canApply ? '0 4px 14px rgba(239,35,60,.35)' : 'none',
                transition: 'all .15s',
              }}
            >
              {saving && (
                <svg className="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
              )}
              {saving ? 'Saving…' : 'Set Scale'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
