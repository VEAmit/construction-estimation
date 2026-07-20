import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../../store/useAppStore'
import { computeRealLengthFromDrawing } from '../../../utils/measureCalibration'
import { createRawLine, translateRawLine } from './pdfGeometryAdapter'

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

  // Match the compact label behavior used by the previous viewer: labels
  // shrink with the drawing below 100%, but grow only gently at high zoom.
  return Math.min(1.25, 1 + (zoom - 1) * 0.15)
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
  const baseFontSize = Math.min(Math.max(Number(annotation.labelFontSize) || 12, 9), 16)
  const visualScale = labelVisualScale(pageScale)
  // SVG coordinates are PDF-page units and are scaled by the page element.
  // Convert the desired screen-space size back to page units to avoid applying
  // the PDF zoom twice (the cause of oversized labels at 200%+ zoom).
  const fontSize = (baseFontSize * visualScale) / pageScale
  const gap = (baseFontSize * 0.7 * visualScale + Number(annotation.thickness || 1)) / pageScale
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
    <g className="pdfjs-measure-label" pointerEvents="none">
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

function AnnotationShape({ annotation, selected, onPointerDown, onSelect, viewerScale }) {
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
    <g onPointerDown={event => onPointerDown(event, annotation)} onClick={event => { event.stopPropagation(); onSelect(annotation.id) }}>
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
  onPasteComplete,
  onMeasure,
  onSelect,
  onClearSelection,
  onGeometryChange,
}) {
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const draftStartRef = useRef(null)
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

  const finalizeLine = useCallback((end, startOverride = null) => {
    const start = startOverride ?? draftStart
    if (!start) return
    const pixelLength = Math.hypot(end.x - start.x, end.y - start.y)
    draftStartRef.current = null
    setDraftStart(null)
    setCursor(null)
    if (!Number.isFinite(pixelLength) || pixelLength < 0.25) return
    const length = computeRealLengthFromDrawing(pixelLength, selectedDrawing, activeUnit)
    if (!Number.isFinite(length) || length <= 0) return
    // Read the store at finalization time so a schedule-row click always wins,
    // even when React has not yet committed the overlay's next render.
    const liveState = useAppStore.getState()
    const manuallySelectedMember = liveState.selectedMemberScheduleItem
    const schedule = activeTool === 'line' ? manuallySelectedMember : null
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
      length,
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

  const placePaste = useCallback((target) => {
    if (!sourceRaw) return
    const rawAnnotation = translateRawLine(sourceRaw, target, pageNumber, pageSize)
    if (!rawAnnotation) return
    const points = rawAnnotation.vertexPoints
    onMeasure?.({
      annotationId: rawAnnotation.annotationId,
      occurrenceId: rawAnnotation.annotationId,
      linkedItemId: pasteClipboard.linkedItemId ?? pasteClipboard.sourceItemId,
      sourceItemId: pasteClipboard.sourceItemId,
      pageNumber,
      measureType: 'Line',
      pixelLength: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
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
      rawAnnotation,
    }, { isPaste: true })
    onPasteComplete?.()
  }, [activeUnit, onMeasure, onPasteComplete, pageNumber, pageSize, pasteClipboard, sourceRaw])

  const handleClick = useCallback((event) => {
    if (!svgRef.current) return
    const point = toPdfPoint(event, svgRef.current, pageSize)
    if (pasteClipboard) {
      event.stopPropagation()
      placePaste(point)
      return
    }
    if (activeTool === 'select') onClearSelection?.()
  }, [activeTool, onClearSelection, pageSize, pasteClipboard, placePaste])

  const handlePointerDown = useCallback((event) => {
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
  }, [activeTool, finalizeLine, pageSize, pasteClipboard])

  const handleMove = useCallback((event) => {
    if (!svgRef.current) return
    const point = toPdfPoint(event, svgRef.current, pageSize)
    setCursor(point)
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = point.x - drag.origin.x
    const dy = point.y - drag.origin.y
    setDragged({ id: drag.annotation.id, points: drag.annotation.points.map(p => ({ x: p.x + dx, y: p.y + dy })) })
  }, [pageSize])

  const handleShapePointerDown = useCallback((event, annotation) => {
    if (activeTool !== 'select' || event.button !== 0) return
    event.stopPropagation()
    onSelect?.(annotation.id)
    const origin = toPdfPoint(event, svgRef.current, pageSize)
    svgRef.current?.setPointerCapture?.(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, origin, annotation }
  }, [activeTool, onSelect, pageSize])

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
    endDrag(event)
  }, [endDrag])

  const cancelPointer = useCallback((event) => {
    if (drawRef.current?.pointerId === event.pointerId) {
      svgRef.current?.releasePointerCapture?.(event.pointerId)
      drawRef.current = null
      setDraftStart(null)
      setCursor(null)
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
      onPointerLeave={() => { if (!dragRef.current && !drawRef.current && !draftStart) setCursor(null) }}
    >
      {pageAnnotations.map(annotation => (
        <AnnotationShape
          key={annotation.id}
          annotation={annotation}
          viewerScale={viewerScale}
          selected={selectedAnnotationId === annotation.id || selectedAnnotationId === annotation.dbId}
          onPointerDown={handleShapePointerDown}
          onSelect={onSelect}
        />
      ))}
      {draftStart && cursor && (
        <line x1={draftStart.x} y1={draftStart.y} x2={cursor.x} y2={cursor.y}
          stroke={measureColor} strokeWidth={lineThickness} strokeDasharray={dashArray(lineStyle)}
          strokeLinecap="round" pointerEvents="none" />
      )}
      {previewPoints.length >= 2 && (
        <g opacity=".58" pointerEvents="none">
          <line x1={previewPoints[0].x} y1={previewPoints[0].y}
            x2={previewPoints[previewPoints.length - 1].x} y2={previewPoints[previewPoints.length - 1].y}
            stroke={pasteClipboard.color ?? '#EF233C'} strokeWidth={pasteClipboard.thickness ?? 2} />
        </g>
      )}
    </svg>
  )
}

export default memo(PdfSvgOverlay)
