import { Eye, Layers3, MapPin, MousePointer2, Pencil, Play, Square, Trash2, Undo2 } from 'lucide-react'
import {
  getCountedSectionPlacements,
  getSectionGroupQuantity,
  getSectionPlacementCount,
} from '../../utils/sectionQuantity'

function readSectionMembers(section) {
  try {
    const template = typeof section?.templateJson === 'string'
      ? JSON.parse(section.templateJson)
      : section?.templateJson
    const counts = new Map()
    ;(template?.measurements ?? []).forEach(measurement => {
      const mark = String(
        measurement?.mark
        ?? measurement?.properties?.material
        ?? measurement?.properties?.description
        ?? '',
      ).trim()
      if (!mark) return
      counts.set(mark, (counts.get(mark) ?? 0) + 1)
    })
    return [...counts.entries()].map(([mark, count]) => ({ mark, count }))
  } catch {
    return []
  }
}

function readSectionPlaceSummary(section, drawings) {
  const grouped = new Map()
  getCountedSectionPlacements(section).forEach(placement => {
    const drawingId = Number(placement?.drawingId)
    const pageNumber = Number(placement?.pageNumber) || 1
    const drawing = drawings.find(item => Number(item.id) === drawingId)
    const drawingName = drawing?.name ?? drawing?.fileName ?? `Drawing #${drawingId}`
    const key = `${drawingId}:${pageNumber}`
    const existing = grouped.get(key)
    grouped.set(key, {
      drawingName,
      pageNumber,
      count: (existing?.count ?? 0) + 1,
    })
  })
  return [...grouped.values()]
    .map(location => `${location.drawingName} · p${location.pageNumber} ×${location.count}`)
    .join(' | ')
}

function SectionEmpty({ onCreate }) {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 20, boxSizing: 'border-box' }}>
      <div style={{ textAlign: 'center', maxWidth: 440 }}>
        <span style={{
          width: 46, height: 46, display: 'inline-grid', placeItems: 'center', borderRadius: 10,
          color: '#EF233C', border: '1px solid rgba(239,35,60,.28)', background: 'rgba(239,35,60,.08)',
        }}><Layers3 size={23} /></span>
        <div style={{ marginTop: 10, color: '#e2e8f0', fontSize: 13, fontWeight: 800 }}>No section groups on this PDF</div>
        <div style={{ margin: '5px auto 13px', color: '#64748b', fontSize: 11, lineHeight: 1.5 }}>
          Choose Section Measurements, draw a rectangle around existing measurements, then give the group a name.
        </div>
        <button type="button" onClick={onCreate} style={primaryButton}>
          <Square size={13} /> Create First Section
        </button>
      </div>
    </div>
  )
}

export default function SectionMeasurementsPanel({
  sections = [],
  activeSectionId = null,
  placing = false,
  onCreate,
  onActivate,
  onStop,
  onDelete,
  onUndoLastPlacement,
  onViewSource,
  onToggleVisibility,
  onEdit,
  drawings = [],
  focusedSectionId = null,
  visibleSectionIds = new Set(),
  editingSectionId = null,
}) {
  if (!sections.length) return <SectionEmpty onCreate={onCreate} />

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#080B12' }}>
      <div style={{
        flexShrink: 0, minHeight: 44, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 9,
        borderBottom: '1px solid rgba(255,255,255,.07)', background: '#0B1320',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#e2e8f0', fontSize: 11, fontWeight: 800 }}>PDF SECTION GROUPS</div>
          <div style={{ color: '#64748b', fontSize: 9 }}>Counting groups never creates duplicate measurement rows</div>
        </div>
        {placing && activeSectionId ? (
          <button type="button" onClick={onStop} style={stopButton}>Finish Placement</button>
        ) : (
          <button type="button" onClick={onCreate} style={primaryButton}><Square size={12} /> New Section</button>
        )}
      </div>

      {placing && activeSectionId && (
        <div style={{
          flexShrink: 0, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 7,
          color: '#fbbf24', background: 'rgba(245,158,11,.08)', borderBottom: '1px solid rgba(245,158,11,.18)',
          fontSize: 10, fontWeight: 650,
        }}>
          <MousePointer2 size={13} /> Click each drawing location where the active section occurs. Pan and zoom remain available.
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: '#0D1526' }}>
            <tr>
              {[
                ['SECTION NAME', '33%'],
                ['COLOR', '6%'],
                ['MEASUREMENTS', '14%'],
                ['USED', '14%'],
                ['GROUP QTY', '13%'],
                ['ACTIONS', '20%'],
              ].map(([label, width]) => (
                <th key={label} style={{ ...thStyle, width }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map(section => {
              const active = Number(section.id) === Number(activeSectionId)
              const focused = Number(section.id) === Number(focusedSectionId)
              const visible = visibleSectionIds.has(Number(section.id))
              const editing = Number(section.id) === Number(editingSectionId)
              const used = getSectionPlacementCount(section)
              const measurements = Number(section.measurementCount ?? 0)
              const groupQuantity = getSectionGroupQuantity(section)
              const removable = [...getCountedSectionPlacements(section)].reverse()[0]
              const sourceDrawing = drawings.find(drawing => Number(drawing.id) === Number(section.sourceDrawingId))
              const sourceName = sourceDrawing?.name ?? sourceDrawing?.fileName ?? `Drawing #${section.sourceDrawingId}`
              const members = readSectionMembers(section)
              const memberSummary = members.length
                ? members.map(({ mark, count }) => `${mark}${count > 1 ? ` ×${count}` : ''}`).join(', ')
                : 'No member marks stored'
              const placeSummary = readSectionPlaceSummary(section, drawings) || 'No counted locations'
              const sectionColor = /^#[0-9A-Fa-f]{6}$/.test(section.color ?? '') ? section.color : '#3B82F6'
              return (
                <tr key={section.id} style={{ background: active || focused ? `${sectionColor}14` : 'transparent' }}>
                  <td style={tdStyle}>
                    <button type="button" onClick={() => onViewSource?.(section)} title="Open the source PDF and highlight this section"
                      style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, width: '100%', padding: 0, textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer' }}>
                      <span title={`Section color ${sectionColor}`} style={{ width: 4, height: 39, borderRadius: 2, background: sectionColor, flexShrink: 0 }} />
                      <div style={{ minWidth: 0, lineHeight: 1.35 }}>
                        <div style={{ color: active ? '#fff' : '#e2e8f0', fontSize: 11, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{section.name}</div>
                        <div title={sourceName} style={{ color: '#60a5fa', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          Source: {sourceName} · Page {section.sourcePageNumber ?? 1}
                        </div>
                        <div title={memberSummary} style={{ color: '#64748b', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          Members: {memberSummary}
                        </div>
                      </div>
                    </button>
                  </td>
                  <td style={tdStyle}>
                    <span title={`Section group color ${sectionColor}`} aria-label={`Section color ${sectionColor}`}
                      style={{ display: 'inline-block', width: 17, height: 17, borderRadius: 4, background: sectionColor, border: '1px solid rgba(255,255,255,.45)', boxShadow: `0 0 0 2px ${sectionColor}22`, verticalAlign: 'middle' }} />
                  </td>
                  <td style={tdStyle}><strong style={{ color: '#93c5fd' }}>{measurements}</strong></td>
                  <td style={tdStyle}>
                    <button type="button" onClick={() => onToggleVisibility?.(section)}
                      aria-pressed={visible}
                      title={visible ? 'Hide this section on the current PDF' : `Show all ${used} counted place${used === 1 ? '' : 's'} on the PDF`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, color: visible ? '#fbbf24' : '#22c55e', background: 'transparent', border: 0, cursor: 'pointer', fontSize: 10, fontWeight: 800 }}>
                      <MapPin size={11} /> {used} {used === 1 ? 'Place' : 'Places'}
                    </button>
                    <div title={placeSummary} style={{ marginTop: 2, color: '#64748b', fontSize: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {placeSummary}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <span title="Source measurements plus every counted placement" style={{ color: '#fbbf24', fontSize: 11, fontWeight: 800 }}>
                      {groupQuantity}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <button type="button" onClick={() => onToggleVisibility?.(section)}
                        aria-pressed={visible}
                        title={visible ? 'Hide section and counted-place highlights' : `Show all ${used} counted place${used === 1 ? '' : 's'} on this PDF`}
                        style={{ ...iconButton, color: visible ? '#fbbf24' : '#60a5fa', borderColor: visible ? 'rgba(245,158,11,.35)' : 'rgba(96,165,250,.28)' }}>
                        <Eye size={12} />
                      </button>
                      <button type="button" onClick={() => onEdit?.(section)}
                        aria-pressed={editing}
                        title={editing ? 'Cancel editing and restore the saved section' : 'Resize or update this section boundary'}
                        style={{ ...iconButton, color: editing ? '#fbbf24' : '#c084fc', borderColor: editing ? 'rgba(245,158,11,.35)' : 'rgba(192,132,252,.28)' }}>
                        <Pencil size={12} />
                      </button>
                      <button type="button" onClick={() => active ? onStop?.() : onActivate?.(section)}
                        title={active ? 'Finish placing this section' : 'Activate and count this section'}
                        style={{ ...iconButton, color: active ? '#fbbf24' : '#22c55e', borderColor: active ? 'rgba(245,158,11,.35)' : 'rgba(34,197,94,.28)' }}>
                        {active ? <Square size={12} /> : <Play size={12} />}
                      </button>
                      {removable && (
                        <button type="button" onClick={() => onUndoLastPlacement?.(section, removable)}
                          title="Remove the most recent additional counted location" style={iconButton}>
                          <Undo2 size={12} />
                        </button>
                      )}
                      <button type="button" onClick={() => onDelete?.(section)} title="Delete section group"
                        style={{ ...iconButton, color: '#f87171', borderColor: 'rgba(248,113,113,.25)' }}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const primaryButton = {
  display: 'inline-flex', alignItems: 'center', gap: 5, height: 29, padding: '0 11px', borderRadius: 6,
  border: '1px solid #EF233C', color: '#fff', background: '#EF233C', cursor: 'pointer', fontSize: 10, fontWeight: 800,
}

const stopButton = {
  ...primaryButton, color: '#fbbf24', background: 'rgba(245,158,11,.1)', borderColor: 'rgba(245,158,11,.4)',
}

const iconButton = {
  width: 27, height: 27, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 5,
  color: '#94a3b8', background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.1)', cursor: 'pointer',
}

const thStyle = {
  height: 31, padding: '0 9px', textAlign: 'left', color: '#EF233C', borderBottom: '1px solid rgba(239,35,60,.38)',
  fontSize: 9, fontWeight: 800, letterSpacing: '.05em', whiteSpace: 'nowrap',
}

const tdStyle = {
  height: 54, padding: '4px 9px', color: '#94a3b8', borderBottom: '1px solid rgba(255,255,255,.055)',
  fontSize: 10, verticalAlign: 'middle', overflow: 'hidden',
}
