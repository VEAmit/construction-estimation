import { useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useBreakpoint } from '../../utils/useBreakpoint'
import { CATEGORY_COLORS } from '../../utils/calculations'
import {
  MEASURE_LABEL_PRESETS, defaultLineThicknessForLabelSize,
  MIN_MEASURE_LABEL_SIZE, MAX_MEASURE_LABEL_SIZE,
} from '../../utils/measureLabel'

// ── Measure tools ────────────────────────────────────────────────────────
const MEASURE_TOOLS = [
  {
    id: 'line', label: 'Linear', shortcut: 'L', color: '#EF233C',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="5" y1="19" x2="19" y2="5"/>
      <circle cx="5" cy="19" r="2" fill="currentColor"/>
      <circle cx="19" cy="5" r="2" fill="currentColor"/>
    </svg>,
  },
  {
    id: 'area', label: 'Area', shortcut: 'A', color: '#22c55e',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
    </svg>,
  },
  {
    id: 'perimeter', label: 'Polyline', shortcut: 'P', color: '#8b5cf6',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 18 8 6 14 14 18 10"/>
    </svg>,
  },
  {
    id: 'count', label: 'Count', shortcut: 'N', color: '#f59e0b',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="8" cy="8" r="3"/>
      <circle cx="16" cy="8" r="3"/>
      <circle cx="8" cy="16" r="3"/>
      <circle cx="16" cy="16" r="3"/>
    </svg>,
  },
  {
    id: 'calibrate', label: 'Calibrate', shortcut: 'C', color: '#F59E0B',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12h3m12 0h3M12 3v3m0 12v3"/>
      <circle cx="12" cy="12" r="4"/>
    </svg>,
  },
]

// ── Navigation tools ─────────────────────────────────────────────────────
const NAV_TOOLS = [
  {
    id: 'select', label: 'Select', shortcut: 'S',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 4l7.07 17 2.51-7.39L21 11.07z"/>
    </svg>,
  },
  {
    id: 'pan', label: 'Pan', shortcut: 'H',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8l-1.27-1.34a1.75 1.75 0 0 0-2.48 2.47L5 19c.94 1.25 2.37 2 3.9 2h5.1c2.21 0 4-1.79 4-4v-5a2 2 0 0 0-4 0z"/>
    </svg>,
  },
]

// ── Markup tools ─────────────────────────────────────────────────────────
const MARKUP_TOOLS = [
  {
    id: 'arrow', label: 'Arrow', color: '#60a5fa',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="5" y1="19" x2="19" y2="5"/>
      <polyline points="9 5 19 5 19 15"/>
    </svg>,
  },
  {
    id: 'rect', label: 'Rect', color: '#60a5fa',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="6" width="18" height="12" rx="1"/>
    </svg>,
  },
  {
    id: 'circle', label: 'Circle', color: '#60a5fa',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9"/>
    </svg>,
  },
  {
    id: 'polygon', label: 'Shape', color: '#60a5fa',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="12 3 20 8 20 16 12 21 4 16 4 8"/>
    </svg>,
  },
  {
    id: 'text', label: 'Text', color: '#60a5fa',
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 7 4 4 20 4 20 7"/>
      <line x1="9" y1="20" x2="15" y2="20"/>
      <line x1="12" y1="4" x2="12" y2="20"/>
    </svg>,
  },
]

const COLORS = [
  '#EF233C', '#3b82f6', '#22c55e', '#f59e0b',
  '#8b5cf6', '#06b6d4', '#f97316', '#ec4899',
]

const CATEGORIES = [
  'General', 'Structural', 'Concrete', 'Roofing',
  'Electrical', 'Plumbing', 'HVAC', 'Flooring',
  'Painting', 'Demolition',
  'Beam', 'Column', 'Rafter', 'Purlin', 'Brace', 'Wall', 'Slab', 'Girt', 'Other',
]

// Count sub-types for the count tool
const COUNT_SUBTYPES = [
  'Door', 'Window', 'Column', 'Beam', 'Fixture',
  'Light', 'Outlet', 'Valve', 'Equipment', 'Other',
]

const THICKNESSES = [1, 2, 3, 5, 8]
const OPACITIES   = [0.1, 0.2, 0.3, 0.5, 0.7, 1.0]
const FONT_SIZES  = [8, 10, 12, 14, 18, 24, 36, 48]

const LINE_STYLES = [
  { id: 'solid',  label: '—',   title: 'Solid line' },
  { id: 'dashed', label: '- -', title: 'Dashed line' },
  { id: 'dotted', label: '···', title: 'Dotted line' },
]

const ARROW_STYLES = [
  { id: 'end',   label: '→',  title: 'End arrow' },
  { id: 'start', label: '←',  title: 'Start arrow' },
  { id: 'both',  label: '↔',  title: 'Both arrows' },
]

const LINE_MEASURE_MODES = [
  { id: 'simple', label: 'Simple', title: 'Simple Line — plain measurement line (no arrowheads)' },
  { id: 'arrow',  label: 'Arrow',  title: 'Arrow Line — measurement line with arrowheads' },
]

const ALL_MEASURE_IDS = MEASURE_TOOLS.map(t => t.id)
const ALL_MARKUP_IDS  = MARKUP_TOOLS.map(t => t.id)
const STYLE_LABEL_COLOR = '#EF233C'

export default function Toolbar({
  isCalibrated = false,
  calibrateLineReady = false,
  onPickMeasureTool,
  onSaveCalib,
  onCopyMeasurement,
  onPasteMeasurement,
  canCopy = false,
  canPaste = false,
}) {
  const {
    activeTool, setActiveTool,
    pdfScale, setPdfScale,
    wheelZoomSensitivity, setWheelZoomSensitivity,
    pdfPage, setPdfPage, pdfTotalPages,
    triggerPdfCommand,
    measureColor,    setMeasureColor,
    measureCategory, setMeasureCategory,
    lineThickness,   setLineThickness,
    fillOpacity,     setFillOpacity,
    lineStyle,       setLineStyle,
    arrowStyle,      setArrowStyle,
    linearLineMode,  setLinearLineMode,
    fontSize,        setFontSize,
    measureLabelFontSize, setMeasureLabelFontSize,
    countSession,
    selectedMemberScheduleItem, lastMeasureMember,
  } = useAppStore()

  const activeMember = selectedMemberScheduleItem ?? lastMeasureMember
  const memberColor  = activeMember?.color || measureColor

  const { isMobile, isTablet } = useBreakpoint()
  const compact = isMobile || isTablet

  const isNav     = ['select', 'pan'].includes(activeTool)
  const isMeasure = ALL_MEASURE_IDS.includes(activeTool)
  const isMarkup  = ALL_MARKUP_IDS.includes(activeTool)
  const isCount   = activeTool === 'count'
  const isLine    = activeTool === 'line' || activeTool === 'perimeter' || activeTool === 'calibrate'
  const showStyleBar = isMeasure || isMarkup

  const handleLineModeChange = (mode) => {
    setLinearLineMode(mode)
    if (mode === 'simple') setArrowStyle('none')
    else if (arrowStyle === 'none') setArrowStyle('both')
  }

  const handleArrowStyleChange = (id) => {
    setLinearLineMode('arrow')
    setArrowStyle(id)
  }

  const pickTool = (toolId) => {
    if (onPickMeasureTool && ALL_MEASURE_IDS.includes(toolId)) {
      onPickMeasureTool(toolId)
    } else {
      setActiveTool(toolId)
    }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.ctrlKey || e.metaKey || e.altKey) return
      const all = [...NAV_TOOLS, ...MEASURE_TOOLS]
      const tool = all.find(t => t.shortcut && t.shortcut === e.key.toUpperCase())
      if (tool) { pickTool(tool.id); return }
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setPdfScale(s => Math.min(5, +(s + 0.1).toFixed(2))) }
      if (e.key === '-') { e.preventDefault(); setPdfScale(s => Math.max(0.25, +(s - 0.1).toFixed(2))) }
      if (e.key === '0') { e.preventDefault(); triggerPdfCommand('fitPage') }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setActiveTool, setPdfScale, triggerPdfCommand, onPickMeasureTool])

  // ── Auto-color from category ───────────────────────────────────────────
  const handleCategoryChange = (cat) => {
    setMeasureCategory(cat)
    const auto = CATEGORY_COLORS[cat]
    if (auto) setMeasureColor(auto)
  }

  const goToPrev = () => setPdfPage(p => Math.max(1, p - 1))
  const goToNext = () => setPdfPage(p => Math.min(pdfTotalPages, p + 1))

  // ── Active tool accent color ───────────────────────────────────────────
  const toolColor = (id) => {
    const t = [...NAV_TOOLS, ...MEASURE_TOOLS, ...MARKUP_TOOLS].find(x => x.id === id)
    return t?.color ?? '#64748b'
  }

  const activeAccent = toolColor(activeTool)

  return (
    <div style={{
      background: '#0D1526',
      borderBottom: '1px solid rgba(255,255,255,.07)',
      display: 'flex', flexDirection: 'column',
      flexShrink: 0,
    }}>
      <style>{`@keyframes calibPulse { 0%,100%{ box-shadow: 0 0 0 0 rgba(34,197,94,.4); } 50%{ box-shadow: 0 0 0 4px rgba(34,197,94,.15); } }`}</style>

      {/* ── Row 1: Tool groups ─────────────────────────────────────────── */}
      <div style={{
        height: '44px', display: 'flex', alignItems: 'center',
        overflowX: 'auto', overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', gap: '2px', minWidth: 'max-content', height: '100%' }}>

          {/* ── Navigation group ── */}
          <GroupLabel label="Nav" />
          {NAV_TOOLS.map(tool => (
            <ToolBtn key={tool.id} tool={tool} active={activeTool === tool.id}
              compact={compact} onClick={() => setActiveTool(tool.id)} />
          ))}

          <Sep />

          {/* ── Measure group ── */}
          <GroupLabel label="Measure" />
          {MEASURE_TOOLS.map(tool => (
            <ToolBtn key={tool.id} tool={tool} active={activeTool === tool.id}
              compact={compact}
              titleHint={
                !isCalibrated && ['line', 'area', 'perimeter'].includes(tool.id)
                  ? ' — calibrate scale first'
                  : ''
              }
              onClick={() => pickTool(tool.id)} />
          ))}

          <Sep />

          {/* ── Markup group ── */}
          <GroupLabel label="Markup" />
          {MARKUP_TOOLS.map(tool => (
            <ToolBtn key={tool.id} tool={tool} active={activeTool === tool.id}
              compact={compact} onClick={() => setActiveTool(tool.id)} />
          ))}

          <Sep />

          {/* ── Action buttons ── */}
          {isCount ? (
            /* Count: save button shows running count and calls saveCount */
            <button onClick={() => triggerPdfCommand('saveCount')} title="Save count markers"
              style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                padding: '4px 10px', borderRadius: '6px',
                border: '1px solid rgba(245,158,11,.5)',
                background: 'rgba(245,158,11,.18)',
                color: '#f59e0b',
                fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                whiteSpace: 'nowrap', flexShrink: 0, touchAction: 'manipulation',
              }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              {compact ? `${countSession}` : `Save Count (${countSession})`}
            </button>
          ) : (isMeasure || isMarkup) ? (
            <button
              onClick={() => (activeTool === 'calibrate' ? onSaveCalib?.() : triggerPdfCommand('captureAnnotations'))}
              title={activeTool === 'calibrate' ? 'Enter real-world length for calibration line' : 'Save drawn annotations'}
              style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                padding: '4px 10px', borderRadius: '6px',
                border: activeTool === 'calibrate'
                  ? `1px solid ${calibrateLineReady ? '#22c55e' : '#F59E0B'}`
                  : `1px solid ${measureColor}66`,
                background: activeTool === 'calibrate'
                  ? (calibrateLineReady ? 'rgba(34,197,94,.2)' : 'rgba(245,158,11,.2)')
                  : `${measureColor}18`,
                color: activeTool === 'calibrate'
                  ? (calibrateLineReady ? '#22c55e' : '#F59E0B')
                  : measureColor,
                fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                whiteSpace: 'nowrap', flexShrink: 0, touchAction: 'manipulation',
                animation: activeTool === 'calibrate' && calibrateLineReady ? 'calibPulse 1.5s ease-in-out infinite' : 'none',
              }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              {compact ? '✓' : activeTool === 'area' ? 'Save Area' : activeTool === 'perimeter' ? 'Save Polyline' : activeTool === 'calibrate' ? 'Save Calib' : 'Save'}
            </button>
          ) : null}

          <button onClick={() => triggerPdfCommand('clearAnnotations')} title="Undo last measurement (removes from PDF and grid)"
            style={{
              ...zBtn,
              display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '4px 8px',
              touchAction: 'manipulation', color: '#EF233C', borderColor: 'rgba(239,35,60,.35)',
            }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            </svg>
            {!compact && 'Clear'}
          </button>

          <>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (canCopy) onCopyMeasurement?.()
                }}
                disabled={!canCopy}
                title="Copy measurement (Ctrl+C)"
                style={{ ...zBtn, opacity: canCopy ? 1 : 0.4, display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '4px 8px', touchAction: 'manipulation' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                {!compact && 'Copy'}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (canPaste) onPasteMeasurement?.()
                }}
                disabled={!canPaste}
                title="Paste measurement (Ctrl+V), then click to place"
                style={{ ...zBtn, opacity: canPaste ? 1 : 0.4, display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '4px 8px', touchAction: 'manipulation' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                  <rect x="8" y="2" width="8" height="4" rx="1"/>
                </svg>
                {!compact && 'Paste'}
              </button>
            </>

          <Sep />

          {/* ── Page navigation ── */}
          {pdfTotalPages > 1 && (
            <>
              <button onClick={goToPrev} disabled={pdfPage <= 1} style={navBtn(pdfPage <= 1)} title="Previous">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <span style={{ fontSize: '11px', color: '#64748b', minWidth: '40px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                {pdfPage}/{pdfTotalPages}
              </span>
              <button onClick={goToNext} disabled={pdfPage >= pdfTotalPages} style={navBtn(pdfPage >= pdfTotalPages)} title="Next">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <Sep />
            </>
          )}

          {/* ── Zoom ── */}
          <button onClick={() => setPdfScale(s => Math.max(0.25, +(s - 0.1).toFixed(2)))} style={zBtn} title="Zoom out">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>
            </svg>
          </button>
          <span style={{ fontSize: '11px', color: '#94a3b8', minWidth: '40px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(pdfScale * 100)}%
          </span>
          <button onClick={() => setPdfScale(s => Math.min(5, +(s + 0.1).toFixed(2)))} style={zBtn} title="Zoom in">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
            </svg>
          </button>
          <button onClick={() => triggerPdfCommand('fitPage')}
            style={{ ...zBtn, padding: '4px 8px', fontSize: '11px', color: '#EF233C', borderColor: 'rgba(239,35,60,.25)', touchAction: 'manipulation' }}
            title="Fit page [0]">
            Fit
          </button>

          {!compact && (
            <span style={{ fontSize: '10px', color: '#334155', marginLeft: '4px' }}>Wheel speed:</span>
          )}
          <select
            value={wheelZoomSensitivity ?? 1}
            onChange={e => setWheelZoomSensitivity(Number(e.target.value))}
            title="Mouse-wheel zoom speed"
            style={{
              background: '#111827', border: '1px solid rgba(255,255,255,.1)',
              color: '#94a3b8', fontSize: '11px', borderRadius: '5px',
              padding: '2px 6px', cursor: 'pointer', outline: 'none',
              appearance: 'none', WebkitAppearance: 'none', height: '22px',
              flexShrink: 0,
            }}>
            <option value={0.5}>Slow</option>
            <option value={1}>Normal</option>
            <option value={1.5}>Fast</option>
            <option value={2}>Fastest</option>
          </select>

          {/* Label size — global control (not tied to the active tool), so it's always
              available: pick a size before drawing, or select any existing measurement
              on the canvas/grid (in any tool, including Select) and change its size. */}
          <Sep />
          {!compact && (
            <span style={{ fontSize: '10px', color: '#334155' }}>Label:</span>
          )}
          <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
            {MEASURE_LABEL_PRESETS.map(p => (
              <button key={p.value} onClick={() => {
                setMeasureLabelFontSize(p.value)
                if (activeTool === 'line') setLineThickness(defaultLineThicknessForLabelSize(p.value))
              }} title={p.title}
                style={{
                  height: '22px', minWidth: '30px', padding: '0 7px',
                  borderRadius: '4px', fontSize: '10px', fontWeight: measureLabelFontSize === p.value ? 800 : 600,
                  border: `1px solid ${measureLabelFontSize === p.value ? 'rgba(239,35,60,.5)' : 'rgba(255,255,255,.08)'}`,
                  background: measureLabelFontSize === p.value ? 'rgba(239,35,60,.15)' : 'transparent',
                  color: measureLabelFontSize === p.value ? '#EF233C' : '#475569',
                  cursor: 'pointer', touchAction: 'manipulation', flexShrink: 0,
                }}>
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="number"
            min={MIN_MEASURE_LABEL_SIZE}
            max={MAX_MEASURE_LABEL_SIZE}
            step={1}
            value={measureLabelFontSize}
            title="Custom label size (pt) — applies to the selected measurement, or the next one you draw"
            onChange={(e) => {
              const raw = Number(e.target.value)
              if (!Number.isFinite(raw)) return
              const clamped = Math.min(MAX_MEASURE_LABEL_SIZE, Math.max(MIN_MEASURE_LABEL_SIZE, raw))
              setMeasureLabelFontSize(clamped)
              if (activeTool === 'line') setLineThickness(defaultLineThicknessForLabelSize(clamped))
            }}
            style={{
              width: '38px', height: '22px', padding: '0 4px',
              borderRadius: '4px', fontSize: '10px', fontWeight: 600,
              border: '1px solid rgba(255,255,255,.08)', background: 'transparent',
              color: '#475569', flexShrink: 0,
            }}
          />
          {!compact && (
            <span style={{ fontSize: '9px', color: '#334155', flexShrink: 0 }}>pt</span>
          )}
        </div>
      </div>

      {/* ── Row 2: Style bar — only when a drawing tool is active ─────────── */}
      {showStyleBar && (
        <div style={{
          height: isCount ? '44px' : '36px', display: 'flex', alignItems: 'center',
          background: '#090f1e', borderTop: '1px solid rgba(255,255,255,.06)',
          overflowX: 'auto', overflowY: 'hidden',
          WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', gap: '6px', minWidth: 'max-content', height: '100%' }}>

            {/* Active tool label */}
            <span style={{
              fontSize: '10px', fontWeight: 800, color: activeAccent,
              textTransform: 'uppercase', letterSpacing: '.08em',
              background: `${activeAccent}15`,
              border: `1px solid ${activeAccent}40`,
              padding: '2px 8px', borderRadius: '10px', flexShrink: 0,
            }}>
              {[...NAV_TOOLS, ...MEASURE_TOOLS, ...MARKUP_TOOLS].find(t => t.id === activeTool)?.label ?? activeTool}
            </span>

            <StyleSep />

            {/* ── Count tool: sub-type + live counter ── */}
            {isCount ? (
              <>
                <span style={{ fontSize: '10px', color: '#334155' }}>Type:</span>
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div style={{
                    position: 'absolute', left: '7px', top: '50%', transform: 'translateY(-50%)',
                    width: '7px', height: '7px', borderRadius: '50%',
                    background: measureColor, pointerEvents: 'none',
                  }} />
                  <select value={measureCategory} onChange={e => handleCategoryChange(e.target.value)}
                    style={{
                      background: '#111827', border: '1px solid rgba(255,255,255,.1)',
                      color: '#94a3b8', fontSize: '11px', borderRadius: '5px',
                      padding: '2px 8px 2px 20px', cursor: 'pointer', outline: 'none',
                      appearance: 'none', WebkitAppearance: 'none', height: '22px',
                    }}>
                    {COUNT_SUBTYPES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <StyleSep />
                {/* Color swatches */}
                <span style={{ fontSize: '10px', color: STYLE_LABEL_COLOR, fontWeight: 700, marginRight: '2px' }}>Color:</span>
                <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                  {COLORS.map(hex => (
                    <button key={hex} onClick={() => setMeasureColor(hex)} title={hex}
                      style={{
                        width: '16px', height: '16px', borderRadius: '50%', background: hex,
                        border: measureColor === hex ? '2px solid #fff' : '2px solid transparent',
                        cursor: 'pointer', padding: 0, flexShrink: 0,
                        boxShadow: measureColor === hex ? `0 0 0 1px ${hex}` : 'none',
                        touchAction: 'manipulation',
                      }} />
                  ))}
                </div>
                <StyleSep />
                {/* Live count badge */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0,
                  padding: '3px 10px', borderRadius: '8px',
                  background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)',
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2">
                    <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>
                  </svg>
                  <span style={{ fontSize: '12px', fontWeight: 800, color: '#f59e0b' }}>
                    {countSession}
                  </span>
                  <span style={{ fontSize: '10px', color: '#78716c' }}>placed</span>
                </div>
                {!compact && (
                  <>
                    <StyleSep />
                    <span style={{ fontSize: '11px', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                      </svg>
                      Click on drawing to count → Save Count when done
                    </span>
                  </>
                )}
              </>
            ) : (
              /* ── Normal measure/markup style controls ── */
              <>
                {/* Linear tool: member color indicator (no manual picker) */}
                {activeTool === 'line' ? (
                  <>
                    <span style={{ fontSize: '10px', color: STYLE_LABEL_COLOR, fontWeight: 700, marginRight: '2px' }}>Color:</span>
                    {activeMember ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '2px 8px', borderRadius: '8px', background: `${memberColor}15`, border: `1px solid ${memberColor}40` }}>
                        <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: memberColor, flexShrink: 0, boxShadow: `0 0 4px ${memberColor}80` }} />
                        <span style={{ fontSize: '11px', fontWeight: 700, color: memberColor }}>{activeMember.mark}</span>
                      </div>
                    ) : (
                      <span style={{ fontSize: '10px', color: '#475569', fontStyle: 'italic' }}>Select a member from the schedule</span>
                    )}
                  </>
                ) : (
                  /* Non-linear tools: show color swatches */
                  <>
                    <span style={{ fontSize: '10px', color: STYLE_LABEL_COLOR, fontWeight: 700, marginRight: '2px' }}>Color:</span>
                    <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                      {COLORS.map(hex => (
                        <button key={hex} onClick={() => setMeasureColor(hex)} title={hex}
                          style={{
                            width: '16px', height: '16px', borderRadius: '50%', background: hex,
                            border: measureColor === hex ? '2px solid #fff' : '2px solid transparent',
                            cursor: 'pointer', padding: 0, flexShrink: 0,
                            boxShadow: measureColor === hex ? `0 0 0 1px ${hex}` : 'none',
                            touchAction: 'manipulation',
                          }} />
                      ))}
                      <div style={{
                        width: '16px', height: '16px', borderRadius: '3px',
                        background: measureColor, border: '1px solid rgba(255,255,255,.2)',
                        flexShrink: 0,
                      }} title="Current color" />
                    </div>
                  </>
                )}

                {/* Font size — only for text tool */}
                {activeTool === 'text' && (
                  <>
                    <StyleSep />
                    <span style={{ fontSize: '10px', color: STYLE_LABEL_COLOR, fontWeight: 700 }}>Size:</span>
                    <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                      {FONT_SIZES.map(s => (
                        <button key={s} onClick={() => setFontSize(s)} title={`${s}pt`}
                          style={{
                            height: '22px', minWidth: '28px', padding: '0 6px',
                            borderRadius: '4px', fontSize: '11px', fontWeight: fontSize === s ? 800 : 500,
                            border: `1px solid ${fontSize === s ? 'rgba(239,35,60,.5)' : 'rgba(255,255,255,.08)'}`,
                            background: fontSize === s ? 'rgba(239,35,60,.15)' : 'transparent',
                            color: fontSize === s ? '#EF233C' : '#475569',
                            cursor: 'pointer', touchAction: 'manipulation', flexShrink: 0,
                          }}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Thickness — hidden for text tool */}
                {activeTool !== 'text' && (
                  <>
                    <StyleSep />
                    <span style={{ fontSize: '10px', color: STYLE_LABEL_COLOR, fontWeight: 700 }}>
                      {activeTool === 'line' ? 'Thickness (override):' : 'Thickness:'}
                    </span>
                    <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                      {THICKNESSES.map(t => (
                        <button key={t} onClick={() => {
                          setLineThickness(t)
                          if (activeTool === 'line') {
                            triggerPdfCommand({ type: 'applyLineThickness', thickness: t })
                          }
                        }} title={`${t}px`}
                          style={{
                            height: '22px', padding: '0 7px',
                            borderRadius: '4px', fontSize: '10px', fontWeight: 600,
                            border: `1px solid ${lineThickness === t ? 'rgba(239,35,60,.5)' : 'rgba(255,255,255,.08)'}`,
                            background: lineThickness === t ? 'rgba(239,35,60,.15)' : 'transparent',
                            color: lineThickness === t ? '#EF233C' : '#475569',
                            cursor: 'pointer', touchAction: 'manipulation', flexShrink: 0,
                            display: 'flex', alignItems: 'center', gap: '4px',
                          }}>
                          <div style={{ width: '14px', height: `${Math.min(t, 4)}px`, background: 'currentColor', borderRadius: '1px' }} />
                          {t}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Line style — for linear tools */}
                {(isLine || activeTool === 'area') && (
                  <>
                    <StyleSep />
                    <span style={{ fontSize: '10px', color: '#334155' }}>Style:</span>
                    <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                      {LINE_STYLES.map(ls => (
                        <button key={ls.id} onClick={() => setLineStyle(ls.id)} title={ls.title}
                          style={{
                            height: '22px', padding: '0 8px',
                            borderRadius: '4px', fontSize: '12px', fontWeight: 600,
                            border: `1px solid ${lineStyle === ls.id ? 'rgba(239,35,60,.5)' : 'rgba(255,255,255,.08)'}`,
                            background: lineStyle === ls.id ? 'rgba(239,35,60,.15)' : 'transparent',
                            color: lineStyle === ls.id ? '#EF233C' : '#475569',
                            cursor: 'pointer', touchAction: 'manipulation', flexShrink: 0,
                            letterSpacing: ls.id === 'dotted' ? '0.1em' : 'normal',
                          }}>
                          {ls.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Line mode — Simple vs Arrow (Linear tool only) */}
                {activeTool === 'line' && (
                  <>
                    <StyleSep />
                    <span style={{ fontSize: '10px', color: '#334155' }}>Line:</span>
                    <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                      {LINE_MEASURE_MODES.map(lm => (
                        <button key={lm.id} onClick={() => handleLineModeChange(lm.id)} title={lm.title}
                          style={{
                            height: '22px', padding: '0 8px',
                            borderRadius: '4px', fontSize: '10px', fontWeight: 600,
                            border: `1px solid ${linearLineMode === lm.id ? 'rgba(239,35,60,.5)' : 'rgba(255,255,255,.08)'}`,
                            background: linearLineMode === lm.id ? 'rgba(239,35,60,.15)' : 'transparent',
                            color: linearLineMode === lm.id ? '#EF233C' : '#475569',
                            cursor: 'pointer', touchAction: 'manipulation', flexShrink: 0,
                          }}>
                          {lm.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Arrow style — only when Arrow Line mode is active */}
                {(activeTool === 'arrow' || (activeTool === 'line' && linearLineMode === 'arrow')) && (
                  <>
                    <StyleSep />
                    <span style={{ fontSize: '10px', color: STYLE_LABEL_COLOR, fontWeight: 700 }}>Arrows:</span>
                    <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                      {ARROW_STYLES.map(as => (
                        <button key={as.id} onClick={() => handleArrowStyleChange(as.id)} title={as.title}
                          style={{
                            height: '22px', padding: '0 8px',
                            borderRadius: '4px', fontSize: '13px', fontWeight: 600,
                            border: `1px solid ${arrowStyle === as.id ? 'rgba(239,35,60,.5)' : 'rgba(255,255,255,.08)'}`,
                            background: arrowStyle === as.id ? 'rgba(239,35,60,.15)' : 'transparent',
                            color: arrowStyle === as.id ? '#EF233C' : '#475569',
                            cursor: 'pointer', touchAction: 'manipulation', flexShrink: 0,
                          }}>
                          {as.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Fill opacity — for area/markup tools, not text */}
                {(activeTool === 'area' || isMarkup) && activeTool !== 'text' && (
                  <>
                    <StyleSep />
                    <span style={{ fontSize: '10px', color: STYLE_LABEL_COLOR, fontWeight: 700 }}>Fill:</span>
                    <div style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                      {OPACITIES.map(o => (
                        <button key={o} onClick={() => setFillOpacity(o)} title={`${Math.round(o * 100)}% opacity`}
                          style={{
                            height: '22px', padding: '0 6px',
                            borderRadius: '4px', fontSize: '10px', fontWeight: 600,
                            border: `1px solid ${fillOpacity === o ? 'rgba(239,35,60,.5)' : 'rgba(255,255,255,.08)'}`,
                            background: fillOpacity === o ? 'rgba(239,35,60,.15)' : 'transparent',
                            color: fillOpacity === o ? '#EF233C' : '#475569',
                            cursor: 'pointer', touchAction: 'manipulation', flexShrink: 0,
                          }}>
                          {Math.round(o * 100)}%
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* Category — only for measure tools (not count) */}
                {isMeasure && !isCount && (
                  <>
                    <StyleSep />
                    <span style={{ fontSize: '10px', color: '#334155' }}>Category:</span>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{
                        position: 'absolute', left: '7px', top: '50%', transform: 'translateY(-50%)',
                        width: '7px', height: '7px', borderRadius: '50%',
                        background: CATEGORY_COLORS[measureCategory] ?? '#EF233C', pointerEvents: 'none',
                      }} />
                      <select value={measureCategory} onChange={e => handleCategoryChange(e.target.value)}
                        style={{
                          background: '#111827', border: '1px solid rgba(255,255,255,.1)',
                          color: '#94a3b8', fontSize: '11px', borderRadius: '5px',
                          padding: '2px 8px 2px 20px', cursor: 'pointer', outline: 'none',
                          appearance: 'none', WebkitAppearance: 'none', height: '22px',
                        }}>
                        {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                      </select>
                    </div>
                  </>
                )}

                {/* Calibrate hint */}
                {activeTool === 'calibrate' && !compact && (
                  <>
                    <StyleSep />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      {[
                        { step: '①', text: 'Click start point' },
                        { step: '②', text: 'Click end point on a known dimension' },
                        { step: '③', text: 'Save Calib → enter real length' },
                      ].map((s, i) => (
                        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#64748b', whiteSpace: 'nowrap' }}>
                          <span style={{ fontWeight: 800, color: '#F59E0B', fontSize: '12px' }}>{s.step}</span>
                          {s.text}
                          {i < 2 && <span style={{ color: '#1e293b', marginLeft: '2px' }}>›</span>}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────

function ToolBtn({ tool, active, compact, onClick, titleHint = '' }) {
  const accentColor = tool.color ?? '#64748b'
  return (
    <button
      onClick={onClick}
      title={tool.label + (tool.shortcut ? ` [${tool.shortcut}]` : '') + titleHint}
      style={{
        display: 'flex', alignItems: 'center', gap: '5px',
        padding: compact ? '5px 7px' : '5px 10px',
        borderRadius: '6px',
        border: `1px solid ${active ? `${accentColor}66` : 'transparent'}`,
        background: active ? `${accentColor}18` : 'transparent',
        color: active ? accentColor : '#64748b',
        cursor: 'pointer', fontSize: '12px', fontWeight: active ? 700 : 400,
        transition: 'all .15s', whiteSpace: 'nowrap', flexShrink: 0,
        touchAction: 'manipulation',
      }}
      onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,.06)'; e.currentTarget.style.color = '#94a3b8' }}}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b' }}}
    >
      {tool.icon}
      {!compact && tool.label}
    </button>
  )
}

function GroupLabel({ label }) {
  return (
    <span style={{
      fontSize: '9px', fontWeight: 800, color: '#1e293b',
      textTransform: 'uppercase', letterSpacing: '.1em',
      marginRight: '2px', flexShrink: 0, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function Sep() {
  return <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,.07)', margin: '0 4px', flexShrink: 0 }} />
}

function StyleSep() {
  return <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,.06)', margin: '0 4px', flexShrink: 0 }} />
}

const zBtn = {
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
