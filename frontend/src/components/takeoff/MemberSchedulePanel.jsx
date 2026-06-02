import { useState, useCallback } from 'react'
import { memberScheduleService } from '../../services/memberScheduleService'
import { useAppStore } from '../../store/useAppStore'
import { steelSections } from '../../utils/steelSections'
import { toMeters } from '../../utils/calculations'
import toast from 'react-hot-toast'

const MEMBER_TYPES = ['Beam', 'Column', 'Brace', 'Purlin', 'Rafter', 'Plate', 'Girt', 'Other']

const emptyRow = {
  mark: '', memberSize: '310UB46', memberType: 'Beam',
  unitWeight: 46.1, length: 0, quantity: 1, description: '', takeoffItemId: null,
}

export default function MemberSchedulePanel({ drawing, onExport }) {
  const {
    memberScheduleItems, addMemberScheduleItem,
    updateMemberScheduleItem, removeMemberScheduleItem, takeoffItems,
  } = useAppStore()

  const [editId,   setEditId]   = useState(null)
  const [editBuf,  setEditBuf]  = useState({})
  const [addMode,  setAddMode]  = useState(false)
  const [newRow,   setNewRow]   = useState({ ...emptyRow })
  const [saving,   setSaving]   = useState(false)

  const set = useCallback((buf, setBuf, f, v) => {
    setBuf(prev => {
      const updated = { ...prev, [f]: v }
      // Auto-fill unit weight when size changes
      if (f === 'memberSize') {
        const sec = steelSections.find(s => s.code === v)
        if (sec) updated.unitWeight = sec.w
      }
      return updated
    })
  }, [])

  const totalWeight = memberScheduleItems.reduce((s, m) => s + (m.totalWeight ?? 0), 0)
  const totalQty    = memberScheduleItems.reduce((s, m) => s + (m.quantity ?? 0), 0)

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

  // Measurements that can be linked (line type only)
  const linkableItems = takeoffItems.filter(t => t.itemType === 'Line')

  // When user links a measurement, auto-fill length (convert to meters for weight calc)
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

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'#080e1c' }}>

      {/* Toolbar */}
      <div style={{ padding:'7px 12px', borderBottom:'1px solid #1e293b', flexShrink:0,
        display:'flex', alignItems:'center', gap:'8px', background:'#0c1220' }}>

        <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
            <path d="M3 9h18M3 15h18M3 9V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>
          </svg>
          <span style={{ fontSize:'12px', fontWeight:700, color:'#64748b' }}>
            Member Schedule
          </span>
          <span style={{ fontSize:'10px', color:'#475569', background:'#1e293b',
            padding:'1px 5px', borderRadius:'4px' }}>
            {memberScheduleItems.length}
          </span>
        </div>

        {/* Totals */}
        {totalWeight > 0 && (
          <div style={{ display:'flex', gap:'12px', marginLeft:'8px' }}>
            <span style={{ fontSize:'11px', color:'#94a3b8' }}>
              Qty: <strong style={{ color:'#f1f5f9' }}>{totalQty}</strong>
            </span>
            <span style={{ fontSize:'11px', color:'#94a3b8' }}>
              Total: <strong style={{ color:'#22c55e' }}>{totalWeight.toFixed(1)} kg</strong>
            </span>
          </div>
        )}

        <div style={{ flex:1 }} />

        <button onClick={() => { setAddMode(true); setNewRow({ ...emptyRow }) }}
          style={{ display:'flex', alignItems:'center', gap:'5px', padding:'5px 12px',
            borderRadius:'6px', border:'none',
            background:'linear-gradient(90deg,#1d6fdb,#1558b0)',
            color:'#fff', fontSize:'11px', fontWeight:600, cursor:'pointer', whiteSpace:'nowrap' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add Member
        </button>

        {onExport && (
          <button onClick={onExport}
            style={{ display:'flex', alignItems:'center', gap:'4px', padding:'4px 9px',
              borderRadius:'5px', border:'1px solid rgba(34,197,94,.25)',
              background:'transparent', color:'#22c55e', fontSize:'11px', fontWeight:600,
              cursor:'pointer', whiteSpace:'nowrap' }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            Export
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ flex:1, overflow:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'11px' }}>
          <thead>
            <tr style={{ position:'sticky', top:0, background:'#0a111f', zIndex:1 }}>
              {['','Mark','Member Size','Type','Unit Wt\n(kg/m)','Length\n(m)','Qty','Total Wt\n(kg)','Linked\nMeasurement','Description',''].map((h, i) => (
                <th key={i} style={{ padding:'6px 8px', textAlign:'left', fontSize:'10px',
                  fontWeight:700, color:'#334155', textTransform:'uppercase',
                  letterSpacing:'.05em', borderBottom:'1px solid #1e293b',
                  whiteSpace:'pre-line', lineHeight:1.2,
                  width: i === 0 ? '4px' : undefined }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Add new row (inline) */}
            {addMode && (
              <tr style={{ background:'rgba(29,111,219,.08)', borderBottom:'1px solid #1e3a5f' }}>
                <td style={{ padding:'0 0 0 4px', width:'4px' }}>
                  <div style={{ width:'3px', height:'28px', background:'#1d6fdb', borderRadius:'2px' }} />
                </td>
                <td style={td}>
                  <input value={newRow.mark} onChange={e => set(newRow, setNewRow, 'mark', e.target.value)}
                    placeholder="R1" autoFocus style={{ ...ei, width:'54px' }} />
                </td>
                <td style={td}>
                  <select value={newRow.memberSize}
                    onChange={e => set(newRow, setNewRow, 'memberSize', e.target.value)}
                    style={{ ...ei, width:'110px' }}>
                    {steelSections.map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <select value={newRow.memberType}
                    onChange={e => set(newRow, setNewRow, 'memberType', e.target.value)}
                    style={{ ...ei, width:'80px' }}>
                    {MEMBER_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <input value={newRow.unitWeight} type="number" min="0" step="0.1"
                    onChange={e => set(newRow, setNewRow, 'unitWeight', +e.target.value)}
                    style={{ ...ei, width:'64px' }} />
                </td>
                <td style={td}>
                  <input value={newRow.length} type="number" min="0" step="0.01"
                    onChange={e => set(newRow, setNewRow, 'length', +e.target.value)}
                    style={{ ...ei, width:'64px' }} />
                </td>
                <td style={td}>
                  <input value={newRow.quantity} type="number" min="1"
                    onChange={e => set(newRow, setNewRow, 'quantity', +e.target.value)}
                    style={{ ...ei, width:'44px' }} />
                </td>
                <td style={{ ...td, color:'#22c55e', fontWeight:700 }}>
                  {calcTotal(newRow).toFixed(1)}
                </td>
                <td style={td}>
                  <select value={newRow.takeoffItemId ?? ''}
                    onChange={e => applyLinkedMeasurement(setNewRow, e.target.value)}
                    style={{ ...ei, width:'110px' }}
                    title="Selecting a measurement will auto-fill the length">
                    <option value="">— None —</option>
                    {linkableItems.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.mark || `#${t.id}`}{t.length != null ? ` (${t.length.toFixed(2)})` : ''}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={td}>
                  <input value={newRow.description}
                    onChange={e => set(newRow, setNewRow, 'description', e.target.value)}
                    placeholder="Description" style={{ ...ei, width:'120px' }} />
                </td>
                <td style={{ ...td, whiteSpace:'nowrap' }}>
                  <span style={{ display:'flex', gap:'3px' }}>
                    <button onClick={handleSaveNew} disabled={saving} style={ab('#22c55e')}>
                      {saving ? '…' : '✓'}
                    </button>
                    <button onClick={() => setAddMode(false)} style={ab('#475569')}>✕</button>
                  </span>
                </td>
              </tr>
            )}

            {/* Existing rows */}
            {memberScheduleItems.length === 0 && !addMode ? (
              <tr>
                <td colSpan={11} style={{ padding:'40px', textAlign:'center' }}>
                  <div style={{ color:'#334155', fontSize:'12px' }}>
                    No members in schedule — click "Add Member" to begin
                  </div>
                </td>
              </tr>
            ) : memberScheduleItems.map((item) => {
              const isEditing = editId === item.id
              const row = isEditing ? editBuf : item
              const linkedMeas = takeoffItems.find(t => t.id === item.takeoffItemId)

              return (
                <tr key={item.id}
                  style={{ borderBottom:'1px solid #0d1628',
                    background: isEditing ? '#0e1d3a' : 'transparent',
                    transition:'background .1s' }}
                  onMouseEnter={e => { if (!isEditing) e.currentTarget.style.background = '#0d1628' }}
                  onMouseLeave={e => { if (!isEditing) e.currentTarget.style.background = 'transparent' }}
                >
                  {/* Left accent */}
                  <td style={{ padding:'0 0 0 4px', width:'4px' }}>
                    <div style={{ width:'3px', height:'28px', background:'#3b82f6', borderRadius:'2px' }} />
                  </td>

                  <td style={{ ...td, color:'#60a5fa', fontWeight:700 }}>
                    {isEditing
                      ? <input value={row.mark} onChange={e => setEditBuf(b => ({...b, mark: e.target.value}))} style={{ ...ei, width:'54px' }} />
                      : item.mark || '—'}
                  </td>
                  <td style={td}>
                    {isEditing
                      ? <select value={row.memberSize}
                          onChange={e => {
                            const sec = steelSections.find(s => s.code === e.target.value)
                            setEditBuf(b => ({ ...b, memberSize: e.target.value, unitWeight: sec?.w ?? b.unitWeight }))
                          }} style={{ ...ei, width:'110px' }}>
                          {steelSections.map(s => <option key={s.code} value={s.code}>{s.label}</option>)}
                        </select>
                      : <span style={{ fontSize:'11px', color:'#94a3b8' }}>{item.memberSize}</span>}
                  </td>
                  <td style={td}>
                    {isEditing
                      ? <select value={row.memberType}
                          onChange={e => setEditBuf(b => ({...b, memberType: e.target.value}))}
                          style={{ ...ei, width:'80px' }}>
                          {MEMBER_TYPES.map(t => <option key={t}>{t}</option>)}
                        </select>
                      : <span style={{ padding:'2px 6px', borderRadius:'4px', fontSize:'10px',
                          background:'rgba(59,130,246,.1)', color:'#60a5fa', fontWeight:600 }}>
                          {item.memberType}
                        </span>}
                  </td>
                  <td style={{ ...td, color:'#94a3b8' }}>
                    {isEditing
                      ? <input value={row.unitWeight} type="number" min="0" step="0.1"
                          onChange={e => setEditBuf(b => ({...b, unitWeight: +e.target.value}))}
                          style={{ ...ei, width:'64px' }} />
                      : item.unitWeight?.toFixed(1)}
                  </td>
                  <td style={{ ...td, color:'#94a3b8' }}>
                    {isEditing
                      ? <input value={row.length} type="number" min="0" step="0.01"
                          onChange={e => setEditBuf(b => ({...b, length: +e.target.value}))}
                          style={{ ...ei, width:'64px' }} />
                      : item.length?.toFixed(2)}
                  </td>
                  <td style={{ ...td, color:'#f1f5f9' }}>
                    {isEditing
                      ? <input value={row.quantity} type="number" min="1"
                          onChange={e => setEditBuf(b => ({...b, quantity: +e.target.value}))}
                          style={{ ...ei, width:'44px' }} />
                      : item.quantity}
                  </td>
                  <td style={{ ...td, color:'#22c55e', fontWeight:700 }}>
                    {isEditing
                      ? ((editBuf.unitWeight ?? 0) * (editBuf.length ?? 0) * (editBuf.quantity ?? 1)).toFixed(1)
                      : item.totalWeight?.toFixed(1) ?? '—'}
                  </td>
                  <td style={{ ...td, color:'#64748b', fontSize:'10px' }}>
                    {isEditing
                      ? <select value={row.takeoffItemId ?? ''}
                          onChange={e => applyLinkedMeasurement(setEditBuf, e.target.value)}
                          style={{ ...ei, width:'110px' }}
                          title="Selecting a measurement will auto-fill the length">
                          <option value="">— None —</option>
                          {linkableItems.map(t => (
                            <option key={t.id} value={t.id}>
                              {t.mark || `#${t.id}`}{t.length != null ? ` (${t.length.toFixed(2)})` : ''}
                            </option>
                          ))}
                        </select>
                      : linkedMeas
                        ? <span style={{ color:'#3b82f6' }}>
                            {linkedMeas.mark || `#${linkedMeas.id}`}
                          </span>
                        : '—'}
                  </td>
                  <td style={{ ...td, maxWidth:'140px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'#64748b' }}>
                    {isEditing
                      ? <input value={row.description}
                          onChange={e => setEditBuf(b => ({...b, description: e.target.value}))}
                          style={{ ...ei, width:'120px' }} />
                      : item.description || '—'}
                  </td>
                  <td style={{ ...td, whiteSpace:'nowrap' }}>
                    {isEditing ? (
                      <span style={{ display:'flex', gap:'3px' }}>
                        <button onClick={handleSaveEdit} disabled={saving} style={ab('#22c55e')}>
                          {saving ? '…' : '✓'}
                        </button>
                        <button onClick={cancelEdit} style={ab('#475569')}>✕</button>
                      </span>
                    ) : (
                      <span style={{ display:'flex', gap:'3px' }}>
                        <button onClick={() => startEdit(item)} style={ab('#3b82f6')} title="Edit">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                        <button onClick={() => handleDelete(item.id, item.mark)} style={ab('#f87171')} title="Delete">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                          </svg>
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>

          {/* Totals footer */}
          {memberScheduleItems.length > 0 && (
            <tfoot>
              <tr style={{ background:'#0c1527', borderTop:'2px solid #1d6fdb' }}>
                <td colSpan={2} />
                <td colSpan={4} style={{ ...td, color:'#475569', fontSize:'10px',
                  fontWeight:700, textTransform:'uppercase', letterSpacing:'.05em' }}>
                  TOTALS
                </td>
                <td style={{ ...td, fontWeight:700, color:'#f1f5f9' }}>{totalQty}</td>
                <td style={{ ...td, fontWeight:700, color:'#22c55e' }}>{totalWeight.toFixed(1)} kg</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}

const td = { padding:'6px 8px', color:'#94a3b8', verticalAlign:'middle' }
const ei = {
  padding:'3px 5px', background:'#1e2d45', border:'1px solid #3b82f6',
  borderRadius:'4px', fontSize:'11px', color:'#f1f5f9', outline:'none',
}
const ab = (color) => ({
  width:'22px', height:'22px', borderRadius:'4px',
  border:`1px solid ${color}30`, background:`${color}12`,
  color, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'12px',
})
