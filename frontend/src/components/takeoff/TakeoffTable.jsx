import { useState, useEffect, useRef } from 'react'
import { takeoffService } from '../../services/takeoffService'
import { useAppStore } from '../../store/useAppStore'
import { exportToExcel, exportToPdf } from '../../utils/exportUtils'
import { fmt, getUnitLabel, getAreaUnitLabel } from '../../utils/calculations'
import toast from 'react-hot-toast'

const PAGE_SIZE = 25

function getPageNum(item) {
  if (!item.pointsJson) return null
  try {
    const d = JSON.parse(item.pointsJson)
    const idx = d.page != null ? parseInt(d.page, 10) : (d.pageIndex ?? 0)
    return idx + 1
  } catch { return null }
}

function getThickness(item) {
  if (!item.pointsJson) return null
  try {
    const d = JSON.parse(item.pointsJson)
    const t = d.thickness ?? d.Thickness
    return t != null ? Number(t) : null
  } catch { return null }
}

function fmtScale(drawing) {
  if (!drawing?.isCalibrated || !drawing?.scaleRatio) return '—'
  return 'Set'
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  if (isToday) {
    return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' }) +
    ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
}

export default function MeasurementTable({ drawing, onAddClick, selectedId, onRowSelect, onDelete }) {
  const { takeoffItems, memberScheduleItems, selectedProject, updateTakeoffItem, removeTakeoffItem } = useAppStore()
  const [page,    setPage]    = useState(1)
  const [editId,  setEditId]  = useState(null)
  const [editBuf, setEditBuf] = useState({})
  const [saving,  setSaving]  = useState(false)
  const [filter,  setFilter]  = useState('')

  const prevItemCountRef = useRef(takeoffItems.length)
  useEffect(() => {
    if (takeoffItems.length > prevItemCountRef.current) {
      const lastPage = Math.max(1, Math.ceil(takeoffItems.length / PAGE_SIZE))
      setPage(lastPage)
    }
    prevItemCountRef.current = takeoffItems.length
  }, [takeoffItems.length])

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
    if (!confirm('Delete this measurement from grid and drawing?')) return
    try {
      if (onDelete) {
        await onDelete(id)
      } else {
        await takeoffService.delete(id)
        removeTakeoffItem(id)
        if (selectedId === id) onRowSelect?.(null)
      }
      toast.success('Measurement deleted')
    } catch { toast.error('Failed to delete') }
  }

  const unit         = drawing?.calibrationUnit ?? 'Mm'
  const lineItems    = takeoffItems.filter(i => !i.itemType || i.itemType === 'Line' || i.itemType === 'Perimeter')
  const areaItems    = takeoffItems.filter(i => i.itemType === 'Area')
  const countItems   = takeoffItems.filter(i => i.itemType === 'Count')
  const totalCount   = countItems.reduce((s, i) => s + (i.quantity ?? 1), 0)
  const totalLength  = lineItems.reduce((s, i) => s + (i.length ?? 0), 0)
  const totalArea    = areaItems.reduce((s, i) => s + (i.area ?? 0), 0)
  const totalWeight  = takeoffItems.reduce((s, i) => s + (i.totalWeight ?? 0), 0)
  const totalItems   = takeoffItems.length
  const hasAnyWeight = takeoffItems.some(i => i.totalWeight != null && i.totalWeight > 0)
  const hasAnyArea   = areaItems.length > 0

  const categoryGroups = takeoffItems.reduce((acc, i) => {
    const cat = i.category || 'General'
    if (!acc[cat]) acc[cat] = { color: i.color ?? '#EF233C', count: 0, length: 0 }
    acc[cat].count++
    acc[cat].length += i.length ?? 0
    return acc
  }, {})

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: '#080B12' }}>

      {/* ── Toolbar ── */}
      <div style={{
        padding: '7px 12px', borderBottom: '1px solid rgba(255,255,255,.07)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: '8px', background: '#0D1526',
      }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ width: '2px', height: '16px', background: '#EF233C', borderRadius: '1px' }} />
          <span style={{ fontSize: '12px', fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            Measurements
          </span>
          <span style={{
            fontSize: '10px', color: '#EF233C', fontWeight: 700,
            background: 'rgba(239,35,60,.1)', padding: '1px 6px', borderRadius: '10px',
            border: '1px solid rgba(239,35,60,.2)',
          }}>
            {filtered.length}
          </span>
        </div>

        <div style={{ position: 'relative', flex: 1, maxWidth: '180px' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2"
            style={{ position: 'absolute', left: '7px', top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input value={filter} onChange={e => { setFilter(e.target.value); setPage(1) }}
            placeholder="Filter…"
            style={{
              width: '100%', padding: '4px 8px 4px 24px',
              background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
              borderRadius: '5px', fontSize: '11px', color: '#cbd5e1',
              outline: 'none', boxSizing: 'border-box',
              transition: 'border-color .15s',
            }}
            onFocus={e => e.target.style.borderColor = 'rgba(239,35,60,.35)'}
            onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,.08)'}
          />
        </div>

        <div style={{ flex: 1 }} />

        <button onClick={onAddClick} style={{
          display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 12px',
          borderRadius: '6px', border: 'none',
          background: 'linear-gradient(90deg,#EF233C,#D90429)',
          color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
          boxShadow: '0 2px 10px rgba(239,35,60,.3)',
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add
        </button>

        <button onClick={() => exportToExcel(takeoffItems, memberScheduleItems, drawing, selectedProject)}
          disabled={!takeoffItems.length}
          style={{ ...iconBtn, color: '#22c55e', borderColor: 'rgba(34,197,94,.25)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          XLS
        </button>
        <button onClick={() => exportToPdf(takeoffItems, memberScheduleItems, drawing, selectedProject)}
          disabled={!takeoffItems.length}
          style={{ ...iconBtn, color: '#f87171', borderColor: 'rgba(239,35,60,.25)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          PDF
        </button>
      </div>

      {/* ── Live totals bar ── */}
      {totalItems > 0 && (
        <div style={{ borderBottom: '1px solid rgba(255,255,255,.06)', flexShrink: 0, background: 'rgba(239,35,60,.03)' }}>
          <div style={{ padding: '5px 14px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <TotalChip label="Items" value={totalItems} color="#EF233C" />
            {totalLength > 0 && (
              <TotalChip label="Length" value={`${fmt(totalLength)} ${getUnitLabel(unit)}`} color="#22c55e" />
            )}
            {hasAnyArea && totalArea > 0 && (
              <TotalChip label="Area" value={`${fmt(totalArea)} ${getAreaUnitLabel(unit)}`} color="#3b82f6" />
            )}
            {hasAnyWeight && (
              <TotalChip label="Wt" value={`${totalWeight.toFixed(1)} kg`} color="#f59e0b" />
            )}
            {totalCount > 0 && (
              <TotalChip label="Count" value={totalCount} color="#f59e0b" />
            )}
            {!drawing?.isCalibrated && totalItems > 0 && (
              <span style={{ fontSize: '10px', color: '#f59e0b', marginLeft: 'auto' }}>
                Set scale using a labelled dimension on the plan
              </span>
            )}
          </div>
          {Object.keys(categoryGroups).length > 1 && (
            <div style={{ padding: '4px 14px 5px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              {Object.entries(categoryGroups).map(([cat, g]) => (
                <span key={cat} style={{
                  display: 'flex', alignItems: 'center', gap: '4px',
                  padding: '2px 7px', borderRadius: '10px',
                  background: `${g.color}12`, border: `1px solid ${g.color}28`,
                  fontSize: '10px', color: '#94a3b8',
                }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: g.color, flexShrink: 0 }} />
                  {cat}
                  <span style={{ color: g.color, fontWeight: 700 }}>{g.count}</span>
                  {g.length > 0 && (
                    <span style={{ color: '#475569' }}>· {fmt(g.length)} {getUnitLabel(unit)}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Table ── */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '10px' }}>
            <div style={{
              width: '48px', height: '48px', borderRadius: '10px',
              background: 'rgba(239,35,60,.08)', border: '1px solid rgba(239,35,60,.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#EF233C" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
              </svg>
            </div>
            <p style={{ fontSize: '12px', color: '#334155' }}>
              {takeoffItems.length === 0
                ? 'Draw on the PDF — measurements save automatically (Bluebeam-style)'
                : 'No matching measurements'}
            </p>
            {takeoffItems.length === 0 && (
              <button onClick={onAddClick} style={{
                marginTop: '4px', padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(239,35,60,.3)',
                background: 'rgba(239,35,60,.08)', color: '#EF233C',
                fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              }}>
                + Add manually
              </button>
            )}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: '#0D1526', zIndex: 1 }}>
                {['', '#', 'Pg', 'Type', 'Mark', 'Description', 'Category', 'Length / Area', 'Unit', 'Scale', 'Thk', 'Wt/m', 'Total Wt', 'Material', 'Qty', 'Time', ''].map((h, i) => (
                  <th key={i} style={{
                    padding: '7px 8px', textAlign: 'left',
                    fontSize: '10px', fontWeight: 800, color: '#475569',
                    textTransform: 'uppercase', letterSpacing: '.06em',
                    borderBottom: '2px solid rgba(239,35,60,.4)',
                    whiteSpace: 'nowrap',
                  }}>
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
                  <tr
                    key={item.id}
                    onClick={() => !isEditing && onRowSelect?.(isSelected ? null : item.id)}
                    style={{
                      borderBottom: '1px solid rgba(255,255,255,.04)',
                      cursor: isEditing ? 'default' : 'pointer',
                      background: isSelected
                        ? 'rgba(239,35,60,.1)'
                        : isEditing
                        ? 'rgba(255,255,255,.03)'
                        : 'transparent',
                      outline: isSelected ? '1px solid rgba(239,35,60,.25)' : 'none',
                      outlineOffset: '-1px',
                      transition: 'background .1s',
                    }}
                    onMouseEnter={e => { if (!isSelected && !isEditing) e.currentTarget.style.background = 'rgba(255,255,255,.03)' }}
                    onMouseLeave={e => { if (!isSelected && !isEditing) e.currentTarget.style.background = 'transparent' }}
                  >
                    {/* Accent bar */}
                    <td style={{ padding: '0 0 0 4px', width: '4px' }}>
                      <div style={{
                        width: '3px', height: '28px',
                        background: isSelected ? (item.color ?? '#EF233C') : (item.color ? `${item.color}44` : 'rgba(239,35,60,.2)'),
                        borderRadius: '2px',
                      }} />
                    </td>
                    <td style={td}>{rowNum}</td>
                    {/* Page number */}
                    <td style={{ ...td, color: '#475569', fontSize: '10px' }}>
                      {getPageNum(item) != null ? `p${getPageNum(item)}` : '—'}
                    </td>
                    {/* Item type badge */}
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {item.itemType === 'Area' ? (
                        <span style={{ padding: '2px 6px', borderRadius: '10px', fontSize: '9px', fontWeight: 800, background: 'rgba(34,197,94,.12)', color: '#4ade80', border: '1px solid rgba(34,197,94,.25)', textTransform: 'uppercase' }}>Area</span>
                      ) : item.itemType === 'Perimeter' ? (
                        <span style={{ padding: '2px 6px', borderRadius: '10px', fontSize: '9px', fontWeight: 800, background: 'rgba(139,92,246,.12)', color: '#a78bfa', border: '1px solid rgba(139,92,246,.25)', textTransform: 'uppercase' }}>Poly</span>
                      ) : item.itemType === 'Count' ? (
                        <span style={{ padding: '2px 6px', borderRadius: '10px', fontSize: '9px', fontWeight: 800, background: 'rgba(245,158,11,.12)', color: '#fbbf24', border: '1px solid rgba(245,158,11,.25)', textTransform: 'uppercase' }}>Count</span>
                      ) : (
                        <span style={{ padding: '2px 6px', borderRadius: '10px', fontSize: '9px', fontWeight: 800, background: 'rgba(239,35,60,.1)', color: '#f87171', border: '1px solid rgba(239,35,60,.2)', textTransform: 'uppercase' }}>Line</span>
                      )}
                    </td>
                    <td style={{ ...td, color: '#EF233C', fontWeight: 700 }}>
                      {isEditing
                        ? <input value={row.mark ?? ''} onChange={e => setEditBuf(b => ({ ...b, mark: e.target.value }))} style={{ ...ei, width: '56px' }} />
                        : item.mark || '—'}
                    </td>
                    <td style={{ ...td, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {isEditing
                        ? <input value={row.description ?? ''} onChange={e => setEditBuf(b => ({ ...b, description: e.target.value }))} style={{ ...ei, width: '160px' }} />
                        : item.description || '—'}
                    </td>
                    <td style={td}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {item.color && (
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: item.color, flexShrink: 0, display: 'inline-block' }} />
                        )}
                        <span style={{ fontSize: '10px', color: '#475569' }}>
                          {item.category || 'General'}
                        </span>
                      </span>
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {item.itemType === 'Count' ? (
                        <span style={{ fontWeight: 700, color: '#f59e0b' }}>× {item.quantity ?? 1}</span>
                      ) : item.itemType === 'Area' ? (
                        item.area != null
                          ? <span style={{ fontWeight: 700, color: '#22c55e' }}>{fmt(item.area)}</span>
                          : <span style={{ color: '#334155', fontSize: '10px' }}>—</span>
                      ) : (
                        item.length != null
                          ? <span style={{ fontWeight: 700, color: item.color ?? '#22c55e' }}>{fmt(item.length)}</span>
                          : hasAnnot ? <span style={{ color: '#334155', fontSize: '10px' }}>no scale</span> : '—'
                      )}
                    </td>
                    <td style={{ ...td, color: '#334155' }}>{getUnitLabel(item.unit)}</td>
                    <td style={{ ...td, color: '#475569', fontSize: '9px', whiteSpace: 'nowrap' }}>
                      {fmtScale(drawing)}
                    </td>
                    <td style={{ ...td, color: '#64748b', fontSize: '10px', textAlign: 'center' }}>
                      {getThickness(item) ?? '—'}
                    </td>
                    <td style={{ ...td, color: '#64748b', whiteSpace: 'nowrap' }}>
                      {isEditing
                        ? <input value={row.unitWeight ?? ''} type="number" min="0" step="0.1" placeholder="kg/m"
                            onChange={e => setEditBuf(b => ({ ...b, unitWeight: e.target.value === '' ? null : +e.target.value }))}
                            style={{ ...ei, width: '60px' }} />
                        : item.unitWeight != null
                          ? <span style={{ fontSize: '10px', color: '#64748b' }}>{item.unitWeight.toFixed(1)}</span>
                          : <span style={{ fontSize: '10px', color: '#1e293b' }}>—</span>}
                    </td>
                    <td style={{ ...td, fontWeight: 700, color: item.totalWeight != null ? '#f59e0b' : '#1e293b', whiteSpace: 'nowrap' }}>
                      {item.totalWeight != null ? `${item.totalWeight.toFixed(1)} kg` : '—'}
                    </td>
                    <td style={td}>
                      {isEditing
                        ? <input value={row.material ?? ''} onChange={e => setEditBuf(b => ({ ...b, material: e.target.value }))} style={{ ...ei, width: '80px' }} />
                        : item.material
                          ? <span style={{ padding: '2px 6px', borderRadius: '4px', fontSize: '10px', background: 'rgba(239,35,60,.08)', color: '#94a3b8' }}>{item.material}</span>
                          : '—'}
                    </td>
                    <td style={td}>
                      {isEditing
                        ? <input value={row.quantity ?? 1} type="number" min="1" onChange={e => setEditBuf(b => ({ ...b, quantity: +e.target.value }))} style={{ ...ei, width: '44px' }} />
                        : item.quantity}
                    </td>
                    <td style={{ ...td, color: '#1e293b', fontSize: '10px', whiteSpace: 'nowrap' }}>
                      {fmtTime(item.createdAt)}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {isEditing ? (
                        <span style={{ display: 'flex', gap: '3px' }}>
                          <button onClick={e => { e.stopPropagation(); saveEdit() }} disabled={saving} style={ab('#22c55e')}>
                            {saving ? '…' : '✓'}
                          </button>
                          <button onClick={e => { e.stopPropagation(); cancelEdit() }} style={ab('#475569')}>✕</button>
                        </span>
                      ) : (
                        <span style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                          {hasAnnot && (
                            <span title="Has drawing annotation" style={{ color: '#EF233C', display: 'flex' }}>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                              </svg>
                            </span>
                          )}
                          <button onClick={e => { e.stopPropagation(); startEdit(item) }} style={ab('#EF233C')}>
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
                <tr style={{ background: '#0D1526', borderTop: '1px solid rgba(239,35,60,.2)' }}>
                  <td colSpan={7} />
                  <td style={{ ...td, fontWeight: 800, color: '#22c55e', whiteSpace: 'nowrap' }}>
                    {totalLength > 0 ? `∑ ${fmt(totalLength)} ${getUnitLabel(unit)}` : ''}
                    {hasAnyArea && totalArea > 0 ? ` / ${fmt(totalArea)} ${getAreaUnitLabel(unit)}` : ''}
                    {totalLength === 0 && !hasAnyArea ? '—' : ''}
                  </td>
                  <td colSpan={3} />
                  <td style={{ ...td, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>
                    {hasAnyWeight ? `∑ ${totalWeight.toFixed(1)} kg` : '—'}
                  </td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div style={{
          padding: '6px 12px', borderTop: '1px solid rgba(255,255,255,.07)',
          background: '#0D1526', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: '10px', color: '#334155' }}>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div style={{ display: 'flex', gap: '3px' }}>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
              <button key={p} onClick={() => setPage(p)} style={{
                width: '22px', height: '22px', borderRadius: '4px', border: '1px solid',
                borderColor: p === page ? 'rgba(239,35,60,.4)' : 'rgba(255,255,255,.08)',
                background: p === page ? 'rgba(239,35,60,.15)' : 'transparent',
                color: p === page ? '#EF233C' : '#475569',
                fontSize: '10px', cursor: 'pointer', fontWeight: p === page ? 700 : 400,
              }}>{p}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function TotalChip({ label, value, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
      <span style={{ fontSize: '10px', color: '#334155' }}>{label}:</span>
      <span style={{ fontSize: '11px', fontWeight: 800, color }}>{value}</span>
    </div>
  )
}

const td   = { padding: '6px 8px', color: '#94a3b8', verticalAlign: 'middle' }
const ei   = {
  padding: '3px 5px', background: '#111827', border: '1px solid rgba(239,35,60,.4)',
  borderRadius: '4px', fontSize: '11px', color: '#f1f5f9', outline: 'none',
}
const ab   = (color) => ({
  width: '22px', height: '22px', borderRadius: '4px',
  border: `1px solid ${color}30`, background: `${color}12`,
  color, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px',
})
const iconBtn = {
  display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 9px', borderRadius: '5px',
  border: '1px solid', background: 'transparent', fontSize: '11px', fontWeight: 700,
  cursor: 'pointer', whiteSpace: 'nowrap',
}
