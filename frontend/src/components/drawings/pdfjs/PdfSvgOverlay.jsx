import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../../store/useAppStore'
import { computeRealLengthFromDrawing } from '../../../utils/measureCalibration'
import { createRawLine, translateRawLine } from './pdfGeometryAdapter'
import { DEFAULT_MEASURE_LABEL_SIZE, MIN_MEASURE_LABEL_SIZE, MAX_MEASURE_LABEL_SIZE } from '../../../utils/measureLabel'

// Minimum on-screen distance (CSS px) between a Linear/Calibrate line's two
// points for it to count as an intentional line rather than an accidental
// click/double-click. See finalizeLine, where this is converted to PDF page
// units via the current zoom.
const MIN_LINE_SCREEN_PIXELS = 6

function toPdfPoint(event, svg, pageSize) {
  const rect = svg.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * pageSize.width,
    y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * pageSize.height,
  }
}

function dashArray(style) {
  if (String(style).toLowerCase().includes('dot')) return '1 4'
  if (String(style).toLowerCase().includes('dash')) return '8 5'
  return undefined
}

function labelVisualScale(viewerScale) {
  const zoom = Number(viewerScale)
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  if (zoom <= 1) return zoom

  // Labels shrink proportionally with the drawing below 100% zoom, and grow
  // above it — capped well short of 1:1 with zoom so they don't balloon to
  // oversized at high zoom, but noticeably more responsive than before
  // (previously capped at 1.25x / 0.15 rate, which barely moved across a
  // realistic zoom range — e.g. only ~9% bigger at 159% zoom — so dense
  // clusters of short, closely-spaced measurements stayed overlapped even
  // after zooming in a lot).
  return Math.min(1.6, 1 + (zoom - 1) * 0.25)
}

function labelGeometry(annotation, viewerScale) {
  const start = annotation.points[0]
  const end = annotation.points[annotation.points.length - 1]
  if (!start || !end) return null
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.max(0.001, Math.hypot(dx, dy))
  const nx = -dy / length
  const ny = dx / length
  const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
  const baseFontSize = Math.min(Math.max(
    Number(annotation.labelFontSize) || DEFAULT_MEASURE_LABEL_SIZE,
    MIN_MEASURE_LABEL_SIZE), MAX_MEASURE_LABEL_SIZE)
  const visualScale = labelVisualScale(pageScale)
  // SVG coordinates are PDF-page units and are scaled by the page element.
  // Convert the desired screen-space size back to page units to avoid applying
  // the PDF zoom twice (the cause of oversized labels at 200%+ zoom).
  const fontSize = (baseFontSize * visualScale) / pageScale
  // Tightened from 0.7x to 0.3x — with several parallel lines close together
  // (e.g. a row of purlins), a wide gap made it hard to tell which label
  // belonged to which line. Still enough clearance to not sit on the line.
  const gap = (baseFontSize * 0.3 * visualScale + Number(annotation.thickness || 1)) / pageScale
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  let x = midpoint.x + nx * gap
  let y = midpoint.y + ny * gap
  if (y > midpoint.y) {
    x = midpoint.x - nx * gap
    y = midpoint.y - ny * gap
  }
  const mark = annotation.mark || ''
  const value = Number.isFinite(annotation.value) && annotation.value > 0
    ? `${annotation.value.toFixed(2)} ${annotation.unit}`
    : ''
  const widest = Math.max(mark.length, value.length, 3)
  // Align the label with the line's own direction (horizontal line → horizontal
  // label, vertical line → vertical label, angled line → angled label) instead
  // of always staying horizontal — normalized to the [-90, 90] range so the
  // text is never rendered upside-down/mirrored regardless of which end of
  // the line is "start" vs "end".
  let angle = Math.atan2(dy, dx) * (180 / Math.PI)
  if (angle > 90) angle -= 180
  else if (angle < -90) angle += 180
  return {
    x,
    y,
    mark,
    value,
    angle,
    width: widest * fontSize * 0.62 + fontSize,
    height: value ? fontSize * 2.45 : fontSize * 1.5,
    fontSize,
    borderWidth: Math.max(0.5, visualScale) / pageScale,
    cornerRadius: (2 * visualScale) / pageScale,
  }
}

// Shared by both ways to wheel-resize a label's font size: hovering the
// label itself (MeasurementLabel, below) and scrolling anywhere on the page
// once something is already selected (PdfSvgOverlay's own listener further
// down). One whole point per tick keeps it predictable even on an aggressive
// trackpad fling — a magnitude-scaled step could jump 10+pt in one swipe.
// Scroll up = bigger (matches the usual "up/forward = zoom in" convention).
// Caller is expected to have already checked !event.ctrlKey (ctrl+wheel is
// reserved for page zoom) before calling this.
function applyLabelWheelResize(annotation, event, onLabelSizeChange) {
  event.preventDefault()
  event.stopPropagation()
  const current = Math.min(Math.max(
    Number(annotation.labelFontSize) || DEFAULT_MEASURE_LABEL_SIZE,
    MIN_MEASURE_LABEL_SIZE), MAX_MEASURE_LABEL_SIZE)
  const direction = event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0
  if (!direction) return
  const next = Math.min(MAX_MEASURE_LABEL_SIZE, Math.max(MIN_MEASURE_LABEL_SIZE, current + direction))
  if (next === current) return
  // Keep the S/M/L/XL toolbar buttons and the custom pt input in sync live,
  // same as picking a preset or selecting this measurement would.
  useAppStore.getState().setMeasureLabelFontSize(next)
  onLabelSizeChange?.({
    annotationId: annotation.id,
    dbId: annotation.dbId,
    pageNumber: annotation.pageNumber,
    size: next,
  })
}

function MeasurementLabel({ annotation, viewerScale, onLabelSizeChange, selected, onSelect, anySelected, forceVisible }) {
  const groupRef = useRef(null)
  const showMeasurementLabels = useAppStore(s => s.showMeasurementLabels)
  const label = labelGeometry(annotation, viewerScale)

  // Hover a label + scroll to resize it in place, even before it's selected —
  // this is just the quick-access path; once selected, PdfSvgOverlay's own
  // page-wide listener takes over so scrolling doesn't have to stay precisely
  // over the (small) label. React's onWheel is registered passive at the
  // root, so preventDefault() inside it can't actually stop the page from
  // also scrolling/zooming underneath (the same reason the PDF's own
  // ctrl+wheel zoom is wired as a native listener in PdfJsViewer instead of a
  // JSX onWheel prop) — mirror that fix here with a native, non-passive
  // listener via ref.
  useEffect(() => {
    const el = groupRef.current
    if (!el) return undefined
    const handleWheel = (event) => {
      if (event.ctrlKey) return // ctrl+wheel is reserved for page zoom
      // Select this measurement (same as clicking it) on the first tick of a
      // scroll gesture — without this, the toolbar's S/M/L/XL buttons and pt
      // input have nothing to act on until the user separately clicks the
      // label first, so scrolling and then clicking a preset look like they
      // "don't work together": the wheel resizes it, but a follow-up preset
      // click silently no-ops because nothing was ever formally selected.
      if (!selected) onSelect?.(annotation.id, annotation)
      applyLabelWheelResize(annotation, event, onLabelSizeChange)
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [annotation, onLabelSizeChange, selected, onSelect])

  // Global show/hide toggle: with nothing selected, it hides every label. Once
  // a measurement is selected, the toggle narrows to just that one label (so
  // the user can declutter the single label they're working on) — every other
  // label keeps showing regardless of the toggle. The paste preview
  // (forceVisible) always ignores this — the user is actively positioning it,
  // so it must stay visible even with labels hidden and nothing selected.
  if (!label || (!label.mark && !label.value)) return null
  if (!forceVisible && !showMeasurementLabels && (anySelected ? selected : true)) return null

  return (
    <g ref={groupRef} className="pdfjs-measure-label" transform={`rotate(${label.angle} ${label.x} ${label.y})`}
      style={{ cursor: 'ns-resize' }}>
      {/* The label is the most visually obvious, easiest thing to click on a
          measurement — it must be selectable (and draggable) exactly like the
          line itself. It sits inside AnnotationShape's <g>, which already
          carries the onPointerDown/onClick/onContextMenu handlers, so making
          this hit-testable is enough; the events bubble up naturally. */}
      <rect
        x={label.x - label.width / 2}
        y={label.y - label.height}
        width={label.width}
        height={label.height}
        rx={label.cornerRadius}
        fill="rgba(255,255,255,.94)"
        stroke={annotation.color}
        strokeWidth={label.borderWidth}
      />
      {label.mark && (
        <text x={label.x} y={label.y - label.height + label.fontSize * 1.05} textAnchor="middle"
          fill={annotation.color} fontSize={label.fontSize} fontWeight="700">
          {label.mark}
        </text>
      )}
      {label.value && (
        <text x={label.x} y={label.y - label.fontSize * .35} textAnchor="middle"
          fill={annotation.color} fontSize={label.fontSize} fontWeight="700">
          {label.value}
        </text>
      )}
    </g>
  )
}

function AnnotationShape({
  annotation,
  selected,
  anySelected,
  onPointerDown,
  onEndpointPointerDown,
  endpointEditingEnabled,
  onSelect,
  onContextMenu,
  viewerScale,
  onLabelSizeChange,
  forceLabelVisible,
}) {
  const points = annotation.points.map(p => `${p.x},${p.y}`).join(' ')
  const common = {
    fill: annotation.type === 'area' ? `${annotation.color}33` : 'none',
    stroke: annotation.color,
    strokeWidth: annotation.thickness,
    strokeOpacity: annotation.opacity,
    strokeDasharray: dashArray(annotation.lineStyle),
    vectorEffect: 'none',
  }

  if (annotation.type === 'count') {
    const p = annotation.points[0]
    return <circle cx={p.x} cy={p.y} r={5} {...common} fill={annotation.color} />
  }

  const closed = annotation.type === 'area'
  const editableEndpoints = endpointEditingEnabled
    && selected
    && annotation.type === 'line'
    && annotation.points.length >= 2
  const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
  const handleRadius = 5 / pageScale
  const handleStrokeWidth = 1.5 / pageScale
  return (
    <g
      onPointerDown={event => onPointerDown?.(event, annotation)}
      onClick={event => { event.stopPropagation(); onSelect?.(annotation.id, annotation, event) }}
      onContextMenu={event => onContextMenu?.(event, annotation)}
    >
      <polyline points={points} {...common} fill={closed ? common.fill : 'none'} />
      <polyline points={points} fill="none" stroke="transparent" strokeWidth={Math.max(12, annotation.thickness * 5)} />
      {selected && !editableEndpoints && annotation.points.map((p, index) => (
        <rect key={index} x={p.x - 3} y={p.y - 3} width={6} height={6}
          fill="#fff" stroke={annotation.color} strokeWidth="1" pointerEvents="none" />
      ))}
      {editableEndpoints && [0, annotation.points.length - 1].map((pointIndex, handleIndex) => {
        const p = annotation.points[pointIndex]
        return (
          <circle
            key={`${pointIndex}-${handleIndex}`}
            cx={p.x}
            cy={p.y}
            r={handleRadius}
            fill="#fff"
            stroke={annotation.color}
            strokeWidth={handleStrokeWidth}
            pointerEvents="all"
            style={{ cursor: 'crosshair' }}
            onPointerDown={event => onEndpointPointerDown?.(event, annotation, pointIndex)}
          />
        )
      })}
      <MeasurementLabel annotation={annotation} viewerScale={viewerScale} onLabelSizeChange={onLabelSizeChange}
        selected={selected} anySelected={anySelected} onSelect={onSelect} forceVisible={forceLabelVisible} />
    </g>
  )
}

function PdfSvgOverlay({
  pageNumber,
  pageSize,
  viewerScale,
  annotations,
  selectedAnnotationId,
  selectedAnnotationIds,
  pasteClipboard,
  onMeasure,
  onSelect,
  onAnnotationContextMenu,
  onClearSelection,
  onGeometryChange,
  onLabelSizeChange,
}) {
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const draftStartRef = useRef(null)
  const pasteInFlightRef = useRef(false)
  // A shape's pointerdown calls setPointerCapture on the SVG root (needed so
  // dragging keeps tracking even if the pointer leaves the shape). That has
  // the side effect of re-targeting the click event that follows to the SVG
  // root itself, completely bypassing the shape's own onClick/stopPropagation
  // — so a plain click-to-select on any annotation was immediately undone by
  // handleClick's "clicked empty space, deselect" branch right after. This
  // flag lets handleClick recognize "a shape just claimed this interaction"
  // and skip clearing selection for that one click only.
  const shapeInteractedRef = useRef(false)
  const [draftStart, setDraftStart] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [dragged, setDragged] = useState(null)

  const {
    activeTool,
    activeUnit,
    measureColor,
    measureCategory,
    lineThickness,
    lineStyle,
    measureLabelFontSize,
    selectedDrawing,
    spaceHeld,
  } = useAppStore()

  useEffect(() => {
    draftStartRef.current = null
    setDraftStart(null)
    setCursor(null)
  }, [activeTool, pageNumber])

  // Every paste session (a fresh copy → Paste) gets a brand-new clipboard
  // object, and ending one (Esc/Done/cancel) sets it back to null — either
  // transition means any previously tracked mouse position is stale and must
  // not be reused. Without this, the very first render of a *new* paste
  // session's moving preview would jump to wherever the mouse last was
  // tracked (e.g. exactly where the last copy was placed), rendering a ghost
  // directly on top of that already-placed occurrence until the user moves
  // the mouse again.
  useEffect(() => {
    setCursor(null)
  }, [pasteClipboard])

  const pageAnnotations = useMemo(() => annotations.map(annotation => {
    if (dragged?.id !== annotation.id) return annotation
    return { ...annotation, points: dragged.points }
  }), [annotations, dragged])

  // Once a measurement is selected (by click, or the first tick of hovering
  // its own label), scrolling ANYWHERE on this page resizes its label instead
  // of scrolling the page — the label itself is a small target to keep
  // hitting precisely, so this makes "select once, then scroll freely" the
  // primary way to resize. Escape clears the selection (DrawingsPage), and
  // since this effect depends on selectedAnnotationId, that alone removes
  // this listener again and restores normal wheel scroll/zoom — no separate
  // handling needed here for that.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || selectedAnnotationId == null) return undefined
    const selected = pageAnnotations.find(a => [a.id, a.dbId].some(
      id => id != null && String(id) === String(selectedAnnotationId)
    ))
    if (!selected) return undefined
    const handleWheel = (event) => {
      if (event.ctrlKey) return // ctrl+wheel is reserved for page zoom
      applyLabelWheelResize(selected, event, onLabelSizeChange)
    }
    svg.addEventListener('wheel', handleWheel, { passive: false })
    return () => svg.removeEventListener('wheel', handleWheel)
  }, [selectedAnnotationId, pageAnnotations, onLabelSizeChange, pageNumber])

  // pasteClipboard.items is always an array (even a single copy is a
  // 1-length array) — the anchor is whichever item was copied first, and
  // every other item's fixed offset from it (captured at copy time, via
  // each item's own label midpoint) is what lets a multi-item paste move as
  // one rigid group to wherever the user clicks, while preserving each
  // item's position relative to the others. For a single-item clipboard,
  // every offset is (0,0) — identical to today's single-preview behavior.
  const anchorItem = pasteClipboard?.items?.[0] ?? null
  const itemOffsets = useMemo(() => {
    if (!pasteClipboard?.items?.length) return []
    const anchorMid = anchorItem?.labelAnchor ?? { x: 0, y: 0 }
    return pasteClipboard.items.map(item => ({
      item,
      dx: (item.labelAnchor?.x ?? 0) - anchorMid.x,
      dy: (item.labelAnchor?.y ?? 0) - anchorMid.y,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasteClipboard])

  const previewAnnotations = useMemo(() => {
    if (!cursor || !itemOffsets.length) return []
    return itemOffsets.map(({ item, dx, dy }, previewIndex) => {
      const raw = item.copyJson ?? item.raw
      if (!raw) return null
      const translated = translateRawLine(raw, { x: cursor.x + dx, y: cursor.y + dy }, pageNumber, pageSize)
      const points = translated?.vertexPoints ?? []
      if (points.length < 2) return null
      return {
        id: `paste-preview-${item.clipboardItemId
          ?? `${item.sourceItemId ?? item.mark ?? 'measurement'}:${item.occurrenceId ?? previewIndex}`}`,
        type: 'line',
        points,
        mark: String(item.mark ?? ''),
        value: Number(item.length),
        unit: String(item.unit ?? activeUnit).toLowerCase(),
        color: item.color ?? translated?.strokeColor ?? '#EF233C',
        thickness: Number(item.thickness ?? translated?.thickness ?? 2),
        opacity: Number(translated?.opacity ?? item.opacity ?? 1),
        lineStyle: item.lineStyle ?? translated?.lineStyle ?? 'solid',
        labelFontSize: Number(item.labelFontSize ?? translated?.fontSize ?? 12),
      }
    }).filter(Boolean)
  }, [cursor, itemOffsets, pageNumber, pageSize, activeUnit])

  const finalizeLine = useCallback((end, startOverride = null) => {
    const start = startOverride ?? draftStart
    if (!start) return
    const pixelLength = Math.hypot(end.x - start.x, end.y - start.y)
    draftStartRef.current = null
    setDraftStart(null)
    setCursor(null)
    // Guard against accidental clicks (e.g. a mis-click or double-click while
    // just positioning the cursor) turning into a stray near-zero-length
    // measurement. `pixelLength` is in PDF page units, which shrink/grow with
    // zoom, so convert a fixed on-screen tolerance (CSS px) into page units
    // via viewerScale rather than using a flat threshold — otherwise the same
    // real screen-space jitter would incorrectly pass at low zoom and reject
    // legitimate short lines at high zoom.
    const zoom = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
    const minPixelLength = MIN_LINE_SCREEN_PIXELS / zoom
    if (!Number.isFinite(pixelLength) || pixelLength < minPixelLength) return
    // computeRealLengthFromDrawing returns null when the drawing isn't
    // calibrated yet (expected — that's exactly what Calibrate mode, or a
    // Linear line drawn before any scale exists, is for). Do NOT bail out
    // here: onMeasure must still fire so DrawingsPage's handleMeasure can
    // detect the missing scale and open the calibration modal, which saves
    // this same line once a real length is known (Bluebeam-style: the first
    // drawn line becomes the calibration reference). Bailing here silently
    // discarded every line drawn before calibration — no draw, no popup.
    const length = computeRealLengthFromDrawing(pixelLength, selectedDrawing, activeUnit)
    const resolvedLength = Number.isFinite(length) && length > 0 ? length : null
    // Read the store at finalization time so a schedule-row click always wins,
    // even when React has not yet committed the overlay's next render.
    const liveState = useAppStore.getState()
    const manuallySelectedMember = liveState.selectedMemberScheduleItem
    // Calibrate now included: selecting a member before/during Calibrate mode
    // links it to the reference line, so the same draw both sets the new
    // scale and saves as that member's measurement (handleMeasure's
    // calibrate branch already spreads the full measurement — including
    // whatever member fields are here — into pendingCalibMeasureRef).
    const schedule = ['line', 'calibrate'].includes(activeTool) ? manuallySelectedMember : null
    const annotationColor = schedule?.color ?? schedule?.Color ?? measureColor
    const id = crypto.randomUUID()
    const rawAnnotation = createRawLine({
      id,
      pageNumber,
      points: [start, end],
      style: {
        pageSize,
        color: annotationColor,
        thickness: lineThickness,
        lineStyle,
        labelFontSize: measureLabelFontSize,
      },
    })
    onMeasure?.({
      annotationId: id,
      pageNumber,
      measureType: 'Line',
      pixelLength,
      length: resolvedLength,
      unit: activeUnit,
      memberMark: schedule?.mark ?? schedule?.Mark ?? '',
      drawingMark: schedule?.mark ?? schedule?.Mark ?? '',
      memberType: schedule?.memberType ?? schedule?.MemberType ?? '',
      memberScheduleId: schedule?.id,
      material: schedule?.mark ?? schedule?.Mark ?? '',
      category: measureCategory,
      rawAnnotation,
    })
    // Keep Linear and the selected schedule member armed for repeated
    // occurrences. Escape/refresh owns the explicit return to Select mode.
  }, [activeTool, activeUnit, draftStart, lineStyle, lineThickness, measureCategory, measureColor, measureLabelFontSize, onMeasure, pageNumber, pageSize, selectedDrawing, viewerScale])

  const placePaste = useCallback(async (target) => {
    if (!itemOffsets.length || pasteInFlightRef.current) return
    pasteInFlightRef.current = true
    try {
      const historyGroupId = crypto.randomUUID()
      // Sequential, not Promise.all: DrawingsPage's handleMeasure re-reads
      // live takeoffItems to recompute a linked member's occurrence count
      // for each pasted item. Concurrent calls would all see the same
      // stale snapshot (none seeing any sibling's just-added row yet), so
      // the final quantity would be wrong instead of cumulative. Awaiting
      // each item in turn guarantees the next one sees the prior one's
      // already-committed row.
      for (const { item, dx, dy } of itemOffsets) {
        const raw = item.copyJson ?? item.raw
        if (!raw) continue
        const rawAnnotation = translateRawLine(raw, { x: target.x + dx, y: target.y + dy }, pageNumber, pageSize)
        if (!rawAnnotation) continue
        const copiedPixelLength = Number(item.pixelLength)
        const vectorPixelLength = Math.hypot(
          Number(item.sourceVector?.dx) || 0,
          Number(item.sourceVector?.dy) || 0,
        )
        const pixelLength = Number.isFinite(copiedPixelLength) && copiedPixelLength > 0
          ? copiedPixelLength
          : vectorPixelLength

        await onMeasure?.({
          annotationId: rawAnnotation.annotationId,
          occurrenceId: rawAnnotation.annotationId,
          linkedItemId: item.linkedItemId ?? item.sourceItemId,
          sourceItemId: item.sourceItemId,
          pageNumber,
          measureType: 'Line',
          pixelLength,
          length: item.length,
          unit: item.unit ?? activeUnit,
          memberMark: item.mark,
          drawingMark: item.mark,
          memberType: item.memberType,
          memberScheduleId: item.memberScheduleId,
          material: item.material,
          category: item.category,
          description: item.description,
          notes: item.notes,
          color: item.color,
          thickness: item.thickness,
          opacity: item.opacity,
          lineStyle: item.lineStyle,
          arrowStyle: item.arrowStyle,
          linearLineMode: item.linearLineMode,
          labelFontSize: item.labelFontSize,
          rawAnnotation,
        }, { isPaste: true, historyGroupId })
      }
    } finally {
      pasteInFlightRef.current = false
    }
  }, [activeUnit, onMeasure, pageNumber, pageSize, itemOffsets])

  const handleClick = useCallback((event) => {
    if (!svgRef.current) return
    const point = toPdfPoint(event, svgRef.current, pageSize)
    if (pasteClipboard) {
      event.stopPropagation()
      placePaste(point)
      return
    }
    if (shapeInteractedRef.current) {
      // A shape's own pointerdown already selected it and captured the
      // pointer (needed for dragging in Select tool), which retargets this
      // click event to the SVG root instead of the shape itself — stop it
      // here so it doesn't keep bubbling past this point to an ancestor's
      // own click-to-deselect handler (PdfJsViewer's, for the Pan-tool case
      // where this SVG is pointer-events:none) and undo the selection that
      // was just made.
      event.stopPropagation()
      shapeInteractedRef.current = false
      return
    }
    // A ctrl/shift-click that lands on empty space (not a shape) is a
    // deliberate no-op — it shouldn't clear an existing multi-selection just
    // because the modifier-click missed every shape.
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    // Deselect on any empty-space click, not just in Select tool — otherwise
    // a measurement stays selected (and wheel keeps resizing it, see
    // MeasurementLabel/PdfSvgOverlay's wheel handling) even after clicking
    // elsewhere on the drawing while in Linear/Area/etc.
    onClearSelection?.()
  }, [onClearSelection, pageSize, pasteClipboard, placePaste])

  const handlePointerDown = useCallback((event) => {
    // Held-Space always means "pan", even over Line/Calibrate — bail without
    // capturing so the gesture bubbles up to the viewer's own pan handler
    // instead of starting/finalizing a draw.
    if (spaceHeld) return
    if (pasteClipboard || !['line', 'calibrate'].includes(activeTool) || event.button !== 0) return
    if (!svgRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const point = toPdfPoint(event, svgRef.current, pageSize)
    const start = draftStartRef.current
    if (start) {
      finalizeLine(point, start)
      return
    }

    draftStartRef.current = point
    setDraftStart(point)
    setCursor(point)
    // Bluebeam-style placement is deliberately click-click only. Do not
    // capture the pointer or complete on pointerup: after this first click the
    // draft remains active while the user pans (Space/ middle mouse), zooms,
    // scrolls, or otherwise navigates. The next left click above is the only
    // action that finalizes the line through the existing finalizeLine path.
  }, [activeTool, finalizeLine, pageSize, pasteClipboard, spaceHeld])

  const publishGeometryChange = useCallback((drag, points) => {
    if (!drag || !Array.isArray(points) || points.length < 2) return
    const rawAnnotation = createRawLine({
      id: drag.annotation.id,
      pageNumber,
      points,
      sourceRaw: drag.annotation.raw,
      style: { pageSize },
    })
    const start = points[0]
    const end = points[points.length - 1]
    const pixelLength = Math.hypot(end.x - start.x, end.y - start.y)
    const length = computeRealLengthFromDrawing(pixelLength, selectedDrawing, activeUnit)
    onGeometryChange?.({
      annotationId: drag.annotation.id,
      dbId: drag.annotation.dbId,
      pageNumber,
      rawAnnotation,
      pixelLength,
      length: Number.isFinite(length) && length >= 0 ? length : null,
      unit: activeUnit,
      interactionId: drag.interactionId,
      editMode: drag.mode,
    })
  }, [activeUnit, onGeometryChange, pageNumber, pageSize, selectedDrawing])

  const handleMove = useCallback((event) => {
    if (!svgRef.current) return
    const point = toPdfPoint(event, svgRef.current, pageSize)
    setCursor(point)
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    let points
    if (drag.mode === 'endpoint') {
      points = drag.annotation.points.map((p, index) => (
        index === drag.endpointIndex ? { x: point.x, y: point.y } : { ...p }
      ))
    } else {
      const dx = point.x - drag.origin.x
      const dy = point.y - drag.origin.y
      points = drag.annotation.points.map(p => ({ x: p.x + dx, y: p.y + dy }))
    }
    drag.latestPoints = points
    setDragged({ id: drag.annotation.id, points })
    publishGeometryChange(drag, points)
  }, [pageSize, publishGeometryChange])

  const handleShapePointerDown = useCallback((event, annotation) => {
    if (spaceHeld || event.button !== 0) return
    if (activeTool !== 'select') {
      // Not in Select mode (e.g. Linear) — don't drag/select like the 'select'
      // branch below, but still stop this pointerdown from bubbling to the
      // SVG root's own handlePointerDown. That handler treats any bubbled
      // pointerdown as "start a new draft line from here" and captures the
      // pointer on the SVG root — which retargets the click that follows
      // away from this shape's own onClick (so it never selects), straight
      // through to the SVG root's handleClick instead.
      event.stopPropagation()
      // Clear first, then the click that follows (this pointerdown doesn't
      // capture the pointer, so it isn't retargeted) re-selects via this same
      // shape's own onClick if it's genuinely this shape the user clicked —
      // net result: still selected, no visible flicker. But if the label grew
      // from a resize and now happens to cover a spot the user perceives as
      // "elsewhere," or the click actually lands on a different measurement's
      // line (hit-area is much wider than the visible stroke in a dense
      // drawing), clearing first is what makes that correctly end up
      // deselected/switched instead of silently staying stuck on the old one.
      onClearSelection?.()
      return
    }
    event.stopPropagation()
    shapeInteractedRef.current = true

    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      // Ctrl/Shift+click toggles this shape's membership in the selection —
      // a deliberate, standalone action, not the start of a drag. Still
      // capture the pointer (same as the plain-click path below) purely so
      // the click that follows gets retargeted to the SVG root instead of
      // reaching this shape's own onClick a second time — without it, both
      // this pointerdown AND the shape's onClick would call onSelect for the
      // same ctrl-held gesture, toggling the id on and then immediately back
      // off. dragRef is deliberately left unset so no drag actually starts.
      onSelect?.(annotation.id, annotation, event)
      svgRef.current?.setPointerCapture?.(event.pointerId)
      return
    }

    // A plain click (no modifier held) now ADDS this shape to the selection
    // instead of collapsing it to just this one — clicking each line in turn
    // builds a multi-selection without needing to hold Ctrl/Shift. Passing a
    // synthetic ctrlKey-true marker (handleAnnotationSelect only ever reads
    // the modifier flags off this object) routes through the exact same
    // toggle logic Ctrl+click already used, already proven correct there.
    // Drag-arming is unchanged from before — still only armed for a plain
    // click, exactly as it always was, so this carries no new drag risk.
    onSelect?.(annotation.id, annotation, { ctrlKey: true })
    const origin = toPdfPoint(event, svgRef.current, pageSize)
    svgRef.current?.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      origin,
      annotation,
      mode: 'move',
      interactionId: crypto.randomUUID(),
    }
  }, [activeTool, onSelect, onClearSelection, pageSize, spaceHeld])

  const handleEndpointPointerDown = useCallback((event, annotation, endpointIndex) => {
    if (spaceHeld || activeTool !== 'select' || event.button !== 0 || !svgRef.current) return
    event.preventDefault()
    event.stopPropagation()
    shapeInteractedRef.current = true
    onSelect?.(annotation.id, annotation, event)
    svgRef.current.setPointerCapture?.(event.pointerId)
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    dragRef.current = {
      pointerId: event.pointerId,
      origin: toPdfPoint(event, svgRef.current, pageSize),
      annotation,
      mode: 'endpoint',
      endpointIndex,
      interactionId: crypto.randomUUID(),
    }
  }, [activeTool, onSelect, pageSize, spaceHeld])

  const handleShapeContextMenu = useCallback((event, annotation) => {
    event.preventDefault()
    event.stopPropagation()
    onAnnotationContextMenu?.(event, annotation.id, annotation)
  }, [onAnnotationContextMenu])

  const endDrag = useCallback((event) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    svgRef.current?.releasePointerCapture?.(event.pointerId)
    if (drag.latestPoints) publishGeometryChange(drag, drag.latestPoints)
    dragRef.current = null
    setDragged(null)
  }, [publishGeometryChange])

  const dimensionCommandActive = ['line', 'calibrate'].includes(activeTool)
  const interactive = pasteClipboard || activeTool === 'select' || dimensionCommandActive
  return (
    <svg
      ref={svgRef}
      className={`pdfjs-annotation-layer ${interactive ? 'is-interactive' : ''}`}
      viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
      preserveAspectRatio="none"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handleMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => { if (!dragRef.current && !draftStartRef.current) setCursor(null) }}
    >
      {/*
        Let both placement clicks reach the SVG drawing surface even when the
        pointer is over an existing line, endpoint, or label.  Hit-testing is
        restored automatically as soon as the user leaves the dimension tool,
        so normal Select-mode editing remains unchanged.
      */}
      <g pointerEvents={pasteClipboard || dimensionCommandActive ? 'none' : 'auto'}>
        {pageAnnotations.map(annotation => (
          <AnnotationShape
            key={annotation.id}
            annotation={annotation}
            viewerScale={viewerScale}
            endpointEditingEnabled={activeTool === 'select'}
            selected={
              (selectedAnnotationIds && [annotation.id, annotation.dbId].some(
                id => id != null && selectedAnnotationIds.has(String(id))
              ))
              || (selectedAnnotationId != null && [annotation.id, annotation.dbId].some(
                id => id != null && String(id) === String(selectedAnnotationId)
              ))
            }
            anySelected={(selectedAnnotationIds && selectedAnnotationIds.size > 0) || selectedAnnotationId != null}
            onPointerDown={handleShapePointerDown}
            onEndpointPointerDown={handleEndpointPointerDown}
            onSelect={onSelect}
            onContextMenu={handleShapeContextMenu}
            onLabelSizeChange={onLabelSizeChange}
          />
        ))}
      </g>
      {draftStart && cursor && (
        <line x1={draftStart.x} y1={draftStart.y} x2={cursor.x} y2={cursor.y}
          stroke={measureColor} strokeWidth={lineThickness} strokeDasharray={dashArray(lineStyle)}
          strokeLinecap="round" pointerEvents="none" />
      )}
      {previewAnnotations.map(preview => (
        <g key={preview.id} opacity=".58" pointerEvents="none">
          <AnnotationShape
            annotation={preview}
            viewerScale={viewerScale}
            selected={false}
            onPointerDown={() => {}}
            onSelect={() => {}}
            forceLabelVisible
          />
        </g>
      ))}
    </svg>
  )
}

export default memo(PdfSvgOverlay)
