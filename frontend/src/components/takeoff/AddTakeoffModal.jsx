import { useState } from 'react'
import { takeoffService } from '../../services/takeoffService'
import { useAppStore } from '../../store/useAppStore'
import { getUnitLabel } from '../../utils/calculations'
import toast from 'react-hot-toast'

const MEMBER_TYPES = ['Beam', 'Column', 'Brace', 'Purlin', 'Rafter', 'Plate', 'Other']
const UNIT_OPTIONS = ['Mm', 'Cm', 'Meter', 'Feet', 'Inch']

export default function AddMeasurementModal({ drawing, measurement, onAdded, onClose }) {
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
      toast.error('Failed to save measurement')
    } finally {
      setSaving(false)
    }
  }

  const hasLength = measurement?.length != null
  const unitLabel = getUnitLabel(unit)

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000,
      backdropFilter:'blur(4px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}>

      <div style={{ background:'#0f172a', border:'1px solid #1e293b', borderRadius:'14px',
        width:'100%', maxWidth:'440px', overflow:'hidden',
        boxShadow:'0 32px 80px rgba(0,0,0,.65)' }}>

        {/* Header */}
        <div style={{ padding:'18px 22px 14px', borderBottom:'1px solid #1e293b',
          background:'linear-gradient(135deg,#0d1b3e,#0a1428)',
          display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <h2 style={{ fontSize:'15px', fontWeight:700, color:'#f1f5f9', margin:0 }}>Add Measurement</h2>
            {hasLength && (
              <div style={{ fontSize:'11px', color:'#3b82f6', marginTop:'3px', fontWeight:600 }}>
                Measured: {measurement.length.toFixed(2)} {unitLabel}
              </div>
            )}
            {!hasLength && !drawing?.isCalibrated && (
              <div style={{ fontSize:'11px', color:'#f59e0b', marginTop:'3px' }}>
                ⚠ Calibrate scale first for real-world measurements
              </div>
            )}
            {!measurement && (
              <div style={{ fontSize:'11px', color:'#64748b', marginTop:'3px' }}>Manual entry</div>
            )}
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#475569',
            cursor:'pointer', padding:'4px', borderRadius:'5px' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Measurement preview card */}
        {hasLength && (
          <div style={{ margin:'16px 22px 0',
            background:'rgba(59,130,246,.08)', border:'1px solid rgba(59,130,246,.2)',
            borderRadius:'9px', padding:'12px 16px',
            display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:'11px', color:'#64748b' }}>Line Measurement</div>
              <div style={{ fontSize:'11px', color:'#475569', marginTop:'2px' }}>
                {measurement.points?.length ?? 0} points drawn on drawing
              </div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:'24px', fontWeight:700, color:'#3b82f6', lineHeight:1 }}>
                {measurement.length.toFixed(2)}
              </div>
              <div style={{ fontSize:'12px', color:'#64748b' }}>{unitLabel}</div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ padding:'16px 22px 20px' }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px' }}>

            <div>
              <FieldLabel>Member Mark / Tag</FieldLabel>
              <input value={form.mark} onChange={e => set('mark', e.target.value)}
                placeholder={suggestedMark} style={inp} autoFocus />
            </div>

            <div>
              <FieldLabel>Member Type</FieldLabel>
              <select value={form.memberType} onChange={e => set('memberType', e.target.value)} style={inp}>
                {MEMBER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div style={{ gridColumn:'1/-1' }}>
              <FieldLabel>Description</FieldLabel>
              <input value={form.description} onChange={e => set('description', e.target.value)}
                placeholder={`e.g. ${form.memberType} at gridline A`} style={inp} />
            </div>

            <div>
              <FieldLabel>Quantity</FieldLabel>
              <input value={form.quantity} onChange={e => set('quantity', e.target.value)}
                type="number" min="1" style={inp} />
            </div>

            <div>
              <FieldLabel>Unit</FieldLabel>
              <select value={unit} disabled style={{ ...inp, opacity:.6, cursor:'not-allowed' }}>
                {UNIT_OPTIONS.map(u => <option key={u} value={u}>{getUnitLabel(u)}</option>)}
              </select>
            </div>

            <div style={{ gridColumn:'1/-1' }}>
              <FieldLabel>Notes</FieldLabel>
              <textarea value={form.notes} onChange={e => set('notes', e.target.value)}
                placeholder="Optional notes…" rows={2}
                style={{ ...inp, resize:'none' }} />
            </div>
          </div>

          <div style={{ display:'flex', gap:'10px', marginTop:'16px', justifyContent:'flex-end' }}>
            <button type="button" onClick={onClose} style={{
              padding:'8px 16px', borderRadius:'7px', border:'1px solid #334155',
              background:'transparent', color:'#94a3b8', fontSize:'13px', cursor:'pointer' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{
              padding:'8px 20px', borderRadius:'7px', border:'none',
              background: saving ? '#1e3a5f' : 'linear-gradient(90deg,#1d6fdb,#1558b0)',
              color:'#fff', fontSize:'13px', fontWeight:600,
              cursor: saving ? 'not-allowed' : 'pointer',
              display:'flex', alignItems:'center', gap:'7px' }}>
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
    <label style={{ display:'block', fontSize:'11px', fontWeight:600, color:'#64748b',
      marginBottom:'5px', textTransform:'uppercase', letterSpacing:'.05em' }}>
      {children}
    </label>
  )
}

const inp = {
  width:'100%', padding:'8px 10px', background:'#1e293b', border:'1px solid #334155',
  borderRadius:'7px', fontSize:'13px', color:'#f1f5f9', outline:'none', boxSizing:'border-box',
}
