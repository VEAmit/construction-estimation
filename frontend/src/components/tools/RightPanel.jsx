import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { fmt, getUnitLabel, convertFromMm } from '../../utils/calculations'

const UNITS = ['Mm', 'Cm', 'Meter', 'Feet', 'Inch']

const SCALE_PRESETS = [
  { label: '1 : 10',   n: 10   },
  { label: '1 : 20',   n: 20   },
  { label: '1 : 50',   n: 50   },
  { label: '1 : 100',  n: 100  },
  { label: '1 : 200',  n: 200  },
  { label: '1 : 500',  n: 500  },
  { label: '1 : 1000', n: 1000 },
]

export default function RightPanel({ drawing, lastMeasurement, selectedItem, summary, onCalibrated, onQuickScale }) {
  const { activeUnit, setActiveUnit, memberScheduleItems, setActiveTool, takeoffItems } = useAppStore()
  const [quickN,    setQuickN]    = useState('')
  const [quickUnit, setQuickUnit] = useState('Meter')

  const unit = drawing?.calibrationUnit ?? activeUnit

  const memberTotalWeight = memberScheduleItems.reduce((s, m) => s + (m.totalWeight ?? 0), 0)
  const memberTotalQty    = memberScheduleItems.reduce((s, m) => s + (m.quantity ?? 0), 0)

  const scaleLabel = (() => {
    if (!drawing?.isCalibrated || !drawing?.scaleRatio) return null
    const mmPerPx = drawing.scaleRatio
    const val     = convertFromMm(mmPerPx, drawing.calibrationUnit)
    const u       = getUnitLabel(drawing.calibrationUnit)
    if (val >= 0.01) return `1 unit = ${val >= 10 ? val.toFixed(1) : val.toFixed(4)} ${u}`
    const pxPerMm = 1 / mmPerPx
    return `${pxPerMm.toFixed(2)} units = 1 mm`
  })()

  const showGuide  = !drawing || takeoffItems.length === 0
  const step0Done  = !!drawing
  const step1Done  = drawing?.isCalibrated
  const step2Done  = takeoffItems.length > 0

  return (
    <div style={{
      width: '228px', flexShrink: 0,
      background: '#0B1320',
      borderLeft: '1px solid rgba(255,255,255,.07)',
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
    }}>

      {/* ── Workflow guide ── */}
      {showGuide && (
        <div style={{ padding: '12px', borderBottom: '1px solid rgba(255,255,255,.07)', background: 'rgba(0,0,0,.2)' }}>
          <SectionLabel>Getting Started</SectionLabel>
          <GuideStep num={1} done={step0Done}
            label={step0Done ? 'Drawing uploaded' : 'Upload a PDF drawing'}
            sub={step0Done ? 'Drawing ready' : 'Drop PDF in the left sidebar'} />
          <GuideStep num={2} done={step1Done} locked={!step0Done}
            label={step1Done ? 'Scale calibrated' : 'Calibrate scale'}
            sub={step1Done ? scaleLabel : 'Use Calibrate tool → draw known line'} />
          <GuideStep num={3} done={step2Done} locked={!step1Done}
            label="Measure elements"
            sub="Use Measure tool → click two points" />
          <GuideStep num={4} done={false} locked={!step1Done}
            label="Export report"
            sub="XLS or PDF from the top bar" />
        </div>
      )}

      {/* ── Scale Calibration ── */}
      <div style={{ padding: '12px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
        <SectionLabel>Scale Calibration</SectionLabel>

        {drawing?.isCalibrated && (
          <div style={{ marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: '#22c55e' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Calibrated · {getUnitLabel(drawing.calibrationUnit)}
            </div>
            {scaleLabel && (
              <div style={{ fontSize: '10px', color: '#334155', marginTop: '3px', paddingLeft: '17px' }}>
                {scaleLabel}
              </div>
            )}
          </div>
        )}

        <button
          onClick={() => setActiveTool('calibrate')}
          style={{
            width: '100%', padding: '7px', borderRadius: '7px',
            background: 'transparent', border: '1px solid',
            color:       drawing?.isCalibrated ? '#22c55e' : '#64748b',
            borderColor: drawing?.isCalibrated ? 'rgba(34,197,94,.3)' : 'rgba(255,255,255,.1)',
            fontSize: '12px', cursor: 'pointer', transition: 'all .15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#F59E0B'; e.currentTarget.style.color = '#fbbf24' }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = drawing?.isCalibrated ? 'rgba(34,197,94,.3)' : 'rgba(255,255,255,.1)'
            e.currentTarget.style.color       = drawing?.isCalibrated ? '#22c55e' : '#64748b'
          }}
        >
          {drawing?.isCalibrated ? 'Re-calibrate Scale' : 'Calibrate Scale'}
        </button>

        {!drawing?.isCalibrated && (
          <p style={{ fontSize: '10px', color: '#334155', marginTop: '7px', lineHeight: 1.6 }}>
            Select <strong style={{ color: '#F59E0B' }}>Calibrate</strong> tool, draw a line of known length on the drawing
          </p>
        )}
      </div>

      {/* ── Quick Scale Presets ── */}
      {drawing && !drawing.isCalibrated && onQuickScale && (
        <div style={{ padding: '12px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
          <SectionLabel>Quick Scale (approx.)</SectionLabel>
          <p style={{ fontSize: '10px', color: '#334155', marginBottom: '8px', lineHeight: 1.5 }}>
            For standard A-size PDFs — picks a scale without drawing a line.
          </p>
          <div style={{ display: 'flex', gap: '5px', marginBottom: '6px' }}>
            <select
              value={quickN}
              onChange={e => setQuickN(e.target.value)}
              style={{
                flex: 1, padding: '6px 8px',
                background: '#111827', border: '1px solid rgba(255,255,255,.1)',
                borderRadius: '6px', fontSize: '11px', color: '#f1f5f9',
                outline: 'none', cursor: 'pointer',
              }}
            >
              <option value="">Select scale…</option>
              {SCALE_PRESETS.map(p => (
                <option key={p.n} value={p.n}>{p.label}</option>
              ))}
            </select>
            <select
              value={quickUnit}
              onChange={e => setQuickUnit(e.target.value)}
              style={{
                padding: '6px 6px', background: '#111827',
                border: '1px solid rgba(255,255,255,.1)',
                borderRadius: '6px', fontSize: '11px', color: '#f1f5f9',
                outline: 'none', cursor: 'pointer',
              }}
            >
              {UNITS.map(u => <option key={u} value={u}>{getUnitLabel(u)}</option>)}
            </select>
          </div>
          <button
            disabled={!quickN}
            onClick={() => {
              if (!quickN) return
              const scaleRatio = +quickN * (25.4 / 72)
              onQuickScale(scaleRatio, quickUnit)
            }}
            style={{
              width: '100%', padding: '7px', borderRadius: '7px', border: 'none',
              background: quickN ? 'linear-gradient(90deg,#d97706,#b45309)' : 'rgba(255,255,255,.04)',
              color: quickN ? '#fff' : '#334155',
              fontSize: '11px', fontWeight: 700,
              cursor: quickN ? 'pointer' : 'not-allowed',
              transition: 'all .15s',
            }}
          >
            Apply 1 : {quickN || '?'} Scale
          </button>
        </div>
      )}

      {/* ── Display Unit selector ── */}
      <div style={{ padding: '12px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
        <SectionLabel>Display Unit</SectionLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {UNITS.map(u => (
            <button key={u} onClick={() => setActiveUnit(u)} style={{
              padding: '3px 8px', borderRadius: '5px', fontSize: '11px', cursor: 'pointer',
              border: `1px solid ${activeUnit === u ? 'rgba(239,35,60,.4)' : 'rgba(255,255,255,.07)'}`,
              background: activeUnit === u ? 'rgba(239,35,60,.12)' : 'transparent',
              color: activeUnit === u ? '#EF233C' : '#64748b',
              transition: 'all .15s', fontWeight: activeUnit === u ? 700 : 400,
            }}>
              {getUnitLabel(u)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Last Measurement ── */}
      {lastMeasurement && !selectedItem && (
        <div style={{ padding: '12px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
          <SectionLabel>Last Measurement</SectionLabel>
          <div style={{
            background: 'rgba(239,35,60,.07)', borderRadius: '8px', padding: '10px',
            borderLeft: '3px solid #EF233C',
          }}>
            <div style={{ fontSize: '10px', color: '#475569', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' }}>
              Line Measurement
            </div>
            {lastMeasurement.length != null ? (
              <div style={{ fontSize: '22px', fontWeight: 800, color: '#EF233C', lineHeight: 1 }}>
                {fmt(lastMeasurement.length)}
                <span style={{ fontSize: '12px', color: '#475569', marginLeft: '4px', fontWeight: 400 }}>
                  {getUnitLabel(lastMeasurement.unit)}
                </span>
              </div>
            ) : (
              <div style={{ fontSize: '14px', color: '#475569' }}>
                {Math.round(lastMeasurement.pixelLength ?? 0)} px (not calibrated)
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Selected measurement ── */}
      {selectedItem && (
        <div style={{ padding: '12px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
          <SectionLabel>Selected Measurement</SectionLabel>
          <div style={{
            background: 'rgba(239,35,60,.07)', borderRadius: '8px', padding: '10px',
            borderLeft: '3px solid #EF233C',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <span style={{ fontSize: '10px', fontWeight: 800, color: '#EF233C', textTransform: 'uppercase', letterSpacing: '.06em' }}>LINE</span>
              {selectedItem.mark && (
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#f87171' }}>{selectedItem.mark}</span>
              )}
            </div>
            {selectedItem.description && (
              <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '8px', wordBreak: 'break-word' }}>
                {selectedItem.description}
              </div>
            )}
            {selectedItem.length != null && (
              <MeasRow label="Length"
                value={`${fmt(selectedItem.length)} ${getUnitLabel(selectedItem.unit ?? activeUnit)}`} color="#EF233C" />
            )}
            {selectedItem.material && (
              <MeasRow label="Type" value={selectedItem.material} />
            )}
            {selectedItem.quantity != null && (
              <MeasRow label="Qty" value={selectedItem.quantity} />
            )}
          </div>
        </div>
      )}

      {/* ── Member Schedule Summary ── */}
      {memberScheduleItems.length > 0 && (
        <div style={{ padding: '12px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
          <SectionLabel>Member Schedule</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <StatCard label="Members"      value={memberScheduleItems.length}           color="#EF233C" />
            <StatCard label="Total Qty"    value={memberTotalQty}                       color="#F59E0B" />
            <StatCard label="Total Weight" value={`${memberTotalWeight.toFixed(1)} kg`} color="#22C55E" />
          </div>
        </div>
      )}

      {/* ── Measurement Summary ── */}
      {summary && (
        <div style={{ padding: '12px', flex: 1, overflow: 'auto' }}>
          <SectionLabel>Measurement Summary</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <StatCard label="Total Items"  value={summary.totalItems ?? 0}                                   color="#EF233C" />
            <StatCard label="Total Length" value={`${fmt(summary.totalLength ?? 0)} ${getUnitLabel(unit)}`} color="#EF233C" />
          </div>
        </div>
      )}
    </div>
  )
}

function GuideStep({ num, done, locked, label, sub }) {
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', opacity: locked ? 0.35 : 1 }}>
      <div style={{
        width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '10px', fontWeight: 800,
        background: done ? '#22c55e' : 'rgba(255,255,255,.04)',
        border: `1px solid ${done ? '#22c55e' : 'rgba(255,255,255,.1)'}`,
        color: done ? '#fff' : '#475569', marginTop: '1px',
      }}>
        {done
          ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
          : num}
      </div>
      <div>
        <div style={{ fontSize: '11px', fontWeight: 600, color: done ? '#22c55e' : '#94a3b8' }}>{label}</div>
        {sub && <div style={{ fontSize: '10px', color: '#334155', marginTop: '1px' }}>{sub}</div>}
      </div>
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 800, color: '#334155', textTransform: 'uppercase',
      letterSpacing: '.1em', marginBottom: '8px',
    }}>
      {children}
    </div>
  )
}

function MeasRow({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
      <span style={{ fontSize: '10px', color: '#475569' }}>{label}</span>
      <span style={{ fontSize: '12px', fontWeight: 700, color: color ?? '#94a3b8' }}>{value}</span>
    </div>
  )
}

function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,.03)', borderRadius: '7px', padding: '8px 10px',
      borderLeft: `3px solid ${color}`, border: `1px solid rgba(255,255,255,.06)`,
      borderLeftWidth: '3px', borderLeftColor: color,
    }}>
      <div style={{ fontSize: '10px', color: '#334155', marginBottom: '2px' }}>{label}</div>
      <div style={{ fontSize: '14px', fontWeight: 800, color: '#f1f5f9' }}>{value}</div>
    </div>
  )
}
