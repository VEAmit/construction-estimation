import { useState, useCallback, useEffect, useMemo, useRef, Fragment } from 'react'
import { memberScheduleService } from '../../services/memberScheduleService'
import { useAppStore } from '../../store/useAppStore'
import { steelSections } from '../../utils/steelSections'
import { toMeters } from '../../utils/calculations'
import { parseMemberScheduleNoteId } from '../../utils/memberMeasureLink'
import api from '../../services/api'
import toast from 'react-hot-toast'

const MEMBER_TYPES = ['Beam', 'Column', 'Brace', 'Purlin', 'Rafter', 'Plate', 'Girt', 'Other']

const emptyRow = {
  mark: '', memberSize: '', memberType: 'Column',
  unitWeight: 0, length: 0, quantity: 0, description: '', takeoffItemId: null, color: null,
}

const DISPLAY_HEADERS = ['Color', 'Mark', 'Section Size', 'Type', '']

function memberSearchText(item) {
  return [
    item?.id,
    item?.mark,
    item?.memberSize,
    item?.memberType,
    item?.description,
  ]
    .filter(value => value != null)
    .join(' ')
    .toLocaleLowerCase()
}

function isEditableKeyboardTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'))
}

/** Silently update a single takeoff item's color via the existing PUT endpoint. */
async function patchTakeoffItemColor(item, color) {
  await api.put(`/takeoffitems/${item.id}`, {
    mark: item.mark ?? '',
    description: item.description ?? '',
    length: item.length,
    area: item.area,
    quantity: item.quantity ?? 1,
    unit: item.unit ?? 'Mm',
    material: item.material ?? '',
    unitWeight: item.unitWeight,
    notes: item.notes ?? '',
    color,
    category: item.category ?? '',
    pointsJson: item.pointsJson,
  })
}

export default function MemberSchedulePanel({ drawing, onExport, onSelectMeasurement, selectedAnnotIds, onAssignMemberToSelection }) {
  const {
    memberScheduleItems, addMemberScheduleItem,
    updateMemberScheduleItem, removeMemberScheduleItem, takeoffItems,
    updateTakeoffItem,
    selectedMemberScheduleItem, setSelectedMemberScheduleItem, lastMeasureMember,
    setActiveTool, triggerPdfCommand, activeTool,
    selectedProject,
  } = useAppStore()

  const activeMeasureMember = selectedMemberScheduleItem ?? lastMeasureMember

  const findLinkedMeasurements = useCallback((member) => {
    if (!member) return []
    return takeoffItems.filter((t) => {
      if ((t.itemType || 'Line') !== 'Line') return false
      const mark = String(member.mark ?? '').trim()
      if (mark && String(t.material ?? '').trim() === mark) return true
      return parseMemberScheduleNoteId(t.notes) === member.id
    })
  }, [takeoffItems])

  const linkedMeasurements = findLinkedMeasurements(activeMeasureMember)

  const [editId, setEditId] = useState(null)
  const [editBuf, setEditBuf] = useState({})
  const [addMode, setAddMode] = useState(false)
  const [newRow, setNewRow] = useState({ ...emptyRow })
  const [saving, setSaving] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')

  // Bulk color update confirmation dialog state
  const [colorApplyDialog, setColorApplyDialog] = useState(null) // { item, newColor }
  const colorInputRefs = useRef({})
  const panelRef = useRef(null)
  const searchInputRef = useRef(null)
  const tableScrollRef = useRef(null)
  const panelHoveredRef = useRef(false)

  const indexedMembers = useMemo(() => (
    memberScheduleItems.map(item => ({ item, searchText: memberSearchText(item) }))
  ), [memberScheduleItems])

  const filteredMemberScheduleItems = useMemo(() => {
    const terms = memberSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return memberScheduleItems
    return indexedMembers
      .filter(entry => terms.every(term => entry.searchText.includes(term)))
      .map(entry => entry.item)
  }, [indexedMembers, memberScheduleItems, memberSearch])

  useEffect(() => {
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0
  }, [memberSearch])

  useEffect(() => {
    setMemberSearch('')
  }, [selectedProject?.id])

  useEffect(() => {
    const handleTypeToSearch = (event) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (isEditableKeyboardTarget(event.target)) return
      const panelHasFocus = panelRef.current?.contains(document.activeElement)
      if (!panelHasFocus && !panelHoveredRef.current) return

      if (event.key === 'Escape' && memberSearch) {
        event.preventDefault()
        event.stopPropagation()
        setMemberSearch('')
        return
      }
      if (event.key === 'Backspace' && memberSearch) {
        event.preventDefault()
        event.stopPropagation()
        setMemberSearch(value => value.slice(0, -1))
        return
      }
      if (event.key.length !== 1 || !/[\p{L}\p{N}._/-]/u.test(event.key)) return

      event.preventDefault()
      event.stopPropagation()
      setMemberSearch(value => `${value}${event.key}`)
      requestAnimationFrame(() => searchInputRef.current?.focus({ preventScroll: true }))
    }

    window.addEventListener('keydown', handleTypeToSearch, true)
    return () => window.removeEventListener('keydown', handleTypeToSearch, true)
  }, [memberSearch])

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
    if (!selectedProject?.id) { toast.error('Select a project first'); return }
    if (!newRow.mark) { toast.error('Member mark is required'); return }
    setSaving(true)
    try {
      const saved = await memberScheduleService.createForProject(selectedProject.id, newRow)
      addMemberScheduleItem(saved)
      setNewRow({ ...emptyRow })
      setAddMode(false)
      toast.success('Member added to project schedule')
    } catch (err) {
      toast.error(err?.response?.data?.message ?? 'Failed to save member')
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

    // Quick reassignment: with one or more measurements already selected
    // (on the PDF or in the grid), clicking a member here means "reassign
    // the selection to this member" instead of the usual "arm this member
    // for the next new draw" — a fast way to fix a wrongly-assigned member
    // without redrawing. Works identically for a single selected item or
    // several at once.
    if (selectedAnnotIds && selectedAnnotIds.size > 0) {
      onAssignMemberToSelection?.(item, [...selectedAnnotIds])
      toast.success(
        selectedAnnotIds.size > 1
          ? `${selectedAnnotIds.size} measurements reassigned to ${item.mark}`
          : `Measurement reassigned to ${item.mark}`,
        { duration: 2200, icon: '🔁' },
      )
      return
    }

    // If this member already has a measurement drawn, select it the same way
    // clicking its grid row or its label on the PDF does — highlighting it in
    // both places — in addition to arming the member for the next new draw.
    const linked = findLinkedMeasurements(item)
    if (linked.length > 0) onSelectMeasurement?.(linked[0].id)

    // Picking a member while Calibrate is active no longer force-switches the
    // tool to Linear (that used to silently drop the user out of Calibrate
    // mode). Instead it stays in Calibrate and links this member to the next
    // reference line drawn — one line then sets the new scale AND saves as
    // this member's measurement (finalizeLine/handleMeasure carry the member
    // through the calibration-save path).
    if (activeTool === 'calibrate') {
      setSelectedMemberScheduleItem(item)
      toast(`${item.mark} linked — draw the calibration line now`, { duration: 2600, icon: '📐' })
      return
    }
    setSelectedMemberScheduleItem(item)
    armLinearMeasureMode()
    toast.success(`${item.mark} selected — draw on the plan`, { duration: 2200, icon: '📐' })
  }, [activeTool, setSelectedMemberScheduleItem, armLinearMeasureMode, findLinkedMeasurements, onSelectMeasurement, selectedAnnotIds, onAssignMemberToSelection])

  /** Called when user picks a new color from the color input. Shows apply-all dialog. */
  const handleColorChange = useCallback((item, newColor) => {
    // Count matching measurements
    const matching = takeoffItems.filter(t => {
      if ((t.itemType || 'Line') !== 'Line') return false
      return String(t.material ?? '').trim() === String(item.mark ?? '').trim()
    })
    if (matching.length > 0) {
      setColorApplyDialog({ item, newColor, matching })
    } else {
      applyColorToMember(item, newColor, [])
    }
  }, [takeoffItems])

  const applyColorToMember = useCallback(async (item, newColor, measurementsToUpdate) => {
    try {
      const updated = await memberScheduleService.update({ ...item, color: newColor })
      updateMemberScheduleItem(updated)
      // If this member is currently selected, sync the toolbar color
      if (selectedMemberScheduleItem?.id === item.id) {
        useAppStore.getState().setMeasureColor(newColor)
      }
      if (measurementsToUpdate.length > 0) {
        await Promise.all(measurementsToUpdate.map(t => patchTakeoffItemColor(t, newColor)))
        measurementsToUpdate.forEach(t => updateTakeoffItem({ ...t, color: newColor }))
        toast.success(`Color updated — ${measurementsToUpdate.length} measurement(s) recolored`)
      } else {
        toast.success('Member color updated')
      }
    } catch {
      toast.error('Failed to update color')
    }
  }, [updateMemberScheduleItem, updateTakeoffItem, selectedMemberScheduleItem])

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

  const memberColor = (item) => item.color || '#EF233C'

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      aria-label="Project Member Schedule"
      onMouseEnter={() => { panelHoveredRef.current = true }}
      onMouseLeave={() => { panelHoveredRef.current = false }}
      onMouseDown={(event) => {
        if (!isEditableKeyboardTarget(event.target) && !event.target?.closest?.('button, a')) {
          panelRef.current?.focus({ preventScroll: true })
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: '#080B12', outline: 'none' }}
    >

      {/* Bulk color apply dialog */}
      {colorApplyDialog && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#111827', border: '1px solid rgba(239,35,60,.25)', borderRadius: 12,
            padding: '20px 24px', maxWidth: 360, width: '90%',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>
              Apply color to measurements?
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
              <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: colorApplyDialog.newColor, marginRight: 6, verticalAlign: 'middle' }} />
              {colorApplyDialog.matching.length} measurement(s) for <strong style={{ color: '#e2e8f0' }}>{colorApplyDialog.item.mark}</strong> can be recolored to match.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { applyColorToMember(colorApplyDialog.item, colorApplyDialog.newColor, []); setColorApplyDialog(null) }}
                style={{ ...ab('#475569'), width: 'auto', padding: '6px 14px', fontSize: 12 }}>
                Member only
              </button>
              <button
                onClick={() => { applyColorToMember(colorApplyDialog.item, colorApplyDialog.newColor, colorApplyDialog.matching); setColorApplyDialog(null) }}
                style={{ ...ab('#22c55e'), width: 'auto', padding: '6px 14px', fontSize: 12, fontWeight: 700 }}>
                Yes, all {colorApplyDialog.matching.length}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: '7px 12px', borderBottom: '1px solid rgba(255,255,255,.07)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: '8px', background: '#0D1526' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
          <div style={{ width: '2px', height: '16px', background: '#EF233C', borderRadius: '1px' }} />
          <span style={{ fontSize: '12px', fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            Project Member Schedule
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

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', flexShrink: 0,
        background: '#0A101D', borderBottom: '1px solid rgba(255,255,255,.06)',
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2"
            aria-hidden="true"
            style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            role="searchbox"
            value={memberSearch}
            onChange={event => setMemberSearch(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape' && memberSearch) {
                event.preventDefault()
                event.stopPropagation()
                setMemberSearch('')
              }
            }}
            placeholder="Search mark, ID, size or type…"
            aria-label="Search member schedule"
            autoComplete="off"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '6px 28px 6px 27px',
              background: 'rgba(255,255,255,.035)', border: '1px solid rgba(255,255,255,.1)',
              borderRadius: 6, color: '#e2e8f0', fontSize: 11, outline: 'none',
            }}
            onFocus={event => { event.currentTarget.style.borderColor = 'rgba(239,35,60,.5)' }}
            onBlur={event => { event.currentTarget.style.borderColor = 'rgba(255,255,255,.1)' }}
          />
          {memberSearch && (
            <button
              type="button"
              onClick={() => { setMemberSearch(''); searchInputRef.current?.focus() }}
              aria-label="Clear member search"
              title="Clear search (Esc)"
              style={{
                position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                width: 21, height: 21, border: 'none', borderRadius: 4,
                background: 'transparent', color: '#64748b', cursor: 'pointer', fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              ×
            </button>
          )}
        </div>
        <span
          title={`${filteredMemberScheduleItems.length} matching members out of ${memberScheduleItems.length}`}
          style={{ fontSize: 10, color: '#EF233C', fontWeight: 700, whiteSpace: 'nowrap' }}>
          {filteredMemberScheduleItems.length}/{memberScheduleItems.length}
        </span>
      </div>

      <div ref={tableScrollRef} style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: '#0D1526', zIndex: 1 }}>
              {DISPLAY_HEADERS.map((h, i) => (
                <th key={i} style={{ padding: '7px 8px', textAlign: i === 0 ? 'center' : 'left', fontSize: '10px',
                  fontWeight: 800, color: '#EF233C', textTransform: 'uppercase',
                  letterSpacing: '.07em', borderBottom: '2px solid rgba(239,35,60,.35)',
                  width: i === 0 ? '52px' : undefined }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {addMode && (
              <>
                <tr style={{ background: 'rgba(239,35,60,.06)', borderBottom: '1px solid rgba(239,35,60,.15)' }}>
                  <td style={{ padding: '4px 6px', width: '52px', textAlign: 'center' }}>
                    <div style={{ width: '24px', height: '24px', borderRadius: '5px', background: '#EF233C', margin: '0 auto', border: '2px solid rgba(255,255,255,.18)', opacity: 0.5 }} />
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

            {filteredMemberScheduleItems.length === 0 && !addMode ? (
              <tr>
                <td colSpan={DISPLAY_HEADERS.length} style={{ padding: '40px', textAlign: 'center' }}>
                  <div style={{ color: '#64748b', fontSize: '12px' }}>
                    {memberSearch
                      ? <>No members match <strong style={{ color: '#94a3b8' }}>“{memberSearch}”</strong></>
                      : <>No members — use <strong style={{ color: '#94a3b8' }}>Schedule Extract</strong> or Add Member</>}
                  </div>
                </td>
              </tr>
            ) : filteredMemberScheduleItems.map((item) => {
              const isEditing = editId === item.id
              const isSelected = selectedMemberScheduleItem?.id === item.id
                || activeMeasureMember?.id === item.id
              const row = isEditing ? editBuf : item
              const color = memberColor(item)

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
                    {/* Color swatch — click to open color picker */}
                    <td style={{ padding: '4px 6px', width: '52px', textAlign: 'center' }}
                      onClick={e => { e.stopPropagation(); colorInputRefs.current[item.id]?.click() }}
                      title="Click to change member color">
                      <div style={{
                        width: '24px', height: '24px', borderRadius: '5px',
                        background: color, cursor: 'pointer', margin: '0 auto',
                        border: '2px solid rgba(255,255,255,.18)',
                        boxShadow: `0 0 7px ${color}70`,
                      }} />
                      <input
                        ref={el => { colorInputRefs.current[item.id] = el }}
                        type="color"
                        value={color}
                        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                        onChange={e => handleColorChange(item, e.target.value)}
                      />
                    </td>
                    <td style={{ ...td, fontWeight: 700 }}>
                      {/* Color dot + mark */}
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{
                          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                          background: color, flexShrink: 0, boxShadow: `0 0 4px ${color}80`,
                        }} />
                        {isEditing
                          ? <input value={row.mark} onChange={e => setEditBuf(b => ({ ...b, mark: e.target.value }))} style={{ ...ei, width: '64px' }} />
                          : <span style={{ color }}>{item.mark || '—'}</span>}
                      </span>
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
                            background: `${color}18`, color: '#94a3b8', fontWeight: 600,
                            border: `1px solid ${color}30` }}>
                            {item.memberType}
                          </span>}
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
