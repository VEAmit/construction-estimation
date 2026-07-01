import { useState, useCallback, Fragment } from 'react'
import { memberScheduleService } from '../../services/memberScheduleService'
import { useAppStore } from '../../store/useAppStore'
import { steelSections } from '../../utils/steelSections'
import { toMeters } from '../../utils/calculations'
import { parseMemberScheduleNoteId } from '../../utils/memberMeasureLink'
import toast from 'react-hot-toast'

const MEMBER_TYPES = ['Beam', 'Column', 'Brace', 'Purlin', 'Rafter', 'Plate', 'Girt', 'Other']

const emptyRow = {
  mark: '', memberSize: '', memberType: 'Column',
  unitWeight: 0, length: 0, quantity: 0, description: '', takeoffItemId: null,
}

/** Same columns as extraction popup — estimation fields only in edit mode */
const DISPLAY_HEADERS = ['', 'Mark', 'Section Size', 'Type', 'PDF Source Line', '']

function formatPdfSource(description) {
  if (!description) return '—'
  return description.replace(/^(Schedule|Pattern):\s*/i, '')
}

export default function MemberSchedulePanel({ drawing, onExport }) {
  const {
    memberScheduleItems, addMemberScheduleItem,
    updateMemberScheduleItem, removeMemberScheduleItem, takeoffItems,
    selectedMemberScheduleItem, setSelectedMemberScheduleItem, lastMeasureMember,
    setActiveTool, triggerPdfCommand,
  } = useAppStore()

  const activeMeasureMember = selectedMemberScheduleItem ?? lastMeasureMember

  const linkedMeasurements = activeMeasureMember
    ? takeoffItems.filter((t) => {
      if ((t.itemType || 'Line') !== 'Line') return false
      const mark = String(activeMeasureMember.mark ?? '').trim()
      if (mark && String(t.material ?? '').trim() === mark) return true
      return parseMemberScheduleNoteId(t.notes) === activeMeasureMember.id
    })
    : []

  const [editId, setEditId] = useState(null)
  const [editBuf, setEditBuf] = useState({})
  const [addMode, setAddMode] = useState(false)
  const [newRow, setNewRow] = useState({ ...emptyRow })
  const [saving, setSaving] = useState(false)

  const set = useCallback((buf, setBuf, f, v) => {
    setBuf(prev => {
      const updated = { ...prev, [f]: v }
      if (f === 'memberSize') {
        const sec = steelSections.find(s => s.code === v)
        if (sec) updated.unitWeight = sec.w
      }
      return updated
    })
  }, [])

  const totalWeight = memberScheduleItems.reduce((s, m) => s + (m.totalWeight ?? 0), 0)
  const hasEstimation = memberScheduleItems.some(
    m => (m.unitWeight ?? 0) > 0 || (m.length ?? 0) > 0 || (m.quantity ?? 0) > 0
  )

  const calcTotal = (row) => (row.unitWeight ?? 0) * (row.length ?? 0) * (row.quantity ?? 1)

  const handleSaveNew = async () => {
    if (!drawing) { toast.error('Select a drawing first'); return }
    if (!newRow.mark) { toast.error('Member mark is required'); return }
    setSaving(true)
    try {
      const saved = await memberScheduleService.create(drawing.id, newRow)
      addMemberScheduleItem(saved)
      setNewRow({ ...emptyRow })
      setAddMode(false)
      toast.success('Member added to schedule')
    } catch {
      toast.error('Failed to save member')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveEdit = async () => {
    setSaving(true)
    try {
      const updated = await memberScheduleService.update(editBuf)
      updateMemberScheduleItem(updated)
      setEditId(null)
      setEditBuf({})
      toast.success('Member updated')
    } catch {
      toast.error('Failed to update member')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id, mark) => {
    if (!confirm(`Delete member "${mark}" from schedule?`)) return
    try {
      await memberScheduleService.delete(id)
      removeMemberScheduleItem(id)
      toast.success('Member removed')
    } catch {
      toast.error('Failed to delete member')
    }
  }

  const startEdit = (item) => { setEditId(item.id); setEditBuf({ ...item }) }
  const cancelEdit = () => { setEditId(null); setEditBuf({}) }

  const armLinearMeasureMode = useCallback(() => {
    setActiveTool('line')
    triggerPdfCommand('ensureMeasureMode')
    setTimeout(() => triggerPdfCommand('ensureMeasureMode'), 120)
    setTimeout(() => triggerPdfCommand('ensureMeasureMode'), 450)
  }, [setActiveTool, triggerPdfCommand])

  const handleSelectMember = useCallback((item) => {
    if (!item?.mark) return
    setSelectedMemberScheduleItem(item)
    armLinearMeasureMode()
    toast.success(`${item.mark} selected — draw on the plan`, { duration: 2200, icon: '📐' })
  }, [setSelectedMemberScheduleItem, armLinearMeasureMode])

  const linkableItems = takeoffItems.filter(t => t.itemType === 'Line')

  const applyLinkedMeasurement = (setBuf, measId) => {
    const meas = measId ? takeoffItems.find(t => t.id === +measId) : null
    setBuf(prev => {
      const updated = { ...prev, takeoffItemId: measId ? +measId : null }
      if (meas && meas.length != null) {
        const lengthM = toMeters(meas.length, drawing?.calibrationUnit ?? 'Mm')
        updated.length = +lengthM.toFixed(3)
      }
      return updated
    })
  }

  const renderEstimationFields = (row, setBuf, isNew) => (
    <tr style={{ background: 'rgba(239,35,60,.04)', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
      <td colSpan={DISPLAY_HEADERS.length} style={{ padding: '8px 12px 10px 16px' }}>
        <div style={{ fontSize: '10px', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
          Optional — add for weight calculation (not from PDF extraction)
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <label style={estLabel}>
            Unit wt (kg/m)
            <input value={row.unitWeight || ''} type="number" min="0" step="0.1" placeholder="—"
              onChange={e => (isNew ? set(newRow, setNewRow, 'unitWeight', +e.target.value) : setEditBuf(b => ({ ...b, unitWeight: +e.target.value })))}
              style={{ ...ei, width: '72px' }} />
          </label>
          <label style={estLabel}>
            Length (m)
            <input value={row.length || ''} type="number" min="0" step="0.01" placeholder="—"
              onChange={e => (isNew ? set(newRow, setNewRow, 'length', +e.target.value) : setEditBuf(b => ({ ...b, length: +e.target.value })))}
              style={{ ...ei, width: '72px' }} />
          </label>
          <label style={estLabel}>
            Qty
            <input value={row.quantity || ''} type="number" min="0" step="1" placeholder="—"
              onChange={e => (isNew ? set(newRow, setNewRow, 'quantity', +e.target.value) : setEditBuf(b => ({ ...b, quantity: +e.target.value })))}
              style={{ ...ei, width: '52px' }} />
          </label>
          <label style={estLabel}>
            Link measurement
            <select value={row.takeoffItemId ?? ''}
              className="app-select"
              onChange={e => applyLinkedMeasurement(isNew ? setNewRow : setEditBuf, e.target.value)}
              style={{ ...es, width: '130px' }}>
              <option value="">— None —</option>
              {linkableItems.map(t => (
                <option key={t.id} value={t.id}>
                  {t.mark || `#${t.id}`}{t.length != null ? ` (${t.length.toFixed(2)})` : ''}
                </option>
              ))}
            </select>
          </label>
          {(row.unitWeight > 0 && row.length > 0 && row.quantity > 0) && (
            <span style={{ fontSize: '11px', color: '#22c55e', fontWeight: 700 }}>
              Total: {calcTotal(row).toFixed(1)} kg
            </span>
          )}
        </div>
      </td>
    </tr>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: '#080B12' }}>

      <div style={{ padding: '7px 12px', borderBottom: '1px solid rgba(255,255,255,.07)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: '8px', background: '#0D1526' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
          <div style={{ width: '2px', height: '16px', background: '#EF233C', borderRadius: '1px' }} />
          <span style={{ fontSize: '12px', fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            Member Schedule
          </span>
          <span style={{ fontSize: '10px', color: '#EF233C', fontWeight: 700,
            background: 'rgba(239,35,60,.1)', padding: '1px 6px', borderRadius: '10px',
            border: '1px solid rgba(239,35,60,.2)' }}>
            {memberScheduleItems.length}
          </span>
        </div>

        {hasEstimation && totalWeight > 0 && (
          <span style={{ fontSize: '11px', color: '#475569', marginLeft: '8px' }}>
            Total steel: <strong style={{ color: '#22c55e' }}>{totalWeight.toFixed(1)} kg</strong>
          </span>
        )}

        {activeMeasureMember && (
          <span style={{
            fontSize: '10px', color: '#4ade80', fontWeight: 700, marginLeft: '8px',
            background: 'rgba(34,197,94,.1)', padding: '2px 8px', borderRadius: '10px',
            border: '1px solid rgba(34,197,94,.25)',
          }}>
            Measuring: {activeMeasureMember.mark}
            {linkedMeasurements.length > 0 ? ` · ${linkedMeasurements.length} line(s)` : ''}
          </span>
        )}

        <div style={{ flex: 1 }} />

        <button onClick={() => { setAddMode(true); setNewRow({ ...emptyRow }) }}
          style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 12px',
            borderRadius: '6px', border: 'none',
            background: 'linear-gradient(90deg,#EF233C,#D90429)',
            color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            boxShadow: '0 2px 10px rgba(239,35,60,.3)' }}>
          + Add Member
        </button>

        {onExport && (
          <button onClick={onExport}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 9px',
              borderRadius: '5px', border: '1px solid rgba(34,197,94,.25)',
              background: 'transparent', color: '#22c55e', fontSize: '11px', fontWeight: 600,
              cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Export
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: '#0D1526', zIndex: 1 }}>
              {DISPLAY_HEADERS.map((h, i) => (
                <th key={i} style={{ padding: '7px 8px', textAlign: 'left', fontSize: '10px',
                  fontWeight: 800, color: '#475569', textTransform: 'uppercase',
                  letterSpacing: '.07em', borderBottom: '2px solid rgba(239,35,60,.35)',
                  width: i === 0 ? '4px' : undefined }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {addMode && (
              <>
                <tr style={{ background: 'rgba(239,35,60,.06)', borderBottom: '1px solid rgba(239,35,60,.15)' }}>
                  <td style={{ padding: '0 0 0 4px', width: '4px' }}>
                    <div style={{ width: '3px', height: '28px', background: '#EF233C', borderRadius: '2px' }} />
                  </td>
                  <td style={td}>
                    <input value={newRow.mark} onChange={e => set(newRow, setNewRow, 'mark', e.target.value)}
                      placeholder="SC2" autoFocus style={{ ...ei, width: '64px' }} />
                  </td>
                  <td style={td}>
                    <input value={newRow.memberSize} onChange={e => set(newRow, setNewRow, 'memberSize', e.target.value)}
                      placeholder="360UB45" style={{ ...ei, width: '100px' }} list="steel-sections-list" />
                    <datalist id="steel-sections-list">
                      {steelSections.map(s => <option key={s.code} value={s.code} />)}
                    </datalist>
                  </td>
                  <td style={td}>
                    <select className="app-select" value={newRow.memberType}
                      onChange={e => set(newRow, setNewRow, 'memberType', e.target.value)}
                      style={{ ...es, width: '88px' }}>
                      {MEMBER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td style={td}>
                    <input value={newRow.description}
                      onChange={e => set(newRow, setNewRow, 'description', e.target.value)}
                      placeholder="SC2 - 360 UB 45" style={{ ...ei, width: '100%', minWidth: '160px' }} />
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'flex', gap: '3px' }}>
                      <button onClick={handleSaveNew} disabled={saving} style={ab('#22c55e')}>
                        {saving ? '…' : '✓'}
                      </button>
                      <button onClick={() => setAddMode(false)} style={ab('#475569')}>✕</button>
                    </span>
                  </td>
                </tr>
                {renderEstimationFields(newRow, setNewRow, true)}
              </>
            )}

            {memberScheduleItems.length === 0 && !addMode ? (
              <tr>
                <td colSpan={DISPLAY_HEADERS.length} style={{ padding: '40px', textAlign: 'center' }}>
                  <div style={{ color: '#64748b', fontSize: '12px' }}>
                    No members — use <strong style={{ color: '#94a3b8' }}>Schedule Extract</strong> or Add Member
                  </div>
                </td>
              </tr>
            ) : memberScheduleItems.map((item) => {
              const isEditing = editId === item.id
              const isSelected = selectedMemberScheduleItem?.id === item.id
                || activeMeasureMember?.id === item.id
              const row = isEditing ? editBuf : item

              return (
                <Fragment key={item.id}>
                  <tr
                    style={{ borderBottom: '1px solid rgba(255,255,255,.04)',
                      background: isEditing
                        ? 'rgba(239,35,60,.06)'
                        : isSelected
                        ? 'rgba(34,197,94,.08)'
                        : 'transparent',
                      cursor: isEditing ? 'default' : 'pointer',
                      outline: isSelected ? '1px solid rgba(34,197,94,.35)' : 'none',
                      outlineOffset: '-1px',
                    }}
                    onClick={() => { if (!isEditing) handleSelectMember(item) }}
                    onMouseEnter={e => { if (!isEditing && !isSelected) e.currentTarget.style.background = 'rgba(255,255,255,.03)' }}
                    onMouseLeave={e => { if (!isEditing && !isSelected) e.currentTarget.style.background = 'transparent' }}
                  >
                    <td style={{ padding: '0 0 0 4px', width: '4px' }}>
                      <div style={{ width: '3px', height: '28px', background: '#EF233C', borderRadius: '2px' }} />
                    </td>
                    <td style={{ ...td, color: '#EF233C', fontWeight: 700 }}>
                      {isEditing
                        ? <input value={row.mark} onChange={e => setEditBuf(b => ({ ...b, mark: e.target.value }))} style={{ ...ei, width: '64px' }} />
                        : item.mark || '—'}
                    </td>
                    <td style={td}>
                      {isEditing
                        ? <input value={row.memberSize} onChange={e => setEditBuf(b => ({ ...b, memberSize: e.target.value }))} style={{ ...ei, width: '100px' }} />
                        : <span style={{ fontSize: '11px', color: '#e2e8f0', fontWeight: 600 }}>{item.memberSize}</span>}
                    </td>
                    <td style={td}>
                      {isEditing
                        ? <select className="app-select" value={row.memberType} onChange={e => setEditBuf(b => ({ ...b, memberType: e.target.value }))} style={{ ...es, width: '88px' }}>
                            {MEMBER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        : <span style={{ padding: '2px 6px', borderRadius: '4px', fontSize: '10px',
                            background: 'rgba(239,35,60,.08)', color: '#94a3b8', fontWeight: 600 }}>
                            {item.memberType}
                          </span>}
                    </td>
                    <td style={{ ...td, color: '#94a3b8', maxWidth: '280px' }}>
                      {isEditing
                        ? <input value={row.description} onChange={e => setEditBuf(b => ({ ...b, description: e.target.value }))} style={{ ...ei, width: '100%' }} />
                        : <span title={item.description}>{formatPdfSource(item.description)}</span>}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {isEditing ? (
                        <span style={{ display: 'flex', gap: '3px' }}>
                          <button onClick={handleSaveEdit} disabled={saving} style={ab('#22c55e')}>{saving ? '…' : '✓'}</button>
                          <button onClick={cancelEdit} style={ab('#475569')}>✕</button>
                        </span>
                      ) : (
                        <span style={{ display: 'flex', gap: '3px' }} onClick={e => e.stopPropagation()}>
                          <button onClick={() => startEdit(item)} style={ab('#EF233C')} title="Edit">✎</button>
                          <button onClick={() => handleDelete(item.id, item.mark)} style={ab('#f87171')} title="Delete">✕</button>
                        </span>
                      )}
                    </td>
                  </tr>
                  {isEditing && renderEstimationFields(editBuf, setEditBuf, false)}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const td = { padding: '6px 8px', color: '#94a3b8', verticalAlign: 'middle' }
const ei = {
  padding: '3px 5px',
  background: 'rgba(255,255,255,.04)',
  border: '1px solid rgba(239,35,60,.4)',
  borderRadius: '4px', fontSize: '11px', color: '#f1f5f9', outline: 'none',
}
const es = {
  padding: '3px 5px',
  border: '1px solid rgba(239,35,60,.4)',
  borderRadius: '4px', fontSize: '11px', outline: 'none',
}
const ab = (color) => ({
  width: '22px', height: '22px', borderRadius: '4px',
  border: `1px solid ${color}30`, background: `${color}12`,
  color, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px',
})
const estLabel = {
  display: 'flex', flexDirection: 'column', gap: '3px',
  fontSize: '10px', color: '#475569', fontWeight: 600,
}
