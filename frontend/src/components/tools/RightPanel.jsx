import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { fmt, getUnitLabel, getAreaUnitLabel, convertFromMm } from '../../utils/calculations'

const UNITS = ['Mm', 'Cm', 'Meter', 'Feet', 'Inch', 'Yd']

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
            background: lastMeasurement.measureType === 'Area' ? 'rgba(34,197,94,.07)' : 'rgba(239,35,60,.07)',
            borderRadius: '8px', padding: '10px',
            borderLeft: `3px solid ${lastMeasurement.measureType === 'Area' ? '#22c55e' : lastMeasurement.measureType === 'Perimeter' ? '#8b5cf6' : '#EF233C'}`,
          }}>
            <div style={{ fontSize: '10px', color: '#475569', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' }}>
              {lastMeasurement.measureType === 'Area' ? 'Area Measurement' : lastMeasurement.measureType === 'Perimeter' ? 'Perimeter' : 'Line Measurement'}
            </div>
            {lastMeasurement.measureType === 'Area' && lastMeasurement.area != null ? (
              <div style={{ fontSize: '22px', fontWeight: 800, color: '#22c55e', lineHeight: 1 }}>
                {fmt(lastMeasurement.area)}
                <span style={{ fontSize: '12px', color: '#475569', marginLeft: '4px', fontWeight: 400 }}>
                  {getAreaUnitLabel(lastMeasurement.unit)}
                </span>
              </div>
            ) : lastMeasurement.length != null ? (
              <div style={{ fontSize: '22px', fontWeight: 800, color: '#EF233C', lineHeight: 1 }}>
                {fmt(lastMeasurement.length)}
                <span style={{ fontSize: '12px', color: '#475569', marginLeft: '4px', fontWeight: 400 }}>
                  {getUnitLabel(lastMeasurement.unit)}
                </span>
              </div>
            ) : (
              <div style={{ fontSize: '14px', color: '#475569' }}>
                {Math.round(lastMeasurement.pixelLength ?? lastMeasurement.pixelArea ?? 0)} px (not calibrated)
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Selected measurement — full properties panel ── */}
      {selectedItem && (
        <div style={{ padding: '12px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
          <SectionLabel>Properties</SectionLabel>
          <div style={{
            background: selectedItem.itemType === 'Area' ? 'rgba(34,197,94,.06)' : 'rgba(239,35,60,.06)',
            borderRadius: '8px', padding: '10px',
            borderLeft: `3px solid ${selectedItem.color ?? (selectedItem.itemType === 'Area' ? '#22c55e' : '#EF233C')}`,
          }}>
            {/* Type + Mark header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{
                fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '10px',
                background: selectedItem.itemType === 'Area' ? 'rgba(34,197,94,.15)' : 'rgba(239,35,60,.15)',
                color: selectedItem.itemType === 'Area' ? '#4ade80' : '#f87171',
                textTransform: 'uppercase', letterSpacing: '.06em',
              }}>
                {selectedItem.itemType ?? 'Line'}
              </span>
              <span style={{ fontSize: '13px', fontWeight: 800, color: selectedItem.color ?? '#EF233C' }}>
                {selectedItem.mark}
              </span>
            </div>

            {/* Description */}
            {selectedItem.description && (
              <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px', wordBreak: 'break-word', lineHeight: 1.5 }}>
                {selectedItem.description}
              </div>
            )}

            {/* Measurement value */}
            {selectedItem.itemType === 'Area' && selectedItem.area != null ? (
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#22c55e', lineHeight: 1, marginBottom: '6px' }}>
                {fmt(selectedItem.area)}
                <span style={{ fontSize: '11px', color: '#475569', marginLeft: '4px', fontWeight: 400 }}>
                  {getAreaUnitLabel(selectedItem.unit ?? activeUnit)}
                </span>
              </div>
            ) : selectedItem.length != null ? (
              <div style={{ fontSize: '20px', fontWeight: 800, color: selectedItem.color ?? '#EF233C', lineHeight: 1, marginBottom: '6px' }}>
                {fmt(selectedItem.length)}
                <span style={{ fontSize: '11px', color: '#475569', marginLeft: '4px', fontWeight: 400 }}>
                  {getUnitLabel(selectedItem.unit ?? activeUnit)}
                </span>
              </div>
            ) : null}

            {/* Properties grid */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
              {selectedItem.material && (
                <MeasRow label="Material"  value={selectedItem.material} />
              )}
              {selectedItem.category && (
                <MeasRow label="Category"  value={selectedItem.category} />
              )}
              {selectedItem.quantity != null && (
                <MeasRow label="Qty"       value={selectedItem.quantity} />
              )}
              {selectedItem.unitWeight != null && (
                <MeasRow label="Wt/m"      value={`${selectedItem.unitWeight.toFixed(1)} kg/m`} />
              )}
              {selectedItem.totalWeight != null && (
                <MeasRow label="Total Wt"  value={`${selectedItem.totalWeight.toFixed(1)} kg`} color="#f59e0b" />
              )}
              {selectedItem.color && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                  <span style={{ fontSize: '10px', color: '#475569' }}>Color</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <div style={{ width: '14px', height: '14px', borderRadius: '50%', background: selectedItem.color, border: '1px solid rgba(255,255,255,.2)' }} />
                    <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'monospace' }}>{selectedItem.color}</span>
                  </div>
                </div>
              )}
              {selectedItem.notes && (
                <div style={{ marginTop: '4px', padding: '6px 8px', background: 'rgba(255,255,255,.03)', borderRadius: '5px', fontSize: '10px', color: '#475569', lineHeight: 1.5 }}>
                  {selectedItem.notes}
                </div>
              )}
            </div>
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
            <StatCard label="Total Items"  value={takeoffItems.length}                                        color="#EF233C" />
            {(summary.totalLength ?? 0) > 0 && (
              <StatCard label="Total Length" value={`${fmt(summary.totalLength ?? 0)} ${getUnitLabel(unit)}`} color="#22C55E" />
            )}
            {/* Area summary */}
            {takeoffItems.some(i => i.itemType === 'Area' && i.area != null) && (
              <StatCard
                label="Total Area"
                value={`${fmt(takeoffItems.filter(i => i.itemType === 'Area').reduce((s, i) => s + (i.area ?? 0), 0))} ${getAreaUnitLabel(unit)}`}
                color="#3b82f6"
              />
            )}
            {/* Count summary */}
            {takeoffItems.some(i => i.itemType === 'Count') && (
              <StatCard
                label="Count Items"
                value={takeoffItems.filter(i => i.itemType === 'Count').reduce((s, i) => s + (i.quantity ?? 1), 0)}
                color="#f59e0b"
              />
            )}
            {/* Type breakdown */}
            {takeoffItems.filter(i => !i.itemType || i.itemType === 'Line').length > 0 && (
              <StatCard label="Line Items" value={takeoffItems.filter(i => !i.itemType || i.itemType === 'Line').length} color="#EF233C" />
            )}
            {takeoffItems.filter(i => i.itemType === 'Area').length > 0 && (
              <StatCard label="Area Items" value={takeoffItems.filter(i => i.itemType === 'Area').length} color="#22C55E" />
            )}
            {takeoffItems.filter(i => i.itemType === 'Perimeter').length > 0 && (
              <StatCard label="Polylines" value={takeoffItems.filter(i => i.itemType === 'Perimeter').length} color="#8b5cf6" />
            )}
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
