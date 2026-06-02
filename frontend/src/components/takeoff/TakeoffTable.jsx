import { useState } from 'react'
import { takeoffService } from '../../services/takeoffService'
import { useAppStore } from '../../store/useAppStore'
import { exportToExcel, exportToPdf } from '../../utils/exportUtils'
import { fmt, getUnitLabel } from '../../utils/calculations'
import toast from 'react-hot-toast'

const PAGE_SIZE = 25

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  if (isToday) {
    return d.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit' })
  }
  return d.toLocaleDateString('en-AU', { day:'2-digit', month:'2-digit' }) +
    ' ' + d.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit' })
}

export default function MeasurementTable({ drawing, onAddClick, selectedId, onRowSelect }) {
  const { takeoffItems, memberScheduleItems, selectedProject, updateTakeoffItem, removeTakeoffItem } = useAppStore()
  const [page,    setPage]    = useState(1)
  const [editId,  setEditId]  = useState(null)
  const [editBuf, setEditBuf] = useState({})
  const [saving,  setSaving]  = useState(false)
  const [filter,  setFilter]  = useState('')

  const filtered = takeoffItems.filter(it =>
    !filter || [it.description, it.mark, it.material, it.notes]
      .some(v => v?.toLowerCase().includes(filter.toLowerCase()))
  )
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1
  const pageItems  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const startEdit  = (item) => { setEditId(item.id); setEditBuf({ ...item }) }
  const cancelEdit = () => { setEditId(null); setEditBuf({}) }

  const saveEdit = async () => {
    setSaving(true)
    try {
      const updated = await takeoffService.update(editBuf)
      updateTakeoffItem(updated)
      toast.success('Measurement updated')
      cancelEdit()
    } catch { toast.error('Failed to update') } finally { setSaving(false) }
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this measurement?')) return
    try {
      await takeoffService.delete(id)
      removeTakeoffItem(id)
      if (selectedId === id) onRowSelect?.(null)
      toast.success('Measurement deleted')
    } catch { toast.error('Failed to delete') }
  }

  const unit         = drawing?.calibrationUnit ?? 'Mm'
  const totalLength  = takeoffItems.reduce((s, i) => s + (i.length ?? 0), 0)
  const totalWeight  = takeoffItems.reduce((s, i) => s + (i.totalWeight ?? 0), 0)
  const totalItems   = takeoffItems.length
  const hasAnyWeight = takeoffItems.some(i => i.totalWeight != null && i.totalWeight > 0)

  // Category breakdown — group by category, sum lengths
  const categoryGroups = takeoffItems.reduce((acc, i) => {
    const cat = i.category || 'General'
    if (!acc[cat]) acc[cat] = { color: i.color ?? '#3b82f6', count: 0, length: 0 }
    acc[cat].count++
    acc[cat].length += i.length ?? 0
    return acc
  }, {})

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'#080e1c' }}>

      {/* ── Toolbar ── */}
      <div style={{ padding:'7px 12px', borderBottom:'1px solid #1e293b', flexShrink:0,
        display:'flex', alignItems:'center', gap:'8px', background:'#0c1220' }}>

        <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
            <line x1="5" y1="19" x2="19" y2="5"/>
            <circle cx="5" cy="19" r="2" fill="#3b82f6"/>
            <circle cx="19" cy="5" r="2" fill="#3b82f6"/>
          </svg>
          <span style={{ fontSize:'12px', fontWeight:700, color:'#64748b' }}>Measurements</span>
          <span style={{ fontSize:'10px', color:'#475569', background:'#1e293b', padding:'1px 5px', borderRadius:'4px' }}>
            {filtered.length}
          </span>
        </div>

        <div style={{ position:'relative', flex:1, maxWidth:'180px' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2"
            style={{ position:'absolute', left:'7px', top:'50%', transform:'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input value={filter} onChange={e => { setFilter(e.target.value); setPage(1) }}
            placeholder="Filter…"
            style={{ width:'100%', padding:'4px 8px 4px 24px', background:'#1e293b',
              border:'1px solid #334155', borderRadius:'5px', fontSize:'11px',
              color:'#cbd5e1', outline:'none', boxSizing:'border-box' }} />
        </div>

        <div style={{ flex:1 }} />

        <button onClick={onAddClick} style={{
          display:'flex', alignItems:'center', gap:'5px', padding:'5px 12px',
          borderRadius:'6px', border:'none', background:'linear-gradient(90deg,#1d6fdb,#1558b0)',
          color:'#fff', fontSize:'11px', fontWeight:600, cursor:'pointer', whiteSpace:'nowrap' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add
        </button>

        <button onClick={() => exportToExcel(takeoffItems, memberScheduleItems, drawing, selectedProject)}
          disabled={!takeoffItems.length}
          style={{ ...iconBtn, color:'#22c55e', borderColor:'rgba(34,197,94,.25)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          XLS
        </button>
        <button onClick={() => exportToPdf(takeoffItems, memberScheduleItems, drawing, selectedProject)}
          disabled={!takeoffItems.length}
          style={{ ...iconBtn, color:'#f87171', borderColor:'rgba(248,113,113,.25)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          PDF
        </button>
      </div>

      {/* ── Live totals bar ── */}
      {totalItems > 0 && (
        <div style={{ borderBottom:'1px solid #1e293b', flexShrink:0, background:'rgba(29,111,219,.04)' }}>
          {/* Totals row */}
          <div style={{ padding:'5px 14px', display:'flex', alignItems:'center', gap:'16px' }}>
            <TotalChip icon="📋" label="Measurements" value={totalItems} color="#3b82f6" />
            {totalLength > 0 && (
              <TotalChip icon="📏" label="Total Length"
                value={`${fmt(totalLength)} ${getUnitLabel(unit)}`} color="#22c55e" />
            )}
            {hasAnyWeight && (
              <TotalChip icon="⚖️" label="Total Wt"
                value={`${totalWeight.toFixed(1)} kg`} color="#f59e0b" />
            )}
            {!drawing?.isCalibrated && totalItems > 0 && (
              <span style={{ fontSize:'10px', color:'#f59e0b', marginLeft:'auto' }}>
                ⚠ Calibrate scale for real-world lengths
              </span>
            )}
          </div>
          {/* Category breakdown chips */}
          {Object.keys(categoryGroups).length > 1 && (
            <div style={{ padding:'4px 14px 5px', display:'flex', alignItems:'center', gap:'6px', flexWrap:'wrap' }}>
              {Object.entries(categoryGroups).map(([cat, g]) => (
                <span key={cat} style={{
                  display:'flex', alignItems:'center', gap:'4px',
                  padding:'2px 7px', borderRadius:'10px',
                  background:`${g.color}14`, border:`1px solid ${g.color}30`,
                  fontSize:'10px', color:'#94a3b8',
                }}>
                  <span style={{ width:'7px', height:'7px', borderRadius:'50%', background: g.color, flexShrink:0 }} />
                  {cat}
                  <span style={{ color: g.color, fontWeight:700 }}>{g.count}</span>
                  {g.length > 0 && (
                    <span style={{ color:'#64748b' }}>· {fmt(g.length)} {getUnitLabel(unit)}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Table ── */}
      <div style={{ flex:1, overflow:'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
            justifyContent:'center', height:'100%', gap:'10px' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#1e293b" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
            </svg>
            <p style={{ fontSize:'12px', color:'#334155' }}>
              {takeoffItems.length === 0
                ? 'No measurements yet — use the Measure tool on the drawing'
                : 'No matching measurements'}
            </p>
            {takeoffItems.length === 0 && (
              <button onClick={onAddClick} style={{
                marginTop:'4px', padding:'6px 14px', borderRadius:'6px', border:'none',
                background:'rgba(29,111,219,.15)', color:'#60a5fa',
                fontSize:'11px', cursor:'pointer' }}>
                + Add manually
              </button>
            )}
          </div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'11px' }}>
            <thead>
              <tr style={{ position:'sticky', top:0, background:'#0a111f', zIndex:1 }}>
                {['', '#', 'Mark', 'Description', 'Category', 'Length', 'Wt/m (kg)', 'Total Wt', 'Type', 'Qty', 'Unit', 'Time', ''].map((h, i) => (
                  <th key={i} style={{ padding:'6px 8px', textAlign:'left', fontSize:'10px',
                    fontWeight:700, color:'#334155', textTransform:'uppercase',
                    letterSpacing:'.05em', borderBottom:'1px solid #1e293b', whiteSpace:'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((item, idx) => {
                const isEditing  = editId === item.id
                const isSelected = item.id === selectedId
                const row        = isEditing ? editBuf : item
                const rowNum     = (page - 1) * PAGE_SIZE + idx + 1
                const hasAnnot   = !!item.pointsJson

                return (
                  <tr key={item.id}
                    onClick={() => !isEditing && onRowSelect?.(isSelected ? null : item.id)}
                    style={{ borderBottom:'1px solid #0d1628',
                      cursor: isEditing ? 'default' : 'pointer',
                      background: isSelected ? 'rgba(29,111,219,.12)' : isEditing ? '#0e1d3a' : 'transparent',
                      outline: isSelected ? '1px solid rgba(29,111,219,.3)' : 'none',
                      outlineOffset:'-1px', transition:'background .1s' }}
                    onMouseEnter={e => { if (!isSelected && !isEditing) e.currentTarget.style.background = '#0d1628' }}
                    onMouseLeave={e => { if (!isSelected && !isEditing) e.currentTarget.style.background = 'transparent' }}
                  >
                    {/* Accent bar — uses item color */}
                    <td style={{ padding:'0 0 0 4px', width:'4px' }}>
                      <div style={{ width:'3px', height:'28px',
                        background: isSelected ? (item.color ?? '#3b82f6') : (item.color ? `${item.color}55` : '#1e3a5f'),
                        borderRadius:'2px' }} />
                    </td>
                    <td style={td}>{rowNum}</td>
                    <td style={{ ...td, color:'#60a5fa', fontWeight:600 }}>
                      {isEditing
                        ? <input value={row.mark ?? ''} onChange={e => setEditBuf(b => ({...b, mark: e.target.value}))} style={{ ...ei, width:'56px' }} />
                        : item.mark || '—'}
                    </td>
                    <td style={{ ...td, maxWidth:'200px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {isEditing
                        ? <input value={row.description ?? ''} onChange={e => setEditBuf(b => ({...b, description: e.target.value}))} style={{ ...ei, width:'160px' }} />
                        : item.description || '—'}
                    </td>
                    {/* Category */}
                    <td style={td}>
                      <span style={{ display:'flex', alignItems:'center', gap:'4px' }}>
                        {item.color && (
                          <span style={{ width:'8px', height:'8px', borderRadius:'50%',
                            background: item.color, flexShrink:0, display:'inline-block' }} />
                        )}
                        <span style={{ fontSize:'10px', color:'#64748b' }}>
                          {item.category || 'General'}
                        </span>
                      </span>
                    </td>
                    <td style={{ ...td, fontWeight:600,
                      color: item.length != null ? '#22c55e' : '#334155', whiteSpace:'nowrap' }}>
                      {item.length != null
                        ? `${fmt(item.length)} ${getUnitLabel(item.unit)}`
                        : hasAnnot ? <span style={{ color:'#475569', fontSize:'10px' }}>no scale</span> : '—'}
                    </td>
                    {/* Wt/m — editable in edit mode */}
                    <td style={{ ...td, color:'#94a3b8', whiteSpace:'nowrap' }}>
                      {isEditing
                        ? <input value={row.unitWeight ?? ''}
                            type="number" min="0" step="0.1" placeholder="kg/m"
                            onChange={e => setEditBuf(b => ({...b, unitWeight: e.target.value === '' ? null : +e.target.value}))}
                            style={{ ...ei, width:'60px' }} />
                        : item.unitWeight != null
                          ? <span style={{ fontSize:'10px', color:'#64748b' }}>{item.unitWeight.toFixed(1)}</span>
                          : <span style={{ fontSize:'10px', color:'#1e3a5f' }}>—</span>}
                    </td>
                    {/* Total Wt (kg) — auto-computed by backend from unitWeight × length × qty */}
                    <td style={{ ...td, fontWeight:600,
                      color: item.totalWeight != null ? '#f59e0b' : '#1e3a5f', whiteSpace:'nowrap' }}>
                      {item.totalWeight != null ? `${item.totalWeight.toFixed(1)} kg` : '—'}
                    </td>
                    <td style={td}>
                      {isEditing
                        ? <input value={row.material ?? ''} onChange={e => setEditBuf(b => ({...b, material: e.target.value}))} style={{ ...ei, width:'80px' }} />
                        : item.material
                          ? <span style={{ padding:'2px 6px', borderRadius:'4px', fontSize:'10px',
                              background:'rgba(59,130,246,.08)', color:'#64748b' }}>{item.material}</span>
                          : '—'}
                    </td>
                    <td style={td}>
                      {isEditing
                        ? <input value={row.quantity ?? 1} type="number" min="1" onChange={e => setEditBuf(b => ({...b, quantity: +e.target.value}))} style={{ ...ei, width:'44px' }} />
                        : item.quantity}
                    </td>
                    <td style={{ ...td, color:'#475569' }}>{getUnitLabel(item.unit)}</td>
                    <td style={{ ...td, color:'#334155', fontSize:'10px', whiteSpace:'nowrap' }}>
                      {fmtTime(item.createdAt)}
                    </td>
                    <td style={{ ...td, whiteSpace:'nowrap' }}>
                      {isEditing ? (
                        <span style={{ display:'flex', gap:'3px' }}>
                          <button onClick={e => { e.stopPropagation(); saveEdit() }} disabled={saving} style={ab('#22c55e')}>
                            {saving ? '…' : '✓'}
                          </button>
                          <button onClick={e => { e.stopPropagation(); cancelEdit() }} style={ab('#475569')}>✕</button>
                        </span>
                      ) : (
                        <span style={{ display:'flex', gap:'3px', alignItems:'center' }}>
                          {hasAnnot && (
                            <span title="Has drawing annotation" style={{ color:'#3b82f6', display:'flex' }}>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                              </svg>
                            </span>
                          )}
                          <button onClick={e => { e.stopPropagation(); startEdit(item) }} style={ab('#3b82f6')}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                          </button>
                          <button onClick={e => { e.stopPropagation(); handleDelete(item.id) }} style={ab('#f87171')}>
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
            {filtered.length > 0 && (
              <tfoot>
                <tr style={{ background:'#0c1527', borderTop:'1px solid #334155' }}>
                  <td colSpan={5} />
                  <td style={{ ...td, fontWeight:700, color:'#22c55e', whiteSpace:'nowrap' }}>
                    {totalLength > 0 ? `∑ ${fmt(totalLength)} ${getUnitLabel(unit)}` : '—'}
                  </td>
                  <td />
                  <td style={{ ...td, fontWeight:700, color:'#f59e0b', whiteSpace:'nowrap' }}>
                    {hasAnyWeight ? `∑ ${totalWeight.toFixed(1)} kg` : '—'}
                  </td>
                  <td colSpan={5} />
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div style={{ padding:'6px 12px', borderTop:'1px solid #1e293b', background:'#0c1220', flexShrink:0,
          display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontSize:'10px', color:'#475569' }}>
            {(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div style={{ display:'flex', gap:'3px' }}>
            {Array.from({ length: totalPages }, (_, i) => i+1).map(p => (
              <button key={p} onClick={() => setPage(p)} style={{
                width:'22px', height:'22px', borderRadius:'4px', border:'1px solid',
                borderColor: p===page ? '#1d6fdb' : '#334155',
                background: p===page ? 'rgba(29,111,219,.2)' : 'transparent',
                color: p===page ? '#60a5fa' : '#64748b', fontSize:'10px', cursor:'pointer' }}>{p}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function TotalChip({ icon, label, value, color }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'5px' }}>
      <span style={{ fontSize:'11px' }}>{icon}</span>
      <span style={{ fontSize:'10px', color:'#475569' }}>{label}:</span>
      <span style={{ fontSize:'11px', fontWeight:700, color }}>{value}</span>
    </div>
  )
}

const td   = { padding:'6px 8px', color:'#94a3b8', verticalAlign:'middle' }
const ei   = { padding:'3px 5px', background:'#1e2d45', border:'1px solid #3b82f6',
  borderRadius:'4px', fontSize:'11px', color:'#f1f5f9', outline:'none' }
const ab   = (color) => ({
  width:'22px', height:'22px', borderRadius:'4px',
  border:`1px solid ${color}30`, background:`${color}12`,
  color, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'12px',
})
const iconBtn = {
  display:'flex', alignItems:'center', gap:'4px', padding:'4px 9px', borderRadius:'5px',
  border:'1px solid', background:'transparent', fontSize:'11px', fontWeight:600,
  cursor:'pointer', whiteSpace:'nowrap',
}
