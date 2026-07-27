import { useState } from 'react'
import { takeoffService } from '../../services/takeoffService'
import { useAppStore } from '../../store/useAppStore'
import { getUnitLabel } from '../../utils/calculations'
import toast from 'react-hot-toast'

const MEMBER_TYPES = ['Beam', 'Column', 'Brace', 'Purlin', 'Rafter', 'Plate', 'Other']
const UNIT_OPTIONS = ['Mm', 'Cm', 'Meter', 'Feet', 'Inch']

export default function AddMeasurementModal({
  drawing,
  measurement,
  onAdded,
  onClose,
  onBeforeAdd,
  onAddFailed,
}) {
  const { addTakeoffItem, activeUnit, takeoffItems } = useAppStore()
  const unit = drawing?.calibrationUnit ?? activeUnit

  const suggestedMark = `M${takeoffItems.length + 1}`

  const [form, setForm] = useState({
    mark:        suggestedMark,
    description: '',
    memberType:  'Beam',
    quantity:    1,
    notes:       '',
  })
  const [saving, setSaving] = useState(false)
  const set = (f, v) => setForm(p => ({ ...p, [f]: v }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!drawing) { toast.error('No drawing selected'); return }
    const historyToken = onBeforeAdd?.()
    setSaving(true)
    try {
      const payload = {
        drawingId:   drawing.id,
        itemType:    'Line',
        mark:        form.mark,
        description: form.description || (form.memberType + (form.mark ? ` ${form.mark}` : '')),
        quantity:    +form.quantity,
        unit:        unit,
        material:    form.memberType,
        notes:       form.notes,
        length:      measurement?.length ?? null,
        area:        null,
        unitWeight:  null,
        totalWeight: null,
        pointsJson:  measurement?.points ? JSON.stringify(measurement.points) : null,
      }
      const saved = await takeoffService.create(payload)
      addTakeoffItem(saved)
      toast.success('Measurement saved')
      onAdded(saved)
      onClose()
    } catch {
      onAddFailed?.(historyToken)
      toast.error('Failed to save measurement')
    } finally {
      setSaving(false)
    }
  }

  const hasLength = measurement?.length != null
  const unitLabel = getUnitLabel(unit)

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.8)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        backdropFilter: 'blur(6px)',
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: '#111827',
        border: '1px solid rgba(255,255,255,.08)',
        borderRadius: '14px', width: '100%', maxWidth: '440px',
        overflow: 'hidden', boxShadow: '0 32px 80px rgba(0,0,0,.8)',
      }}>

        {/* Header */}
        <div style={{
          padding: '16px 22px 14px',
          borderBottom: '1px solid rgba(255,255,255,.07)',
          background: 'linear-gradient(135deg,#0D1526,#111827)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '3px', height: '28px', background: '#EF233C', borderRadius: '2px' }} />
            <div>
              <h2 style={{ fontSize: '14px', fontWeight: 800, color: '#f1f5f9', margin: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Add Measurement
              </h2>
              {hasLength && (
                <div style={{ fontSize: '11px', color: '#EF233C', marginTop: '2px', fontWeight: 700 }}>
                  Measured: {measurement.length.toFixed(2)} {unitLabel}
                </div>
              )}
              {!hasLength && !drawing?.isCalibrated && (
                <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '2px' }}>
                  ⚠ Calibrate scale first for real-world measurements
                </div>
              )}
              {!measurement && (
                <div style={{ fontSize: '11px', color: '#475569', marginTop: '2px' }}>Manual entry</div>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)',
            color: '#94a3b8', cursor: 'pointer', padding: '5px', borderRadius: '6px',
            display: 'flex', alignItems: 'center',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Measurement preview card */}
        {hasLength && (
          <div style={{
            margin: '16px 22px 0',
            background: 'rgba(239,35,60,.07)', border: '1px solid rgba(239,35,60,.2)',
            borderRadius: '9px', padding: '12px 16px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ fontSize: '11px', color: '#475569' }}>Line Measurement</div>
              <div style={{ fontSize: '11px', color: '#334155', marginTop: '2px' }}>
                {measurement.points?.length ?? 0} points drawn on drawing
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '26px', fontWeight: 800, color: '#EF233C', lineHeight: 1 }}>
                {measurement.length.toFixed(2)}
              </div>
              <div style={{ fontSize: '12px', color: '#475569' }}>{unitLabel}</div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ padding: '16px 22px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>

            <div>
              <FieldLabel>Member Mark / Tag</FieldLabel>
              <input value={form.mark} onChange={e => set('mark', e.target.value)}
                placeholder={suggestedMark} style={inp} autoFocus
                onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.12)' }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
              />
            </div>

            <div>
              <FieldLabel>Member Type</FieldLabel>
              <select value={form.memberType} onChange={e => set('memberType', e.target.value)} style={inp}>
                {MEMBER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div style={{ gridColumn: '1/-1' }}>
              <FieldLabel>Description</FieldLabel>
              <input value={form.description} onChange={e => set('description', e.target.value)}
                placeholder={`e.g. ${form.memberType} at gridline A`} style={inp}
                onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.12)' }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
              />
            </div>

            <div>
              <FieldLabel>Quantity</FieldLabel>
              <input value={form.quantity} onChange={e => set('quantity', e.target.value)}
                type="number" min="1" style={inp}
                onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.12)' }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
              />
            </div>

            <div>
              <FieldLabel>Unit</FieldLabel>
              <select value={unit} disabled style={{ ...inp, opacity: .5, cursor: 'not-allowed' }}>
                {UNIT_OPTIONS.map(u => <option key={u} value={u}>{getUnitLabel(u)}</option>)}
              </select>
            </div>

            <div style={{ gridColumn: '1/-1' }}>
              <FieldLabel>Notes</FieldLabel>
              <textarea value={form.notes} onChange={e => set('notes', e.target.value)}
                placeholder="Optional notes…" rows={2}
                style={{ ...inp, resize: 'none' }}
                onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.12)' }}
                onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '16px', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={{
              padding: '8px 16px', borderRadius: '7px', border: '1px solid rgba(255,255,255,.1)',
              background: 'transparent', color: '#94a3b8', fontSize: '13px', cursor: 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{
              padding: '8px 20px', borderRadius: '7px', border: 'none',
              background: saving ? 'rgba(239,35,60,.2)' : 'linear-gradient(90deg,#EF233C,#D90429)',
              color: saving ? '#475569' : '#fff',
              fontSize: '13px', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '7px',
              boxShadow: saving ? 'none' : '0 4px 14px rgba(239,35,60,.35)',
            }}>
              {saving && (
                <svg className="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
              )}
              {saving ? 'Saving…' : 'Save Measurement'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function FieldLabel({ children }) {
  return (
    <label style={{
      display: 'block', fontSize: '10px', fontWeight: 700, color: '#475569',
      marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '.06em',
    }}>
      {children}
    </label>
  )
}

const inp = {
  width: '100%', padding: '8px 10px',
  background: 'rgba(255,255,255,.04)',
  border: '1px solid rgba(255,255,255,.1)',
  borderRadius: '7px', fontSize: '13px', color: '#f1f5f9',
  outline: 'none', boxSizing: 'border-box',
  transition: 'border-color .15s, box-shadow .15s',
}
