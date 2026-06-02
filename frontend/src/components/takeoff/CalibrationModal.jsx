import { useState } from 'react'
import { computeScaleRatio, getUnitLabel } from '../../utils/calculations'

const UNITS = ['Mm', 'Cm', 'Meter', 'Feet', 'Inch']

export default function CalibrationModal({ pixelLength, onApply, onClose, saving }) {
  const [len,  setLen]  = useState('')
  const [unit, setUnit] = useState('Meter')

  const scaleRatio = (len && +len > 0 && pixelLength)
    ? computeScaleRatio(+len, unit, pixelLength)
    : null

  const canApply = !saving && !!len && +len > 0 && pixelLength > 0

  const apply = () => { if (canApply) onApply(+len, unit) }

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position:'fixed', inset:0,
        background:'rgba(0,0,0,.72)',
        display:'flex', alignItems:'center', justifyContent:'center',
        zIndex:1000, backdropFilter:'blur(5px)',
      }}
    >
      <div style={{
        background:'#0f172a',
        border:'1px solid rgba(245,158,11,.25)',
        borderRadius:'14px', width:'440px',
        boxShadow:'0 32px 90px rgba(0,0,0,.7)',
        overflow:'hidden', animation:'fadeUp .18s ease-out',
      }}>

        {/* ── Header ── */}
        <div style={{
          padding:'16px 20px',
          borderBottom:'1px solid #1e293b',
          background:'linear-gradient(135deg,#1a1200,#0d0f00)',
          display:'flex', alignItems:'center', gap:'12px',
        }}>
          <div style={{
            width:'38px', height:'38px', borderRadius:'9px', flexShrink:0,
            background:'rgba(245,158,11,.12)', border:'1px solid rgba(245,158,11,.25)',
            display:'flex', alignItems:'center', justifyContent:'center',
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2">
              <path d="M3 12h3m12 0h3M12 3v3m0 12v3"/>
              <circle cx="12" cy="12" r="4"/>
              <path d="M8 8l2 2m4 4l2 2M8 16l2-2m4-4l2-2"/>
            </svg>
          </div>
          <div style={{ flex:1 }}>
            <h2 style={{ fontSize:'15px', fontWeight:700, color:'#f1f5f9', margin:0 }}>
              Set Drawing Scale
            </h2>
            <p style={{ fontSize:'11px', color:'#64748b', marginTop:'3px' }}>
              Enter the real-world distance for the line you just drew
            </p>
          </div>
          <button onClick={onClose} style={{
            background:'none', border:'none', color:'#475569',
            cursor:'pointer', padding:'4px', borderRadius:'5px',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div style={{ padding:'20px' }}>

          {/* ── Drawn line info ── */}
          <div style={{
            background:'rgba(245,158,11,.06)', border:'1px solid rgba(245,158,11,.15)',
            borderRadius:'9px', padding:'12px 14px', marginBottom:'18px',
            display:'flex', alignItems:'center', gap:'12px',
          }}>
            <div style={{
              width:'36px', height:'36px', borderRadius:'7px', flexShrink:0,
              background:'rgba(245,158,11,.1)', border:'1px solid rgba(245,158,11,.2)',
              display:'flex', alignItems:'center', justifyContent:'center',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2">
                <line x1="5" y1="19" x2="19" y2="5"/>
                <circle cx="5" cy="19" r="2" fill="#f59e0b"/>
                <circle cx="19" cy="5" r="2" fill="#f59e0b"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize:'10px', color:'#64748b', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:'2px' }}>
                Calibration line drawn
              </div>
              <div style={{ fontSize:'20px', fontWeight:700, color:'#f59e0b', lineHeight:1.1 }}>
                {Math.round(pixelLength ?? 0)}
                <span style={{ fontSize:'12px', fontWeight:400, color:'#64748b', marginLeft:'5px' }}>
                  drawing units
                </span>
              </div>
            </div>
          </div>

          {/* ── Distance input ── */}
          <label style={{
            display:'block', fontSize:'11px', fontWeight:600,
            color:'#64748b', textTransform:'uppercase',
            letterSpacing:'.05em', marginBottom:'6px',
          }}>
            Real-world length of this line
          </label>
          <div style={{ display:'flex', gap:'8px', marginBottom:'10px' }}>
            <input
              value={len}
              onChange={e => setLen(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && apply()}
              type="number" min="0" step="any"
              placeholder="e.g. 5.0"
              autoFocus
              style={{
                flex:1, padding:'11px 12px',
                background:'#1e293b', border:'1px solid #334155',
                borderRadius:'8px', fontSize:'16px',
                color:'#f1f5f9', outline:'none',
              }}
            />
            <select
              value={unit}
              onChange={e => setUnit(e.target.value)}
              style={{
                padding:'11px 12px',
                background:'#1e293b', border:'1px solid #334155',
                borderRadius:'8px', fontSize:'13px',
                color:'#f1f5f9', outline:'none', cursor:'pointer',
              }}
            >
              {UNITS.map(u => <option key={u} value={u}>{getUnitLabel(u)}</option>)}
            </select>
          </div>

          {/* ── Scale preview ── */}
          {scaleRatio != null ? (
            <div style={{
              background:'rgba(34,197,94,.06)', border:'1px solid rgba(34,197,94,.2)',
              borderRadius:'7px', padding:'9px 12px', marginBottom:'18px',
              display:'flex', alignItems:'center', gap:'8px',
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span style={{ fontSize:'12px', color:'#22c55e', fontWeight:600 }}>
                Scale: {scaleRatio.toFixed(4)} mm / drawing unit
              </span>
              <span style={{ fontSize:'10px', color:'#475569', marginLeft:'auto' }}>
                All future measurements will use this scale
              </span>
            </div>
          ) : (
            <div style={{ height:'42px', marginBottom:'18px' }} />
          )}

          {/* ── Buttons ── */}
          <div style={{ display:'flex', gap:'10px', justifyContent:'flex-end' }}>
            <button onClick={onClose} style={{
              padding:'9px 18px', borderRadius:'7px',
              border:'1px solid #334155', background:'transparent',
              color:'#94a3b8', fontSize:'13px', cursor:'pointer',
            }}>
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={!canApply}
              style={{
                padding:'9px 22px', borderRadius:'7px', border:'none',
                background: canApply
                  ? 'linear-gradient(90deg,#d97706,#b45309)'
                  : '#1e293b',
                color: canApply ? '#fff' : '#475569',
                fontSize:'13px', fontWeight:600,
                cursor: canApply ? 'pointer' : 'not-allowed',
                display:'flex', alignItems:'center', gap:'7px',
                transition:'all .15s',
              }}
            >
              {saving && (
                <svg className="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
              )}
              {saving ? 'Applying…' : 'Apply Scale'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
