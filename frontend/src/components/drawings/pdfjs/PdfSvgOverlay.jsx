import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../../store/useAppStore'
import { computeRealLengthFromDrawing } from '../../../utils/measureCalibration'
import { createRawLine, translateRawLine } from './pdfGeometryAdapter'
import { DEFAULT_MEASURE_LABEL_SIZE, MIN_MEASURE_LABEL_SIZE, MAX_MEASURE_LABEL_SIZE } from '../../../utils/measureLabel'

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
  return {
    x,
    y,
    mark,
    value,
    width: widest * fontSize * 0.62 + fontSize,
    height: value ? fontSize * 2.45 : fontSize * 1.5,
    fontSize,
    borderWidth: Math.max(0.5, visualScale) / pageScale,
    cornerRadius: (2 * visualScale) / pageScale,
  }
}

function MeasurementLabel({ annotation, viewerScale }) {
  const label = labelGeometry(annotation, viewerScale)
  if (!label || (!label.mark && !label.value)) return null
  return (
    <g className="pdfjs-measure-label">
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

function AnnotationShape({ annotation, selected, onPointerDown, onSelect, onContextMenu, viewerScale }) {
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
  return (
    <g
      onPointerDown={event => onPointerDown?.(event, annotation)}
      onClick={event => { event.stopPropagation(); onSelect?.(annotation.id, annotation) }}
      onContextMenu={event => onContextMenu?.(event, annotation)}
    >
      <polyline points={points} {...common} fill={closed ? common.fill : 'none'} />
      <polyline points={points} fill="none" stroke="transparent" strokeWidth={Math.max(12, annotation.thickness * 5)} />
      {selected && annotation.points.map((p, index) => (
        <rect key={index} x={p.x - 3} y={p.y - 3} width={6} height={6}
          fill="#fff" stroke={annotation.color} strokeWidth="1" pointerEvents="none" />
      ))}
      <MeasurementLabel annotation={annotation} viewerScale={viewerScale} />
    </g>
  )
}

function PdfSvgOverlay({
  pageNumber,
  pageSize,
  viewerScale,
  annotations,
  selectedAnnotationId,
  pasteClipboard,
  onMeasure,
  onSelect,
  onAnnotationContextMenu,
  onClearSelection,
  onGeometryChange,
}) {
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const draftStartRef = useRef(null)
  const lineDragRef = useRef(null)
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

  const pageAnnotations = useMemo(() => annotations.map(annotation => {
    if (dragged?.id !== annotation.id) return annotation
    return { ...annotation, points: dragged.points }
  }), [annotations, dragged])

  const sourceRaw = pasteClipboard?.copyJson ?? pasteClipboard?.raw ?? null
  const previewRaw = cursor && sourceRaw
    ? translateRawLine(sourceRaw, cursor, pageNumber, pageSize)
    : null
  const previewPoints = previewRaw?.vertexPoints ?? []
  const previewAnnotation = previewPoints.length >= 2
    ? {
        id: 'paste-preview',
        type: 'line',
        points: previewPoints,
        mark: String(pasteClipboard?.mark ?? ''),
        value: Number(pasteClipboard?.length),
        unit: String(pasteClipboard?.unit ?? activeUnit).toLowerCase(),
        color: pasteClipboard?.color ?? previewRaw?.strokeColor ?? '#EF233C',
        thickness: Number(pasteClipboard?.thickness ?? previewRaw?.thickness ?? 2),
        opacity: Number(previewRaw?.opacity ?? pasteClipboard?.opacity ?? 1),
        lineStyle: pasteClipboard?.lineStyle ?? previewRaw?.lineStyle ?? 'solid',
        labelFontSize: Number(pasteClipboard?.labelFontSize ?? previewRaw?.fontSize ?? 12),
      }
    : null

  const finalizeLine = useCallback((end, startOverride = null) => {
    const start = startOverride ?? draftStart
    if (!start) return
    const pixelLength = Math.hypot(end.x - start.x, end.y - start.y)
    draftStartRef.current = null
    setDraftStart(null)
    setCursor(null)
    if (!Number.isFinite(pixelLength) || pixelLength < 0.25) return
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
  }, [activeTool, activeUnit, draftStart, lineStyle, lineThickness, measureCategory, measureColor, measureLabelFontSize, onMeasure, pageNumber, pageSize, selectedDrawing])

  const placePaste = useCallback(async (target) => {
    if (!sourceRaw || pasteInFlightRef.current) return
    const rawAnnotation = translateRawLine(sourceRaw, target, pageNumber, pageSize)
    if (!rawAnnotation) return
    const copiedPixelLength = Number(pasteClipboard.pixelLength)
    const vectorPixelLength = Math.hypot(
      Number(pasteClipboard.sourceVector?.dx) || 0,
      Number(pasteClipboard.sourceVector?.dy) || 0,
    )
    const pixelLength = Number.isFinite(copiedPixelLength) && copiedPixelLength > 0
      ? copiedPixelLength
      : vectorPixelLength

    pasteInFlightRef.current = true
    try {
      await onMeasure?.({
        annotationId: rawAnnotation.annotationId,
        occurrenceId: rawAnnotation.annotationId,
        linkedItemId: pasteClipboard.linkedItemId ?? pasteClipboard.sourceItemId,
        sourceItemId: pasteClipboard.sourceItemId,
        pageNumber,
        measureType: 'Line',
        pixelLength,
        length: pasteClipboard.length,
        unit: pasteClipboard.unit ?? activeUnit,
        memberMark: pasteClipboard.mark,
        drawingMark: pasteClipboard.mark,
        memberType: pasteClipboard.memberType,
        memberScheduleId: pasteClipboard.memberScheduleId,
        material: pasteClipboard.material,
        category: pasteClipboard.category,
        description: pasteClipboard.description,
        notes: pasteClipboard.notes,
        color: pasteClipboard.color,
        thickness: pasteClipboard.thickness,
        opacity: pasteClipboard.opacity,
        lineStyle: pasteClipboard.lineStyle,
        arrowStyle: pasteClipboard.arrowStyle,
        linearLineMode: pasteClipboard.linearLineMode,
        labelFontSize: pasteClipboard.labelFontSize,
        rawAnnotation,
      }, { isPaste: true })
    } finally {
      pasteInFlightRef.current = false
    }
  }, [activeUnit, onMeasure, pageNumber, pageSize, pasteClipboard, sourceRaw])

  const handleClick = useCallback((event) => {
    if (!svgRef.current) return
    const point = toPdfPoint(event, svgRef.current, pageSize)
    if (pasteClipboard) {
      event.stopPropagation()
      placePaste(point)
      return
    }
    if (shapeInteractedRef.current) {
      shapeInteractedRef.current = false
      return
    }
    if (activeTool === 'select') onClearSelection?.()
  }, [activeTool, onClearSelection, pageSize, pasteClipboard, placePaste])

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
    // Support a single click-drag-release gesture in addition to click-click:
    // if the user drags before releasing, finalize on release instead of
    // requiring a second separate click. A plain click (no drag) falls
    // through unchanged to the existing "second click finalizes" behavior
    // below, since lineDragRef.moved stays false and endPointer skips it.
    svgRef.current.setPointerCapture?.(event.pointerId)
    lineDragRef.current = { pointerId: event.pointerId, moved: false, downX: event.clientX, downY: event.clientY }
  }, [activeTool, finalizeLine, pageSize, pasteClipboard, spaceHeld])

  const handleMove = useCallback((event) => {
    if (!svgRef.current) return
    const point = toPdfPoint(event, svgRef.current, pageSize)
    setCursor(point)
    const lineDrag = lineDragRef.current
    if (lineDrag && lineDrag.pointerId === event.pointerId && !lineDrag.moved) {
      const dx = event.clientX - lineDrag.downX
      const dy = event.clientY - lineDrag.downY
      if (Math.hypot(dx, dy) > 4) lineDrag.moved = true
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = point.x - drag.origin.x
    const dy = point.y - drag.origin.y
    setDragged({ id: drag.annotation.id, points: drag.annotation.points.map(p => ({ x: p.x + dx, y: p.y + dy })) })
  }, [pageSize])

  const handleShapePointerDown = useCallback((event, annotation) => {
    if (spaceHeld || activeTool !== 'select' || event.button !== 0) return
    event.stopPropagation()
    shapeInteractedRef.current = true
    onSelect?.(annotation.id, annotation)
    const origin = toPdfPoint(event, svgRef.current, pageSize)
    svgRef.current?.setPointerCapture?.(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, origin, annotation }
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
    if (dragged?.points) {
      const rawAnnotation = createRawLine({
        id: drag.annotation.id,
        pageNumber,
        points: dragged.points,
        sourceRaw: drag.annotation.raw,
        style: { pageSize },
      })
      onGeometryChange?.({
        annotationId: drag.annotation.id,
        dbId: drag.annotation.dbId,
        pageNumber,
        rawAnnotation,
      })
    }
    dragRef.current = null
    setDragged(null)
  }, [dragged, onGeometryChange, pageNumber, pageSize])

  const endPointer = useCallback((event) => {
    const lineDrag = lineDragRef.current
    if (lineDrag && lineDrag.pointerId === event.pointerId) {
      svgRef.current?.releasePointerCapture?.(event.pointerId)
      lineDragRef.current = null
      if (lineDrag.moved && draftStartRef.current && svgRef.current) {
        const point = toPdfPoint(event, svgRef.current, pageSize)
        finalizeLine(point, draftStartRef.current)
      }
      return
    }
    endDrag(event)
  }, [endDrag, finalizeLine, pageSize])

  const cancelPointer = useCallback((event) => {
    const lineDrag = lineDragRef.current
    if (lineDrag && lineDrag.pointerId === event.pointerId) {
      svgRef.current?.releasePointerCapture?.(event.pointerId)
      lineDragRef.current = null
      return
    }
    endDrag(event)
  }, [endDrag])

  const interactive = pasteClipboard || ['select', 'line', 'calibrate'].includes(activeTool)
  return (
    <svg
      ref={svgRef}
      className={`pdfjs-annotation-layer ${interactive ? 'is-interactive' : ''}`}
      viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
      preserveAspectRatio="none"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handleMove}
      onPointerUp={endPointer}
      onPointerCancel={cancelPointer}
      onPointerLeave={() => { if (!dragRef.current && !draftStartRef.current) setCursor(null) }}
    >
      <g pointerEvents={pasteClipboard ? 'none' : 'auto'}>
        {pageAnnotations.map(annotation => (
          <AnnotationShape
            key={annotation.id}
            annotation={annotation}
            viewerScale={viewerScale}
            selected={selectedAnnotationId != null && [annotation.id, annotation.dbId].some(
              id => id != null && String(id) === String(selectedAnnotationId)
            )}
            onPointerDown={handleShapePointerDown}
            onSelect={onSelect}
            onContextMenu={handleShapeContextMenu}
          />
        ))}
      </g>
      {draftStart && cursor && (
        <line x1={draftStart.x} y1={draftStart.y} x2={cursor.x} y2={cursor.y}
          stroke={measureColor} strokeWidth={lineThickness} strokeDasharray={dashArray(lineStyle)}
          strokeLinecap="round" pointerEvents="none" />
      )}
      {previewAnnotation && (
        <g opacity=".58" pointerEvents="none">
          <AnnotationShape
            annotation={previewAnnotation}
            viewerScale={viewerScale}
            selected={false}
            onPointerDown={() => {}}
            onSelect={() => {}}
          />
        </g>
      )}
    </svg>
  )
}

export default memo(PdfSvgOverlay)
