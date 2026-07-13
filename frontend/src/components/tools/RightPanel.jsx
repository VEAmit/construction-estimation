import { useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { fmt, getUnitLabel, getAreaUnitLabel } from '../../utils/calculations'
import { normalizeDrawing, resolveCalibratedMeasure, formatLineMeasureDescription } from '../../utils/measureCalibration'

const UNITS = ['Mm', 'Cm', 'Meter', 'Feet', 'Inch', 'Yd']
const PANEL_ACCENT = '#EF233C'

const SCALE_PRESETS = [
  { label: '1 : 10',   n: 10   },
  { label: '1 : 20',   n: 20   },
  { label: '1 : 50',   n: 50   },
  { label: '1 : 100',  n: 100  },
  { label: '1 : 200',  n: 200  },
  { label: '1 : 500',  n: 500  },
  { label: '1 : 1000', n: 1000 },
]

export default function RightPanel({ drawing: rawDrawing, lastMeasurement, selectedItem, summary, onCalibrated, onQuickScale, onCalibrateScale, onResetCalibration, width = '228px' }) {
  const { activeUnit, setActiveUnit, memberScheduleItems, setActiveTool, takeoffItems, activeTool, selectedMemberScheduleItem, lastMeasureMember } = useAppStore()
  const activeMeasureMember = selectedMemberScheduleItem ?? lastMeasureMember
  const [quickN,       setQuickN]       = useState('')
  const [quickUnit,    setQuickUnit]    = useState('Meter')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const drawing = normalizeDrawing(rawDrawing)
  const unit = drawing?.calibrationUnit ?? activeUnit

  const memberTotalWeight = memberScheduleItems.reduce((s, m) => s + (m.totalWeight ?? 0), 0)
  const memberTotalQty    = memberScheduleItems.reduce((s, m) => s + (m.quantity ?? 0), 0)

  // User-friendly scale status (no px / ratio math)
  const scaleLabel = drawing?.isCalibrated ? 'Scale set — measurements active' : null

  const showGuide  = !drawing || takeoffItems.length === 0
  const step0Done  = !!drawing
  const step1Done  = drawing?.isCalibrated
  const step2Done  = takeoffItems.length > 0

  return (
    <div style={{
      width, flexShrink: 0,
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
            label={step1Done ? 'Scale set' : 'Set scale (one time)'}
            sub={step1Done ? scaleLabel : 'Draw along a labelled dimension, enter its length'} />
          <GuideStep num={3} done={step2Done} locked={!step1Done}
            label="Measure elements"
            sub="Use Linear → click two points on the plan" />
          <GuideStep num={4} done={false} locked={!step1Done}
            label="Export report"
            sub="XLS or PDF from the top bar" />
        </div>
      )}

      {/* ── Scale Calibration ── */}
      <div style={{ padding: '12px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
        <SectionLabel>Scale Calibration</SectionLabel>

        {drawing?.isCalibrated ? (
          /* ── ✅ Calibrated card ── */
          <>
            <div style={{
              background: 'rgba(34,197,94,.07)', border: '1px solid rgba(34,197,94,.25)',
              borderRadius: '9px', padding: '10px 12px', marginBottom: '8px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '4px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span style={{ fontSize: '12px', fontWeight: 800, color: '#22c55e' }}>Calibrated</span>
                <span style={{
                  marginLeft: 'auto', fontSize: '10px', fontWeight: 700,
                  background: 'rgba(34,197,94,.15)', border: '1px solid rgba(34,197,94,.3)',
                  color: '#4ade80', padding: '1px 8px', borderRadius: '10px',
                }}>
                  {getUnitLabel(drawing.calibrationUnit)}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8', paddingLeft: '21px' }}>
                Measurements active — scale set.
              </div>
            </div>

            {/* Reset Scale button */}
            <button
              onClick={() => (onResetCalibration ?? onCalibrateScale ?? (() => setActiveTool('calibrate')))()}
              style={{
                width: '100%', padding: '7px', borderRadius: '7px',
                background: 'transparent',
                border: '1px solid rgba(239,35,60,.25)',
                color: 'rgba(239,35,60,.6)',
                fontSize: '11px', fontWeight: 600, cursor: 'pointer', transition: 'all .15s',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#EF233C'; e.currentTarget.style.color = '#EF233C'; e.currentTarget.style.background = 'rgba(239,35,60,.07)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(239,35,60,.25)'; e.currentTarget.style.color = 'rgba(239,35,60,.6)'; e.currentTarget.style.background = 'transparent' }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
              </svg>
              Reset Scale
            </button>
          </>
        ) : (
          /* ── ❌ Not Calibrated card ── */
          <>
            <div style={{
              background: 'rgba(239,35,60,.06)', border: '1px solid rgba(239,35,60,.25)',
              borderRadius: '9px', padding: '10px 12px', marginBottom: '8px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '5px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#EF233C" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                <span style={{ fontSize: '12px', fontWeight: 800, color: '#EF233C' }}>Not Calibrated</span>
              </div>
              <div style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '7px', lineHeight: 1.5 }}>
                Measurement disabled until calibration is completed.
              </div>
              {[
                '① Select Calibrate or Linear tool',
                '② Draw along a labelled dimension',
                '③ Enter actual length → Save Scale',
              ].map((step, i) => (
                <div key={i} style={{ fontSize: '10px', color: '#F59E0B', marginBottom: '3px', lineHeight: 1.4 }}>
                  {step}
                </div>
              ))}
            </div>

            {/* Set Scale button */}
            <button
              onClick={() => (onCalibrateScale ?? (() => setActiveTool('calibrate')))()}
              style={{
                width: '100%', padding: '8px', borderRadius: '7px',
                background: activeTool === 'calibrate' ? 'rgba(245,158,11,.18)' : 'rgba(245,158,11,.1)',
                border: `1px solid ${activeTool === 'calibrate' ? '#F59E0B' : 'rgba(245,158,11,.35)'}`,
                color: '#F59E0B',
                fontSize: '12px', fontWeight: 700, cursor: 'pointer', transition: 'all .15s',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                boxShadow: activeTool === 'calibrate' ? '0 0 0 2px rgba(245,158,11,.2)' : 'none',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(245,158,11,.2)'; e.currentTarget.style.borderColor = '#F59E0B' }}
              onMouseLeave={e => { e.currentTarget.style.background = activeTool === 'calibrate' ? 'rgba(245,158,11,.18)' : 'rgba(245,158,11,.1)'; e.currentTarget.style.borderColor = activeTool === 'calibrate' ? '#F59E0B' : 'rgba(245,158,11,.35)' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"/><path d="M3 12h3M18 12h3M12 3v3M12 18v3"/>
              </svg>
              {activeTool === 'calibrate' ? 'Draw reference line…' : 'Set Scale'}
            </button>
          </>
        )}
      </div>

      {/* ── Advanced: Preset Scale (collapsed by default) ── */}
      {drawing && !drawing.isCalibrated && onQuickScale && (
        <div style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
          {/* Toggle header */}
          <button
            onClick={() => setShowAdvanced(v => !v)}
            style={{
              width: '100%', padding: '10px 12px',
              background: 'transparent', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              cursor: 'pointer', color: PANEL_ACCENT, fontSize: '10px',
              fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em',
            }}
          >
            <span>Advanced: Preset Scale</span>
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform .2s', flexShrink: 0 }}
            >
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {showAdvanced && (
            <div style={{ padding: '0 12px 12px' }}>
              <p style={{ fontSize: '10px', color: PANEL_ACCENT, marginBottom: '8px', lineHeight: 1.5 }}>
                Only use if you know the exact drawing scale (e.g. 1:100). For best accuracy, use the Calibrate tool above instead.
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
            <div style={{ fontSize: '10px', color: PANEL_ACCENT, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' }}>
              {lastMeasurement.measureType === 'Area' ? 'Area Measurement' : lastMeasurement.measureType === 'Perimeter' ? 'Perimeter' : 'Line Measurement'}
            </div>
            {lastMeasurement.measureType === 'Area' && lastMeasurement.area != null ? (
              <div style={{ fontSize: '22px', fontWeight: 800, color: '#22c55e', lineHeight: 1 }}>
                {fmt(lastMeasurement.area)}
                <span style={{ fontSize: '12px', color: '#475569', marginLeft: '4px', fontWeight: 400 }}>
                  {getAreaUnitLabel(lastMeasurement.unit)}
                </span>
              </div>
            ) : (() => {
              const norm = normalizeDrawing(drawing)
              const resolved = resolveCalibratedMeasure(
                lastMeasurement.pixelLength ?? 0,
                lastMeasurement.pixelArea ?? 0,
                norm,
                activeUnit,
                { isArea: lastMeasurement.measureType === 'Area' },
              )
              const showLen = lastMeasurement.length ?? resolved.length
              if (showLen != null) {
                return (
                  <div style={{ fontSize: '22px', fontWeight: 800, color: '#EF233C', lineHeight: 1 }}>
                    {fmt(showLen)}
                    <span style={{ fontSize: '12px', color: '#475569', marginLeft: '4px', fontWeight: 400 }}>
                      {getUnitLabel(activeUnit)}
                    </span>
                  </div>
                )
              }
              return (
                <div style={{ fontSize: '13px', color: '#64748b', lineHeight: 1.45 }}>
                  Draw along a labelled dimension to set scale
                </div>
              )
            })()}
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
          {activeMeasureMember && (
            <div style={{
              marginBottom: '8px', padding: '8px 10px', borderRadius: '6px',
              background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.25)',
              fontSize: '11px', color: '#4ade80', fontWeight: 700,
            }}>
              Selected: {activeMeasureMember.mark}
              {activeMeasureMember.memberType ? ` · ${activeMeasureMember.memberType}` : ''}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <StatCard label="Members" value={memberScheduleItems.length} color="#EF233C" />
            {memberTotalQty > 0 && (
              <StatCard label="Total Qty" value={memberTotalQty} color="#F59E0B" />
            )}
            {memberTotalWeight > 0 && (
              <StatCard label="Total Weight" value={`${memberTotalWeight.toFixed(1)} kg`} color="#22C55E" />
            )}
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
        <div style={{ fontSize: '11px', fontWeight: 600, color: done ? '#22c55e' : PANEL_ACCENT }}>{label}</div>
        {sub && <div style={{ fontSize: '10px', color: PANEL_ACCENT, marginTop: '1px' }}>{sub}</div>}
      </div>
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 800, color: PANEL_ACCENT, textTransform: 'uppercase',
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
      <div style={{ fontSize: '10px', color: PANEL_ACCENT, marginBottom: '2px' }}>{label}</div>
      <div style={{ fontSize: '14px', fontWeight: 800, color: '#f1f5f9' }}>{value}</div>
    </div>
  )
}
