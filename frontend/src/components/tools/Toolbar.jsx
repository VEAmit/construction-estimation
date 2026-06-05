import { useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useBreakpoint } from '../../utils/useBreakpoint'

const TOOLS = [
  {
    id: 'select', label: 'Select', shortcut: 'S',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 4l7.07 17 2.51-7.39L21 11.07z"/>
    </svg>
  },
  {
    id: 'pan', label: 'Pan', shortcut: 'H',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8l-1.27-1.34a1.75 1.75 0 0 0-2.48 2.47L5 19c.94 1.25 2.37 2 3.9 2h5.1c2.21 0 4-1.79 4-4v-5a2 2 0 0 0-2-2 2 2 0 0 0-2 2z"/>
    </svg>
  },
  { type: 'separator' },
  {
    id: 'line', label: 'Measure', shortcut: 'L', color: '#EF233C',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="5" y1="19" x2="19" y2="5"/>
      <circle cx="5" cy="19" r="2" fill="currentColor"/>
      <circle cx="19" cy="5" r="2" fill="currentColor"/>
    </svg>
  },
  { type: 'separator' },
  {
    id: 'calibrate', label: 'Calibrate', shortcut: 'C', color: '#F59E0B',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12h3m12 0h3M12 3v3m0 12v3"/>
      <circle cx="12" cy="12" r="4"/>
      <path d="M8 8l2 2m4 4l2 2M8 16l2-2m4-4l2-2"/>
    </svg>
  },
]

const COLORS = [
  { hex: '#EF233C', label: 'Red' },
  { hex: '#3b82f6', label: 'Blue' },
  { hex: '#22c55e', label: 'Green' },
  { hex: '#f59e0b', label: 'Amber' },
  { hex: '#8b5cf6', label: 'Purple' },
  { hex: '#06b6d4', label: 'Cyan' },
  { hex: '#f97316', label: 'Orange' },
  { hex: '#ec4899', label: 'Pink' },
]

const CATEGORIES = ['General', 'Beam', 'Column', 'Rafter', 'Purlin', 'Brace', 'Wall', 'Slab']

export default function Toolbar() {
  const {
    activeTool, setActiveTool,
    pdfScale, setPdfScale,
    pdfPage, setPdfPage, pdfTotalPages,
    triggerPdfCommand,
    measureColor, setMeasureColor,
    measureCategory, setMeasureCategory,
  } = useAppStore()

  const { isMobile } = useBreakpoint()

  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const tool = TOOLS.find(t => t.shortcut && t.shortcut === e.key.toUpperCase())
      if (tool) { setActiveTool(tool.id); return }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setPdfScale(s => Math.min(5, +(s + 0.1).toFixed(2))) }
      if (e.key === '-') { e.preventDefault(); setPdfScale(s => Math.max(0.25, +(s - 0.1).toFixed(2))) }
      if (e.key === '0') { e.preventDefault(); triggerPdfCommand('fitPage') }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setActiveTool, setPdfScale, triggerPdfCommand])

  const goToPrev = () => setPdfPage(p => Math.max(1, p - 1))
  const goToNext = () => setPdfPage(p => Math.min(pdfTotalPages, p + 1))

  return (
    <div style={{
      height: '44px',
      background: '#0D1526',
      borderBottom: '1px solid rgba(255,255,255,.07)',
      display: 'flex',
      alignItems: 'center',
      flexShrink: 0,
      overflowX: 'auto',
      overflowY: 'hidden',
      WebkitOverflowScrolling: 'touch',
      scrollbarWidth: 'none',
      /* Hide scrollbar but keep functionality */
    }}>

      {/* Inner scrollable container */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '0 8px', gap: '2px',
        minWidth: 'max-content', height: '100%',
      }}>

        {/* Tool buttons */}
        {TOOLS.map((tool, i) => {
          if (tool.type === 'separator') {
            return <div key={i} style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,.07)', margin: '0 3px', flexShrink: 0 }} />
          }
          const active = activeTool === tool.id
          const accentColor = tool.color ?? '#64748b'
          return (
            <button
              key={tool.id}
              onClick={() => setActiveTool(tool.id)}
              title={`${tool.label} [${tool.shortcut}]`}
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: isMobile ? '5px 8px' : '5px 10px',
                borderRadius: '6px',
                border: `1px solid ${active ? `${accentColor}55` : 'transparent'}`,
                background: active ? `${accentColor}15` : 'transparent',
                color: active ? accentColor : '#64748b',
                cursor: 'pointer', fontSize: '12px',
                fontWeight: active ? 700 : 400, transition: 'all .15s',
                whiteSpace: 'nowrap', flexShrink: 0, touchAction: 'manipulation',
              }}
              onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,.06)'; e.currentTarget.style.color = '#94a3b8' }}}
              onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b' }}}
            >
              {tool.icon}
              {/* Hide labels on small mobile — icon only */}
              {!isMobile && tool.label}
            </button>
          )
        })}

        {/* Color + Category — Measure mode */}
        {activeTool === 'line' && (
          <>
            <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,.07)', margin: '0 4px', flexShrink: 0 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
              {COLORS.map(c => (
                <button key={c.hex} title={c.label} onClick={() => setMeasureColor(c.hex)}
                  style={{
                    width: '16px', height: '16px', borderRadius: '50%', background: c.hex,
                    border: measureColor === c.hex ? '2px solid #fff' : '2px solid transparent',
                    cursor: 'pointer', padding: 0, flexShrink: 0,
                    boxShadow: measureColor === c.hex ? `0 0 0 1px ${c.hex}` : 'none',
                    transition: 'border .1s', touchAction: 'manipulation',
                  }}
                />
              ))}
            </div>
            <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,.07)', margin: '0 4px', flexShrink: 0 }} />
            <select value={measureCategory} onChange={e => setMeasureCategory(e.target.value)}
              style={{
                background: '#111827', border: '1px solid rgba(255,255,255,.1)',
                color: '#94a3b8', fontSize: '11px', borderRadius: '5px',
                padding: '3px 6px', cursor: 'pointer', outline: 'none', flexShrink: 0,
              }}>
              {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
            </select>
            {!isMobile && (
              <>
                <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,.07)', margin: '0 4px', flexShrink: 0 }} />
                <div style={{
                  fontSize: '11px', color: '#EF233C',
                  background: 'rgba(239,35,60,.07)', border: '1px solid rgba(239,35,60,.2)',
                  padding: '3px 8px', borderRadius: '4px', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0,
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  Click pt1 → pt2 → Save
                </div>
              </>
            )}
          </>
        )}

        {/* Save Lines */}
        {(activeTool === 'line' || activeTool === 'calibrate') && (
          <button
            onClick={() => triggerPdfCommand('captureAnnotations')}
            title="Save drawn lines"
            style={{
              marginLeft: '4px', display: 'flex', alignItems: 'center', gap: '4px',
              padding: '4px 9px', borderRadius: '6px',
              border: activeTool === 'calibrate' ? '1px solid rgba(245,158,11,.4)' : '1px solid rgba(239,35,60,.4)',
              background: activeTool === 'calibrate' ? 'rgba(245,158,11,.08)' : 'rgba(239,35,60,.08)',
              color: activeTool === 'calibrate' ? '#f59e0b' : '#EF233C',
              fontSize: '11px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
              flexShrink: 0, touchAction: 'manipulation',
            }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Save
          </button>
        )}

        {activeTool === 'calibrate' && !isMobile && (
          <div style={{
            marginLeft: '6px', fontSize: '11px', color: '#fbbf24',
            background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.18)',
            padding: '3px 8px', borderRadius: '4px', whiteSpace: 'nowrap',
            display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0,
          }}>
            Draw line → Save → enter real length
          </div>
        )}

        {/* Spacer */}
        <div style={{ flexShrink: 0, minWidth: '8px' }} />

        {/* Clear */}
        <button onClick={() => triggerPdfCommand('clearAnnotations')}
          title="Clear drawn lines"
          style={{
            ...zoomBtn, display: 'flex', alignItems: 'center', gap: '4px',
            fontSize: '11px', padding: '4px 8px',
            color: '#64748b', borderColor: 'rgba(255,255,255,.07)', flexShrink: 0,
            touchAction: 'manipulation',
          }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          </svg>
          {!isMobile && 'Clear'}
        </button>

        <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,.07)', margin: '0 4px', flexShrink: 0 }} />

        {/* Page navigation */}
        {pdfTotalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '3px', marginRight: '6px', flexShrink: 0 }}>
            <button onClick={goToPrev} disabled={pdfPage <= 1} style={navBtn(pdfPage <= 1)} title="Previous page">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span style={{ fontSize: '11px', color: '#64748b', minWidth: isMobile ? '36px' : '56px', textAlign: 'center', whiteSpace: 'nowrap' }}>
              {pdfPage}/{pdfTotalPages}
            </span>
            <button onClick={goToNext} disabled={pdfPage >= pdfTotalPages} style={navBtn(pdfPage >= pdfTotalPages)} title="Next page">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        )}

        <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,.07)', margin: '0 4px', flexShrink: 0 }} />

        {/* Zoom */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
          <button onClick={() => setPdfScale(s => Math.max(0.25, +(s - 0.1).toFixed(2)))} style={zoomBtn} title="Zoom out [-]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              <line x1="8" y1="11" x2="14" y2="11"/>
            </svg>
          </button>
          <span style={{ fontSize: '11px', color: '#94a3b8', minWidth: '40px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(pdfScale * 100)}%
          </span>
          <button onClick={() => setPdfScale(s => Math.min(5, +(s + 0.1).toFixed(2)))} style={zoomBtn} title="Zoom in [+]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
            </svg>
          </button>
          <button onClick={() => triggerPdfCommand('fitPage')}
            style={{ ...zoomBtn, padding: '4px 8px', fontSize: '11px', color: '#EF233C', borderColor: 'rgba(239,35,60,.25)', touchAction: 'manipulation' }}
            title="Fit page [0]">
            Fit
          </button>
        </div>
      </div>
    </div>
  )
}

const zoomBtn = {
  background: 'none', border: '1px solid rgba(255,255,255,.08)', borderRadius: '5px',
  color: '#64748b', cursor: 'pointer', padding: '5px 7px', lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  transition: 'all .1s', flexShrink: 0, touchAction: 'manipulation',
}

const navBtn = (disabled) => ({
  background: 'none', border: '1px solid rgba(255,255,255,.08)', borderRadius: '5px',
  color: disabled ? '#1e293b' : '#64748b',
  cursor: disabled ? 'not-allowed' : 'pointer',
  padding: '4px 7px', lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  opacity: disabled ? 0.35 : 1, flexShrink: 0, touchAction: 'manipulation',
})
