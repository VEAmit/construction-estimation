import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../../store/useAppStore'
import { computeRealLengthFromDrawing } from '../../../utils/measureCalibration'
import { annotationPoints, createRawLine, findNearestLineEndpoint, translateRawLine } from './pdfGeometryAdapter'
import { DEFAULT_MEASURE_LABEL_SIZE, MIN_MEASURE_LABEL_SIZE, MAX_MEASURE_LABEL_SIZE } from '../../../utils/measureLabel'

// Minimum on-screen distance (CSS px) between a Linear/Calibrate line's two
// points for it to count as an intentional line rather than an accidental
// click/double-click. See finalizeLine, where this is converted to PDF page
// units via the current zoom.
const MIN_LINE_SCREEN_PIXELS = 6
// Bluebeam-style endpoint acquisition range. This is intentionally expressed
// in CSS pixels (not PDF units), so it feels identical at every zoom level.
const ENDPOINT_SNAP_SCREEN_PIXELS = 12
const ENDPOINT_SNAP_INDICATOR_PIXELS = 8
// A single Linear-tool click this close to a native PDF vector line measures
// that complete segment. The tolerance is screen-based so detection remains
// predictable at every zoom level.
const PDF_LINE_HIT_SCREEN_PIXELS = 7
const PDF_LINE_GRID_SCREEN_PIXELS = 28
// Keep collision clearance stable on screen regardless of PDF zoom.
const LABEL_COLLISION_PADDING_PIXELS = 3
const LABEL_COLLISION_MAX_LANES = 5
const PARALLEL_LABEL_DIRECTION_COSINE = Math.cos((8 * Math.PI) / 180)
const PARALLEL_LABEL_EXTRA_CLEARANCE_PIXELS = 16
const PARALLEL_LABEL_MIN_OVERLAP_PIXELS = 12

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

function colorWithAlpha(color, alpha) {
  const hex = /^#([0-9A-Fa-f]{6})$/.exec(color ?? '')
  if (!hex) return `rgba(59,130,246,${alpha})`
  const value = Number.parseInt(hex[1], 16)
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`
}

function readableTextColor(backgroundColor) {
  const hex = /^#([0-9A-Fa-f]{6})$/.exec(backgroundColor ?? '')
  if (!hex) return '#fff'
  const value = Number.parseInt(hex[1], 16)
  const red = (value >> 16) & 255
  const green = (value >> 8) & 255
  const blue = value & 255
  return (red * 299 + green * 587 + blue * 114) / 1000 > 155 ? '#0B1320' : '#fff'
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
  const rawMark = String(annotation.mark ?? '').trim()
  // Some legacy/API records contain the literal strings "null" or
  // "undefined". Never expose those implementation values as a user label;
  // the measurement value remains visible underneath while its mark resolves.
  const mark = /^(?:null|undefined|nan)$/i.test(rawMark) ? '' : rawMark
  const rawUnit = String(annotation.unit ?? '').trim()
  const unit = !rawUnit || /^(?:null|undefined|nan)$/i.test(rawUnit) ? 'mm' : rawUnit
  const value = Number.isFinite(annotation.value) && annotation.value > 0
    ? `${annotation.value.toFixed(2)} ${unit}`
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

function selectionBounds(start, end) {
  return {
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

function sectionBoundsFromFocus(focus, pageSize, viewerScale = 1) {
  if (!focus || !pageSize?.width || !pageSize?.height) return null
  const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
  const width = Math.min(
    pageSize.width,
    Math.max(18 / pageScale, Number(focus.widthRatio) * pageSize.width),
  )
  const height = Math.min(
    pageSize.height,
    Math.max(18 / pageScale, Number(focus.heightRatio) * pageSize.height),
  )
  const centerX = Number(focus.xRatio) * pageSize.width
  const centerY = Number(focus.yRatio) * pageSize.height
  const left = Math.max(0, Math.min(pageSize.width - width, centerX - width / 2))
  const top = Math.max(0, Math.min(pageSize.height - height, centerY - height / 2))
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  }
}

function annotationIntersectsBounds(annotation, bounds) {
  const points = annotation?.points ?? []
  if (!points.length) return false
  const xs = points.map(point => Number(point.x)).filter(Number.isFinite)
  const ys = points.map(point => Number(point.y)).filter(Number.isFinite)
  if (!xs.length || !ys.length) return false
  const annotationBounds = {
    left: Math.min(...xs), right: Math.max(...xs),
    top: Math.min(...ys), bottom: Math.max(...ys),
  }
  return annotationBounds.right >= bounds.left
    && annotationBounds.left <= bounds.right
    && annotationBounds.bottom >= bounds.top
    && annotationBounds.top <= bounds.bottom
}

function rotateAround(point, pivot, angleRadians) {
  const cos = Math.cos(angleRadians)
  const sin = Math.sin(angleRadians)
  const dx = point.x - pivot.x
  const dy = point.y - pivot.y
  return {
    x: pivot.x + dx * cos - dy * sin,
    y: pivot.y + dx * sin + dy * cos,
  }
}

// Match the label's real rotated SVG rectangle so crossing/angled labels are
// moved only when their visible boxes genuinely overlap (an axis-aligned box
// would produce false positives around the corners of diagonal labels).
function labelCollisionPolygon(label, viewerScale) {
  const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
  const padding = LABEL_COLLISION_PADDING_PIXELS / pageScale
  const pivot = { x: label.x, y: label.y }
  const corners = [
    { x: label.x - label.width / 2 - padding, y: label.y - label.height - padding },
    { x: label.x + label.width / 2 + padding, y: label.y - label.height - padding },
    { x: label.x + label.width / 2 + padding, y: label.y + padding },
    { x: label.x - label.width / 2 - padding, y: label.y + padding },
  ]
  const radians = (Number(label.angle) || 0) * (Math.PI / 180)
  return corners.map(corner => rotateAround(corner, pivot, radians))
}

function polygonsOverlap(first, second) {
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.length; index += 1) {
      const current = polygon[index]
      const next = polygon[(index + 1) % polygon.length]
      const axis = { x: -(next.y - current.y), y: next.x - current.x }
      const firstProjection = first.map(point => point.x * axis.x + point.y * axis.y)
      const secondProjection = second.map(point => point.x * axis.x + point.y * axis.y)
      const firstMin = Math.min(...firstProjection)
      const firstMax = Math.max(...firstProjection)
      const secondMin = Math.min(...secondProjection)
      const secondMax = Math.max(...secondProjection)
      if (firstMax <= secondMin || secondMax <= firstMin) return false
    }
  }
  return true
}

function polygonBounds(polygon) {
  const xs = polygon.map(point => point.x)
  const ys = polygon.map(point => point.y)
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  }
}

function collisionGridKeys(polygon, cellSize) {
  const bounds = polygonBounds(polygon)
  const keys = []
  const fromX = Math.floor(bounds.left / cellSize)
  const toX = Math.floor(bounds.right / cellSize)
  const fromY = Math.floor(bounds.top / cellSize)
  const toY = Math.floor(bounds.bottom / cellSize)
  for (let x = fromX; x <= toX; x += 1) {
    for (let y = fromY; y <= toY; y += 1) keys.push(`${x}:${y}`)
  }
  return keys
}

function preferredParallelLabelSide(annotation, annotationIndex, annotations, baseLabel, viewerScale) {
  const start = annotation.points?.[0]
  const end = annotation.points?.[annotation.points.length - 1]
  if (!start || !end) return 1
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lineLength = Math.hypot(dx, dy)
  if (lineLength <= 0.001) return 1

  const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
  const tangent = { x: dx / lineLength, y: dy / lineLength }
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const fromLine = { x: baseLabel.x - midpoint.x, y: baseLabel.y - midpoint.y }
  const fromLineLength = Math.hypot(fromLine.x, fromLine.y)
  const normal = fromLineLength > 0.001
    ? { x: fromLine.x / fromLineLength, y: fromLine.y / fromLineLength }
    : { x: -tangent.y, y: tangent.x }
  const maxSeparation = (baseLabel.height * pageScale + PARALLEL_LABEL_EXTRA_CLEARANCE_PIXELS) / pageScale
  const minOverlap = PARALLEL_LABEL_MIN_OVERLAP_PIXELS / pageScale
  let nearest = null

  annotations.forEach((candidate, candidateIndex) => {
    if (candidateIndex === annotationIndex || candidate.type === 'count') return
    const candidateStart = candidate.points?.[0]
    const candidateEnd = candidate.points?.[candidate.points.length - 1]
    if (!candidateStart || !candidateEnd) return
    const candidateDx = candidateEnd.x - candidateStart.x
    const candidateDy = candidateEnd.y - candidateStart.y
    const candidateLength = Math.hypot(candidateDx, candidateDy)
    if (candidateLength <= 0.001) return
    const directionDot = Math.abs(
      tangent.x * (candidateDx / candidateLength) + tangent.y * (candidateDy / candidateLength),
    )
    if (directionDot < PARALLEL_LABEL_DIRECTION_COSINE) return

    const candidateMidpoint = {
      x: (candidateStart.x + candidateEnd.x) / 2,
      y: (candidateStart.y + candidateEnd.y) / 2,
    }
    const betweenMidpoints = {
      x: candidateMidpoint.x - midpoint.x,
      y: candidateMidpoint.y - midpoint.y,
    }
    const signedSeparation = betweenMidpoints.x * normal.x + betweenMidpoints.y * normal.y
    const separation = Math.abs(signedSeparation)
    if (separation > maxSeparation) return

    const candidateProjectionA = (candidateStart.x - midpoint.x) * tangent.x
      + (candidateStart.y - midpoint.y) * tangent.y
    const candidateProjectionB = (candidateEnd.x - midpoint.x) * tangent.x
      + (candidateEnd.y - midpoint.y) * tangent.y
    const overlap = Math.min(lineLength / 2, Math.max(candidateProjectionA, candidateProjectionB))
      - Math.max(-lineLength / 2, Math.min(candidateProjectionA, candidateProjectionB))
    if (overlap < minOverlap) return

    if (!nearest || separation < nearest.separation) nearest = { separation, signedSeparation }
  })

  if (!nearest) return 1
  // Coincident lines have no geometric outer side. Alternate deterministically
  // so their labels are still distinguishable instead of occupying one box.
  if (nearest.separation < 0.5 / pageScale) return annotationIndex % 2 === 0 ? 1 : -1
  // If the neighbouring line is on the normal/top side, place this label on
  // the opposite side. The neighbour performs the symmetric calculation, so
  // a close parallel pair naturally receives one label above and one below.
  return nearest.signedSeparation > 0 ? -1 : 1
}

function labelPlacementCandidates(annotation, baseLabel, viewerScale, preferredSide = 1) {
  const start = annotation.points[0]
  const end = annotation.points[annotation.points.length - 1]
  if (!start || !end) return [baseLabel]
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lineLength = Math.hypot(dx, dy)
  if (lineLength <= 0.001) return [baseLabel]

  const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const tangent = { x: dx / lineLength, y: dy / lineLength }
  const fromLine = { x: baseLabel.x - midpoint.x, y: baseLabel.y - midpoint.y }
  const fromLineLength = Math.hypot(fromLine.x, fromLine.y)
  const normal = fromLineLength > 0.001
    ? { x: fromLine.x / fromLineLength, y: fromLine.y / fromLineLength }
    : { x: -tangent.y, y: tangent.x }

  // Search close to the midpoint first. The tangent step is based on the
  // rendered label width, so the result stays useful for both short and long
  // marks without changing the line itself or its measured length.
  const alongStep = baseLabel.width * 0.7 + LABEL_COLLISION_PADDING_PIXELS / pageScale
  const maxAlong = Math.max(0, lineLength / 2 - Math.min(baseLabel.width / 2, lineLength / 2))
  const rawOffsets = [0, -alongStep, alongStep, -alongStep * 2, alongStep * 2]
  const alongOffsets = []
  const seenOffsets = new Set()
  rawOffsets.forEach(rawOffset => {
    const offset = Math.max(-maxAlong, Math.min(maxAlong, rawOffset))
    const key = offset.toFixed(4)
    if (seenOffsets.has(key)) return
    seenOffsets.add(key)
    alongOffsets.push(offset)
  })

  const laneStep = baseLabel.height + (LABEL_COLLISION_PADDING_PIXELS * 2) / pageScale
  const baseNormalDistance = Math.max(fromLineLength, 0.001)
  const positiveOffsets = []
  const negativeOffsets = []
  for (let lane = 0; lane <= LABEL_COLLISION_MAX_LANES; lane += 1) {
    const distance = baseNormalDistance + laneStep * lane
    // Keep the first label in its established position. If it collides, try
    // the matching position on the other side of this annotation before
    // moving along the line. Nearby parallel measurements therefore read as
    // one label above and one below their respective lines, rather than a
    // label drifting onto its neighbour and becoming visually ambiguous.
    // The SVG label anchor is its near/bottom edge rather than its centre.
    // Include the label height when crossing the line so the mirrored box is
    // wholly on the opposite side instead of straddling the measurement.
    positiveOffsets.push(distance)
    negativeOffsets.push(-(distance + baseLabel.height))
  }
  // Exhaust the geometrically preferred side first. If another label already
  // occupies the nearest lower/upper lane, move farther on that same side
  // instead of immediately crossing back over the measurement and becoming
  // ambiguous with its parallel neighbour.
  const normalOffsets = preferredSide < 0
    ? [...negativeOffsets, ...positiveOffsets]
    : [...positiveOffsets, ...negativeOffsets]
  const candidates = []
  // Stay visually attached to the measurement: exhaust the small midpoint/
  // along-line adjustments in the nearest lane before trying a lane farther
  // away. This keeps ownership obvious even in a dense group of dimensions.
  for (const normalOffset of normalOffsets) {
    for (const along of alongOffsets) {
      candidates.push({
        ...baseLabel,
        x: midpoint.x + tangent.x * along + normal.x * normalOffset,
        y: midpoint.y + tangent.y * along + normal.y * normalOffset,
      })
    }
  }
  return candidates
}

function layoutMeasurementLabels(annotations, viewerScale) {
  const layouts = new Map()
  const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
  const cellSize = 80 / pageScale
  const collisionGrid = new Map()
  annotations.forEach((annotation, annotationIndex) => {
    if (annotation.type === 'count') return
    const baseLabel = labelGeometry(annotation, viewerScale)
    if (!baseLabel || (!baseLabel.mark && !baseLabel.value)) return
    const preferredSide = preferredParallelLabelSide(
      annotation,
      annotationIndex,
      annotations,
      baseLabel,
      viewerScale,
    )
    const candidates = labelPlacementCandidates(annotation, baseLabel, viewerScale, preferredSide)
    let chosen = candidates[candidates.length - 1]
    let chosenPolygon = labelCollisionPolygon(chosen, viewerScale)
    let fewestOverlaps = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const polygon = labelCollisionPolygon(candidate, viewerScale)
      const nearby = new Set()
      collisionGridKeys(polygon, cellSize).forEach(key => {
        collisionGrid.get(key)?.forEach(existing => nearby.add(existing))
      })
      const overlapCount = [...nearby].filter(existing => polygonsOverlap(polygon, existing)).length
      if (overlapCount < fewestOverlaps) {
        chosen = candidate
        chosenPolygon = polygon
        fewestOverlaps = overlapCount
      }
      if (overlapCount === 0) break
    }
    layouts.set(String(annotation.id), chosen)
    collisionGridKeys(chosenPolygon, cellSize).forEach(key => {
      const cell = collisionGrid.get(key)
      if (cell) cell.push(chosenPolygon)
      else collisionGrid.set(key, [chosenPolygon])
    })
  })
  return layouts
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

function MeasurementLabel({ annotation, colorOverride, viewerScale, onLabelSizeChange, selected, onSelect, anySelected, forceVisible, labelLayout }) {
  const groupRef = useRef(null)
  const showMeasurementLabels = useAppStore(s => s.showMeasurementLabels)
  const label = labelLayout ?? labelGeometry(annotation, viewerScale)

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
        stroke={colorOverride ?? annotation.color}
        strokeWidth={label.borderWidth}
      />
      {label.mark && (
        <text x={label.x} y={label.y - label.height + label.fontSize * 1.05} textAnchor="middle"
          fill={colorOverride ?? annotation.color} fontSize={label.fontSize} fontWeight="700">
          {label.mark}
        </text>
      )}
      {label.value && (
        <text x={label.x} y={label.y - label.fontSize * .35} textAnchor="middle"
          fill={colorOverride ?? annotation.color} fontSize={label.fontSize} fontWeight="700">
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
  labelLayout,
  colorOverride,
}) {
  const displayColor = colorOverride ?? annotation.color
  const points = annotation.points.map(p => `${p.x},${p.y}`).join(' ')
  const common = {
    fill: annotation.type === 'area' ? colorWithAlpha(displayColor, .2) : 'none',
    stroke: displayColor,
    strokeWidth: annotation.thickness,
    strokeOpacity: annotation.opacity,
    strokeDasharray: dashArray(annotation.lineStyle),
    vectorEffect: 'none',
  }

  if (annotation.type === 'count') {
    const p = annotation.points[0]
    return <circle cx={p.x} cy={p.y} r={5} {...common} fill={displayColor} />
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
          fill="#fff" stroke={displayColor} strokeWidth="1" pointerEvents="none" />
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
            stroke={displayColor}
            strokeWidth={handleStrokeWidth}
            pointerEvents="all"
            style={{ cursor: 'crosshair' }}
            onPointerDown={event => onEndpointPointerDown?.(event, annotation, pointIndex)}
          />
        )
      })}
      <MeasurementLabel annotation={annotation} colorOverride={colorOverride} viewerScale={viewerScale} onLabelSizeChange={onLabelSizeChange}
        selected={selected} anySelected={anySelected} onSelect={onSelect} forceVisible={forceLabelVisible}
        labelLayout={labelLayout} />
    </g>
  )
}

function PdfSvgOverlay({
  pageNumber,
  pageSize,
  viewerScale,
  annotations,
  pdfLineEndpoints,
  pdfLineSegments,
  selectedAnnotationId,
  selectedAnnotationIds,
  pasteClipboard,
  sectionPlacementMode,
  sectionPlacements,
  sectionFocus,
  sectionFocuses = [],
  sectionMeasurementColors = [],
  sectionDraftColor = '#3B82F6',
  measurementGroupSelection,
  sectionEditMode,
  onSectionEditRequest,
  onMeasure,
  onSectionSelection,
  onMeasurementGroupSelection,
  onSectionPlacement,
  onSectionPlacementContextMenu,
  onSelect,
  onAnnotationContextMenu,
  onClearSelection,
  onGeometryChange,
  onLabelSizeChange,
}) {
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const draftStartRef = useRef(null)
  const sectionStartRef = useRef(null)
  const sectionResizeRef = useRef(null)
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
  const [endpointSnap, setEndpointSnap] = useState(null)
  const [sectionStart, setSectionStart] = useState(null)
  const [sectionCursor, setSectionCursor] = useState(null)
  const [sectionResizeBounds, setSectionResizeBounds] = useState(null)

  const {
    activeTool,
    activeUnit,
    measureColor,
    measureCategory,
    lineThickness,
    lineStyle,
    measureLabelFontSize,
    selectedDrawing,
    snapEnabled,
    spaceHeld,
  } = useAppStore()

  useEffect(() => {
    draftStartRef.current = null
    setDraftStart(null)
    setCursor(null)
    setEndpointSnap(null)
    sectionStartRef.current = null
    setSectionStart(null)
    setSectionCursor(null)
  }, [activeTool, pageNumber])

  useEffect(() => {
    sectionResizeRef.current = null
    setSectionResizeBounds(
      sectionEditMode && Number(sectionEditMode.pageNumber) === Number(pageNumber)
        ? sectionBoundsFromFocus(sectionEditMode, pageSize, viewerScale)
        : null,
    )
  }, [pageNumber, pageSize.height, pageSize.width, sectionEditMode, viewerScale])

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
    setEndpointSnap(null)
  }, [pasteClipboard])

  // Turning Snap off is a display/placement preference only. Clear any
  // currently highlighted target immediately without touching the active
  // tool, draft line, selection, or saved annotations.
  useEffect(() => {
    if (!snapEnabled) setEndpointSnap(null)
  }, [snapEnabled])

  const pageAnnotations = useMemo(() => annotations.map(annotation => {
    if (dragged?.id !== annotation.id) return annotation
    return { ...annotation, points: dragged.points }
  }), [annotations, dragged])

  // Preserve the established midpoint placement unless two visible label
  // boxes collide. Since saved annotations are rendered before the newly
  // pending one, an existing label stays put and only the new conflicting
  // label takes the nearest available position along its own measurement.
  const labelLayouts = useMemo(
    () => layoutMeasurementLabels(pageAnnotations, viewerScale),
    [pageAnnotations, viewerScale],
  )

  const pdfEndpointGrid = useMemo(() => {
    const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
    const cellSize = ENDPOINT_SNAP_SCREEN_PIXELS / pageScale
    const cells = new Map()
    for (const endpoint of pdfLineEndpoints ?? []) {
      const x = Number(endpoint?.x)
      const y = Number(endpoint?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const key = `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`
      const cell = cells.get(key)
      if (cell) cell.push(endpoint)
      else cells.set(key, [endpoint])
    }
    return { cellSize, cells }
  }, [pdfLineEndpoints, viewerScale])

  const nearbyPdfEndpoints = useCallback((point) => {
    const { cellSize, cells } = pdfEndpointGrid
    const centerX = Math.floor(point.x / cellSize)
    const centerY = Math.floor(point.y / cellSize)
    const candidates = []
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const cell = cells.get(`${centerX + offsetX}:${centerY + offsetY}`)
        if (cell) candidates.push(...cell)
      }
    }
    return candidates
  }, [pdfEndpointGrid])

  const pdfSegmentGrid = useMemo(() => {
    const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
    const cellSize = PDF_LINE_GRID_SCREEN_PIXELS / pageScale
    const cells = new Map()
    for (let segmentIndex = 0; segmentIndex < (pdfLineSegments?.length ?? 0); segmentIndex += 1) {
      const segment = pdfLineSegments[segmentIndex]
      const start = { x: Number(segment?.start?.x), y: Number(segment?.start?.y) }
      const end = { x: Number(segment?.end?.x), y: Number(segment?.end?.y) }
      if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) continue
      const dx = end.x - start.x
      const dy = end.y - start.y
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / cellSize))
      const visited = new Set()
      for (let step = 0; step <= steps; step += 1) {
        const ratio = step / steps
        const key = `${Math.floor((start.x + dx * ratio) / cellSize)}:${Math.floor((start.y + dy * ratio) / cellSize)}`
        if (visited.has(key)) continue
        visited.add(key)
        const entry = { start, end, segmentIndex }
        const cell = cells.get(key)
        if (cell) cell.push(entry)
        else cells.set(key, [entry])
      }
    }
    return { cellSize, cells, pageScale }
  }, [pdfLineSegments, viewerScale])

  const findClickedPdfLine = useCallback((point) => {
    const { cellSize, cells, pageScale } = pdfSegmentGrid
    if (!cells.size) return null
    const centerX = Math.floor(point.x / cellSize)
    const centerY = Math.floor(point.y / cellSize)
    const seen = new Set()
    let nearest = null
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const candidates = cells.get(`${centerX + offsetX}:${centerY + offsetY}`) ?? []
        for (const segment of candidates) {
          if (seen.has(segment.segmentIndex)) continue
          seen.add(segment.segmentIndex)
          const dx = segment.end.x - segment.start.x
          const dy = segment.end.y - segment.start.y
          const lengthSquared = dx * dx + dy * dy
          if (lengthSquared <= 0.0001) continue
          if (Math.sqrt(lengthSquared) * pageScale < MIN_LINE_SCREEN_PIXELS) continue
          const projection = Math.max(0, Math.min(1,
            (((point.x - segment.start.x) * dx) + ((point.y - segment.start.y) * dy)) / lengthSquared,
          ))
          const closest = {
            x: segment.start.x + dx * projection,
            y: segment.start.y + dy * projection,
          }
          const screenDistance = Math.hypot(point.x - closest.x, point.y - closest.y) * pageScale
          if (screenDistance > PDF_LINE_HIT_SCREEN_PIXELS) continue
          if (!nearest || screenDistance < nearest.screenDistance) {
            nearest = { ...segment, screenDistance }
          }
        }
      }
    }
    return nearest
  }, [pdfSegmentGrid])

  const resolveEndpointSnap = useCallback((point) => {
    const svg = svgRef.current
    const snapCommandActive = Boolean(pasteClipboard) || ['line', 'calibrate'].includes(activeTool)
    if (!snapEnabled || !svg || !snapCommandActive || spaceHeld) return null
    const rect = svg.getBoundingClientRect()
    return findNearestLineEndpoint(
      point,
      pageAnnotations,
      nearbyPdfEndpoints(point),
      pageSize,
      { width: rect.width, height: rect.height },
      ENDPOINT_SNAP_SCREEN_PIXELS,
    )
  }, [activeTool, nearbyPdfEndpoints, pageAnnotations, pageSize, pasteClipboard, snapEnabled, spaceHeld])

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
    // While positioning paste previews, the wheel belongs to navigation/pan.
    // A pasted occurrence may remain selected after placement, but that must
    // not make ordinary wheel movement resize its label in the middle of the
    // paste workflow. Ending paste mode restores the existing selected-label
    // wheel resize behaviour automatically.
    // A rectangle-built group selection keeps one annotation as its primary
    // item for existing grid/context-menu behaviour. That primary must not
    // turn the page wheel into label resizing: users still need to scroll and
    // navigate while the selected rectangle remains visible.
    if (!svg || pasteClipboard || measurementGroupSelection || selectedAnnotationId == null) return undefined
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
  }, [measurementGroupSelection, selectedAnnotationId, pageAnnotations, onLabelSizeChange, pageNumber, pasteClipboard])

  // Bluebeam-style paste uses the final endpoint of the first copied line as
  // its cursor/reference point. translateRawLine accepts a target centre, so
  // keep each copied line's original centre and final-endpoint offsets from
  // that anchor. Every item receives exactly the same translation, preserving
  // its vector, length, and position relative to the other copied measurements.
  const itemOffsets = useMemo(() => {
    if (!pasteClipboard?.items?.length) return []
    const geometries = pasteClipboard.items.map(item => {
      const raw = item.copyJson ?? item.raw
      const points = raw ? annotationPoints(raw, pageSize) : []
      const start = points[0]
      const end = points[points.length - 1]
      const center = start && end
        ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        : null
      return { item, center, end }
    })
    const anchor = geometries[0]
    const anchorReference = anchor?.end ?? anchor?.center
    if (!anchorReference) return []
    return geometries.map(({ item, center, end }) => ({
      item,
      dx: (center?.x ?? anchorReference.x) - anchorReference.x,
      dy: (center?.y ?? anchorReference.y) - anchorReference.y,
      endpointDx: (end?.x ?? anchorReference.x) - anchorReference.x,
      endpointDy: (end?.y ?? anchorReference.y) - anchorReference.y,
    }))
  }, [pageSize, pasteClipboard])

  // In a multi-copy paste, every copied line's final endpoint is a valid snap
  // probe. Whichever one is closest to a PDF/measurement endpoint adjusts the
  // shared anchor point, so the whole selection moves as one rigid group while
  // the endpoint that acquired the target lands exactly on it.
  const resolvePasteGroupSnap = useCallback((anchorPoint) => {
    if (!pasteClipboard || !itemOffsets.length) return null
    let nearest = null
    for (const offset of itemOffsets) {
      const endpoint = {
        x: anchorPoint.x + offset.endpointDx,
        y: anchorPoint.y + offset.endpointDy,
      }
      const snap = resolveEndpointSnap(endpoint)
      if (!snap || (nearest && snap.screenDistance >= nearest.screenDistance)) continue
      nearest = {
        ...snap,
        anchorPoint: {
          x: snap.point.x - offset.endpointDx,
          y: snap.point.y - offset.endpointDy,
        },
        clipboardItemId: offset.item.clipboardItemId,
      }
    }
    return nearest
  }, [itemOffsets, pasteClipboard, resolveEndpointSnap])

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
      manualMemberSelected: Boolean(schedule),
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
    const rawPoint = toPdfPoint(event, svgRef.current, pageSize)
    if (pasteClipboard) {
      event.stopPropagation()
      const snap = resolvePasteGroupSnap(rawPoint)
      const point = snap?.anchorPoint ?? rawPoint
      setEndpointSnap(snap)
      placePaste(point)
      return
    }
    if (['line', 'calibrate'].includes(activeTool)) {
      // Keep a manually selected schedule member armed between the first and
      // second placement clicks. Clearing it here preserved only its toolbar
      // color and allowed PDF label auto-detect to replace its metadata.
      event.stopPropagation()
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
  }, [activeTool, onClearSelection, pageSize, pasteClipboard, placePaste, resolvePasteGroupSnap])

  const handleSectionResizePointerDown = useCallback((event, handle) => {
    if (event.button !== 0 || !svgRef.current || !sectionEditMode) return
    const bounds = sectionResizeBounds
      ?? sectionBoundsFromFocus(sectionEditMode, pageSize, viewerScale)
    if (!bounds) return
    event.preventDefault()
    event.stopPropagation()
    svgRef.current.setPointerCapture?.(event.pointerId)
    sectionResizeRef.current = {
      pointerId: event.pointerId,
      handle,
      initialBounds: bounds,
      latestBounds: bounds,
    }
  }, [pageSize, sectionEditMode, sectionResizeBounds, viewerScale])

  const handlePointerDown = useCallback((event) => {
    // Held-Space always means "pan", even over Line/Calibrate — bail without
    // capturing so the gesture bubbles up to the viewer's own pan handler
    // instead of starting/finalizing a draw.
    if (spaceHeld) return
    if (['section', 'group-select'].includes(activeTool) && event.button === 0 && !pasteClipboard) {
      // While editing a saved section, only its visible resize handles should
      // change the boundary. Clicking elsewhere must not start a second group.
      if (activeTool === 'section' && sectionEditMode?.id) return
      if (!svgRef.current) return
      event.preventDefault()
      event.stopPropagation()
      const point = toPdfPoint(event, svgRef.current, pageSize)
      if (activeTool === 'section' && sectionPlacementMode?.id) {
        onSectionPlacement?.({
          sectionId: sectionPlacementMode.id,
          pageNumber,
          xRatio: point.x / Math.max(1, pageSize.width),
          yRatio: point.y / Math.max(1, pageSize.height),
          clickCount: Number(event.detail) || 1,
        })
        return
      }
      sectionStartRef.current = point
      setSectionStart(point)
      setSectionCursor(point)
      svgRef.current.setPointerCapture?.(event.pointerId)
      return
    }
    if (pasteClipboard || !['line', 'calibrate'].includes(activeTool) || event.button !== 0) return
    if (!svgRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const rawPoint = toPdfPoint(event, svgRef.current, pageSize)
    const snap = resolveEndpointSnap(rawPoint)
    const point = snap?.point ?? rawPoint
    setEndpointSnap(snap)
    const start = draftStartRef.current

    // Single clicks always retain the established manual workflow: the first
    // chooses the start point and the next chooses the end point.
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
  }, [activeTool, finalizeLine, onSectionPlacement, pageNumber, pageSize, pasteClipboard, resolveEndpointSnap, sectionEditMode, sectionPlacementMode, spaceHeld])

  const handleDoubleClick = useCallback((event) => {
    if (spaceHeld || pasteClipboard || activeTool !== 'line' || event.button !== 0) return
    if (!svgRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const rawPoint = toPdfPoint(event, svgRef.current, pageSize)
    const detectedLine = findClickedPdfLine(rawPoint)
    if (!detectedLine) return
    finalizeLine(detectedLine.end, detectedLine.start)
  }, [activeTool, finalizeLine, findClickedPdfLine, pageSize, pasteClipboard, spaceHeld])

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
    const rawPoint = toPdfPoint(event, svgRef.current, pageSize)
    const sectionResize = sectionResizeRef.current
    if (sectionResize && sectionResize.pointerId === event.pointerId) {
      const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
      const minimum = 18 / pageScale
      const point = {
        x: Math.max(0, Math.min(pageSize.width, rawPoint.x)),
        y: Math.max(0, Math.min(pageSize.height, rawPoint.y)),
      }
      let {
        left, right, top, bottom,
      } = sectionResize.initialBounds
      if (sectionResize.handle.includes('w')) left = Math.min(point.x, right - minimum)
      if (sectionResize.handle.includes('e')) right = Math.max(point.x, left + minimum)
      if (sectionResize.handle.includes('n')) top = Math.min(point.y, bottom - minimum)
      if (sectionResize.handle.includes('s')) bottom = Math.max(point.y, top + minimum)
      left = Math.max(0, left)
      right = Math.min(pageSize.width, right)
      top = Math.max(0, top)
      bottom = Math.min(pageSize.height, bottom)
      const bounds = {
        left, right, top, bottom,
        width: right - left,
        height: bottom - top,
      }
      sectionResize.latestBounds = bounds
      setSectionResizeBounds(bounds)
      return
    }
    if (sectionStartRef.current
      && ['section', 'group-select'].includes(activeTool)
      && !(activeTool === 'section' && sectionPlacementMode?.id)) {
      setSectionCursor(rawPoint)
      return
    }
    const drag = dragRef.current
    const snap = !drag
      ? (pasteClipboard ? resolvePasteGroupSnap(rawPoint) : resolveEndpointSnap(rawPoint))
      : null
    const point = pasteClipboard ? (snap?.anchorPoint ?? rawPoint) : (snap?.point ?? rawPoint)
    setEndpointSnap(snap)
    setCursor(point)
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
  }, [activeTool, pageSize, pasteClipboard, publishGeometryChange, resolveEndpointSnap, resolvePasteGroupSnap, sectionPlacementMode, viewerScale])

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

  const handlePointerUp = useCallback((event) => {
    const sectionResize = sectionResizeRef.current
    if (sectionResize && sectionResize.pointerId === event.pointerId) {
      const bounds = sectionResize.latestBounds ?? sectionResize.initialBounds
      sectionResizeRef.current = null
      svgRef.current?.releasePointerCapture?.(event.pointerId)
      const selected = pageAnnotations.filter(annotation => annotationIntersectsBounds(annotation, bounds))
      onSectionSelection?.({
        pageNumber,
        pageSize: { ...pageSize },
        bounds,
        center: {
          x: (bounds.left + bounds.right) / 2,
          y: (bounds.top + bounds.bottom) / 2,
        },
        annotations: selected,
      })
      return
    }
    const start = sectionStartRef.current
    if (start
      && ['section', 'group-select'].includes(activeTool)
      && !(activeTool === 'section' && sectionPlacementMode?.id)
      && svgRef.current) {
      const end = toPdfPoint(event, svgRef.current, pageSize)
      sectionStartRef.current = null
      setSectionStart(null)
      setSectionCursor(null)
      svgRef.current.releasePointerCapture?.(event.pointerId)
      const bounds = selectionBounds(start, end)
      const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
      if (bounds.width * pageScale < 8 || bounds.height * pageScale < 8) return
      const selected = pageAnnotations.filter(annotation => annotationIntersectsBounds(annotation, bounds))
      const selection = {
        pageNumber,
        pageSize: { ...pageSize },
        bounds,
        center: {
          x: (bounds.left + bounds.right) / 2,
          y: (bounds.top + bounds.bottom) / 2,
        },
        annotations: selected,
      }
      if (activeTool === 'group-select') {
        // Releasing a captured drag is followed by a synthetic click on the
        // SVG root. Consume that click so it cannot immediately run the
        // empty-space deselection path and erase the selection outline.
        shapeInteractedRef.current = true
        setTimeout(() => { shapeInteractedRef.current = false }, 0)
        onMeasurementGroupSelection?.(selection)
      } else {
        onSectionSelection?.(selection)
      }
      return
    }
    endDrag(event)
  }, [activeTool, endDrag, onMeasurementGroupSelection, onSectionSelection, pageAnnotations, pageNumber, pageSize, sectionPlacementMode, viewerScale])

  const handlePointerCancel = useCallback((event) => {
    if (sectionResizeRef.current?.pointerId === event.pointerId) {
      sectionResizeRef.current = null
      setSectionResizeBounds(sectionBoundsFromFocus(sectionEditMode, pageSize, viewerScale))
      svgRef.current?.releasePointerCapture?.(event.pointerId)
      return
    }
    if (sectionStartRef.current) {
      sectionStartRef.current = null
      setSectionStart(null)
      setSectionCursor(null)
      svgRef.current?.releasePointerCapture?.(event.pointerId)
      return
    }
    endDrag(event)
  }, [endDrag, pageSize, sectionEditMode, viewerScale])

  const dimensionCommandActive = ['line', 'calibrate'].includes(activeTool)
  const sectionCommandActive = activeTool === 'section'
  const groupSelectionCommandActive = activeTool === 'group-select'
  const interactive = pasteClipboard || activeTool === 'select' || dimensionCommandActive || sectionCommandActive || groupSelectionCommandActive
  const sectionColorByAnnotationId = new Map()
  sectionMeasurementColors
    .filter(section => Number(section.pageNumber) === Number(pageNumber))
    .forEach(section => section.annotationIds?.forEach(id => {
      if (!sectionColorByAnnotationId.has(String(id))) {
        sectionColorByAnnotationId.set(String(id), section.color)
      }
    }))
  const visiblePageSectionFocuses = (sectionFocuses.length > 0 ? sectionFocuses : (sectionFocus ? [sectionFocus] : []))
    .filter(section => Number(section.pageNumber) === Number(pageNumber))
  const sourcePlacementBySectionId = new Map((sectionPlacements ?? [])
    .filter(placement => placement.isSource && Number(placement.pageNumber) === Number(pageNumber))
    .map(placement => [Number(placement.sectionId), placement]))
  return (
    <svg
      ref={svgRef}
      className={`pdfjs-annotation-layer ${interactive ? 'is-interactive' : ''}`}
      viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
      preserveAspectRatio="none"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handleMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={() => {
        setEndpointSnap(null)
        if (!dragRef.current && !draftStartRef.current) setCursor(null)
      }}
    >
      {/*
        Let both placement clicks reach the SVG drawing surface even when the
        pointer is over an existing line, endpoint, or label.  Hit-testing is
        restored automatically as soon as the user leaves the dimension tool,
        so normal Select-mode editing remains unchanged.
      */}
      {activeTool === 'select' && visiblePageSectionFocuses.map(focus => {
        const sourcePlacement = sourcePlacementBySectionId.get(Number(focus.id))
        const bounds = sectionBoundsFromFocus(focus, pageSize, viewerScale)
        if (!sourcePlacement || !bounds) return null
        return (
          <rect
            key={`section-select-area-${focus.id}`}
            x={bounds.left}
            y={bounds.top}
            width={bounds.width}
            height={bounds.height}
            fill="transparent"
            pointerEvents="all"
            style={{ cursor: 'context-menu' }}
            onContextMenu={event => {
              event.preventDefault()
              event.stopPropagation()
              const counters = (sectionPlacements ?? []).filter(counter => (
                !counter.isSource && Number(counter.sectionId) === Number(sourcePlacement.sectionId)
              ))
              onSectionPlacementContextMenu?.(event, sourcePlacement, counters)
            }}
          >
            <title>Right-click to manage this section's counted locations</title>
          </rect>
        )
      })}
      <g pointerEvents={pasteClipboard || dimensionCommandActive || sectionCommandActive || groupSelectionCommandActive ? 'none' : 'auto'}>
        {pageAnnotations.map(annotation => (
          <AnnotationShape
            key={annotation.id}
            annotation={annotation}
            colorOverride={[annotation.id, annotation.dbId]
              .map(id => id == null ? null : sectionColorByAnnotationId.get(String(id)))
              .find(Boolean)}
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
            labelLayout={labelLayouts.get(String(annotation.id))}
          />
        ))}
      </g>
      {draftStart && cursor && (
        <line x1={draftStart.x} y1={draftStart.y} x2={cursor.x} y2={cursor.y}
          stroke={measureColor} strokeWidth={lineThickness} strokeDasharray={dashArray(lineStyle)}
          strokeLinecap="round" pointerEvents="none" />
      )}
      {sectionStart && sectionCursor && !sectionPlacementMode?.id && (() => {
        const bounds = selectionBounds(sectionStart, sectionCursor)
        const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
        const draftColor = activeTool === 'group-select' ? '#EF233C' : sectionDraftColor
        return (
          <rect
            x={bounds.left}
            y={bounds.top}
            width={bounds.width}
            height={bounds.height}
            fill={colorWithAlpha(draftColor, .1)}
            stroke={draftColor}
            strokeWidth={1.5 / pageScale}
            strokeDasharray={`${6 / pageScale} ${4 / pageScale}`}
            pointerEvents="none"
          />
        )
      })()}
      {Number(measurementGroupSelection?.pageNumber) === Number(pageNumber) && (() => {
        const bounds = measurementGroupSelection?.bounds
        if (!bounds
          || !Number.isFinite(Number(bounds.left))
          || !Number.isFinite(Number(bounds.top))
          || !Number.isFinite(Number(bounds.width))
          || !Number.isFinite(Number(bounds.height))) return null

        const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
        const selectionColor = '#EF233C'
        const count = Math.max(0, Number(measurementGroupSelection?.count) || 0)
        const label = `${count} selected`
        const labelHeight = 18 / pageScale
        const labelWidth = Math.max(70, label.length * 6.2) / pageScale
        const labelX = Number(bounds.left) + 4 / pageScale
        const labelY = Number(bounds.top) + 4 / pageScale

        return (
          <g className="pdfjs-measurement-group-selection" pointerEvents="none">
            <rect
              x={bounds.left}
              y={bounds.top}
              width={bounds.width}
              height={bounds.height}
              fill={colorWithAlpha(selectionColor, .08)}
              stroke={selectionColor}
              strokeWidth={2 / pageScale}
              strokeDasharray={`${7 / pageScale} ${4 / pageScale}`}
            />
            <rect
              x={labelX}
              y={labelY}
              width={labelWidth}
              height={labelHeight}
              rx={3 / pageScale}
              fill={selectionColor}
            />
            <text
              x={labelX + 7 / pageScale}
              y={labelY + 12.5 / pageScale}
              fill="#FFFFFF"
              fontSize={10 / pageScale}
              fontWeight="700"
            >
              {label}
            </text>
          </g>
        )
      })()}
      {visiblePageSectionFocuses.map(sectionFocus => {
        const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
        const editing = Boolean(sectionEditMode?.id)
          && Number(sectionEditMode.id) === Number(sectionFocus.id)
        const bounds = editing && sectionResizeBounds
          ? sectionResizeBounds
          : sectionBoundsFromFocus(sectionFocus, pageSize, viewerScale)
        if (!bounds) return null
        const { left, top, right, bottom, width, height } = bounds
        const sourcePlacement = sourcePlacementBySectionId.get(Number(sectionFocus.id))
        const usedPlaces = Math.max(0, Number(sectionFocus.usedPlaces) || 0)
        const label = editing
          ? `Resize ${sectionFocus.name} · drag a handle`
          : `${sectionFocus.name} · ${sectionFocus.measurementCount} measurement${Number(sectionFocus.measurementCount) === 1 ? '' : 's'} · click border to resize`
        const labelWidth = Math.max(86, label.length * 5.4) / pageScale
        const labelHeight = 17 / pageScale
        const labelY = Math.max(0, top - labelHeight - 3 / pageScale)
        const cornerBadgeHeight = 15 / pageScale
        const cornerBadgeInset = 5 / pageScale
        const cornerBadgeY = Math.max(top + cornerBadgeInset, bottom - cornerBadgeHeight - cornerBadgeInset)
        const quantityText = `QTY = ${usedPlaces}`
        const quantityBadgeWidth = Math.max(42, quantityText.length * 5.2) / pageScale
        const sourceText = `${sectionFocus.name} · Source`
        const sourceBadgeWidth = Math.max(62, sourceText.length * 5.2) / pageScale
        const quantityBadgeX = left + cornerBadgeInset
        const sourceBadgeX = Math.max(left + cornerBadgeInset, right - sourceBadgeWidth - cornerBadgeInset)
        const handleSize = 9 / pageScale
        const handles = [
          { id: 'nw', x: left, y: top, cursor: 'nwse-resize' },
          { id: 'n', x: (left + right) / 2, y: top, cursor: 'ns-resize' },
          { id: 'ne', x: right, y: top, cursor: 'nesw-resize' },
          { id: 'e', x: right, y: (top + bottom) / 2, cursor: 'ew-resize' },
          { id: 'se', x: right, y: bottom, cursor: 'nwse-resize' },
          { id: 's', x: (left + right) / 2, y: bottom, cursor: 'ns-resize' },
          { id: 'sw', x: left, y: bottom, cursor: 'nesw-resize' },
          { id: 'w', x: left, y: (top + bottom) / 2, cursor: 'ew-resize' },
        ]
        const requestEdit = (event) => {
          event.preventDefault()
          event.stopPropagation()
          onSectionEditRequest?.(sectionFocus.id)
        }
        const requestCounterMenu = sourcePlacement ? (event) => {
          event.preventDefault()
          event.stopPropagation()
          const counters = (sectionPlacements ?? []).filter(counter => (
            !counter.isSource && Number(counter.sectionId) === Number(sourcePlacement.sectionId)
          ))
          onSectionPlacementContextMenu?.(event, sourcePlacement, counters)
        } : undefined
        const sectionColor = sectionFocus.color ?? '#3B82F6'
        const sectionTextColor = readableTextColor(sectionColor)
        return (
          <g key={`section-focus-${sectionFocus.id}`} className="pdfjs-section-focus" onContextMenu={requestCounterMenu}>
            {!editing && (
              <rect
                x={left}
                y={top}
                width={width}
                height={height}
                fill="none"
                stroke={colorWithAlpha(sectionColor, .001)}
                strokeWidth={14 / pageScale}
                pointerEvents="stroke"
                style={{ cursor: 'pointer' }}
                onPointerDown={event => event.stopPropagation()}
                onClick={requestEdit}
              >
                <title>Click the section border to resize it</title>
              </rect>
            )}
            <rect x={left} y={top} width={width} height={height} rx={3 / pageScale}
              fill={colorWithAlpha(sectionColor, .12)} stroke={sectionColor} strokeWidth={2 / pageScale}
              strokeDasharray={`${7 / pageScale} ${4 / pageScale}`} pointerEvents="none" />
            <rect x={left} y={labelY} width={labelWidth} height={labelHeight} rx={3 / pageScale}
              fill="rgba(13,21,38,.96)" stroke={sectionColor} strokeWidth={1 / pageScale}
              pointerEvents={editing ? 'none' : 'all'} style={{ cursor: editing ? 'default' : 'pointer' }}
              onPointerDown={editing ? undefined : event => event.stopPropagation()}
              onClick={editing ? undefined : requestEdit} />
            <text x={left + 5 / pageScale} y={labelY + 11.5 / pageScale}
              fill={sectionColor} fontSize={8 / pageScale} fontWeight="800" pointerEvents="none">
              {label}
            </text>
            {!editing && sourcePlacement && (
              <>
                <g transform={`translate(${quantityBadgeX} ${cornerBadgeY})`} pointerEvents="none">
                  <rect width={quantityBadgeWidth} height={cornerBadgeHeight} rx={3 / pageScale}
                    fill={sectionColor} stroke="#fff" strokeWidth={.8 / pageScale} />
                  <text x={5 / pageScale} y={10.5 / pageScale} fill={sectionTextColor}
                    fontSize={8 / pageScale} fontWeight="800">
                    {quantityText}
                  </text>
                </g>
                <g transform={`translate(${sourceBadgeX} ${cornerBadgeY})`} pointerEvents="none">
                  <rect width={sourceBadgeWidth} height={cornerBadgeHeight} rx={3 / pageScale}
                    fill={sectionColor} stroke="#fff" strokeWidth={.8 / pageScale} />
                  <text x={5 / pageScale} y={10.5 / pageScale} fill={sectionTextColor}
                    fontSize={8 / pageScale} fontWeight="800">
                    {sourceText}
                  </text>
                </g>
              </>
            )}
            {editing && handles.map(handle => (
              <rect
                key={`section-resize-${handle.id}`}
                x={handle.x - handleSize / 2}
                y={handle.y - handleSize / 2}
                width={handleSize}
                height={handleSize}
                rx={1.5 / pageScale}
                fill="#fff"
                stroke={sectionColor}
                strokeWidth={2 / pageScale}
                pointerEvents="all"
                style={{ cursor: handle.cursor }}
                onPointerDown={event => handleSectionResizePointerDown(event, handle.id)}
              />
            ))}
          </g>
        )
      })}
      {(sectionPlacements ?? []).filter(placement => Number(placement.pageNumber) === Number(pageNumber)).map((placement) => {
        const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
        const x = Number(placement.xRatio) * pageSize.width
        const y = Number(placement.yRatio) * pageSize.height
        const source = Boolean(placement.isSource)
        const placeNumber = Number(placement.placeNumber) || 1
        const placeCount = Number(placement.placeCount) || 1
        const markerText = `${placement.sectionName ?? 'Section'} · ${placeNumber}/${placeCount}`
        const sectionColor = placement.color ?? '#3B82F6'
        const markerTextColor = readableTextColor(sectionColor)
        const sectionCounters = source
          ? (sectionPlacements ?? [])
            .filter(counter => !counter.isSource && Number(counter.sectionId) === Number(placement.sectionId))
            .sort((left, right) => (Number(left.placeNumber) || 0) - (Number(right.placeNumber) || 0))
          : []
        return (
          <g
            key={`section-placement-${placement.id}`}
            pointerEvents={spaceHeld ? 'none' : 'all'}
            style={activeTool === 'select' ? { cursor: 'context-menu' } : undefined}
            onContextMenu={event => {
              event.preventDefault()
              event.stopPropagation()
              onSectionPlacementContextMenu?.(event, placement, source ? sectionCounters : [placement])
            }}
          >
            <circle cx={x} cy={y} r={5 / pageScale}
              fill={source ? colorWithAlpha(sectionColor, .35) : sectionColor} stroke="#fff" strokeWidth={1 / pageScale} />
            <path d={`M ${x - 2 / pageScale} ${y} L ${x + 2 / pageScale} ${y} M ${x} ${y - 2 / pageScale} L ${x} ${y + 2 / pageScale}`}
              stroke="#fff" strokeWidth={1 / pageScale} />
            {source ? (
              <title>{`${placement.sectionName ?? 'Section'} source · QTY = ${Math.max(0, Number(placement.placeCount) || 0)}`}</title>
            ) : (
              <g transform={`translate(${x + 8 / pageScale} ${y - 7 / pageScale})`}>
                <rect x={0} y={0} width={Math.max(58, markerText.length * 5.2) / pageScale}
                  height={15 / pageScale} rx={3 / pageScale} fill={sectionColor} stroke="#fff" strokeWidth={.8 / pageScale} />
                <text x={5 / pageScale} y={10.5 / pageScale} fill={markerTextColor} fontSize={8 / pageScale} fontWeight="800">
                  {markerText}
                </text>
              </g>
            )}
          </g>
        )
      })}
      {endpointSnap && (dimensionCommandActive || pasteClipboard) && (() => {
        const pageScale = Number.isFinite(viewerScale) && viewerScale > 0 ? viewerScale : 1
        const size = ENDPOINT_SNAP_INDICATOR_PIXELS / pageScale
        return (
          <rect
            className="pdfjs-endpoint-snap-indicator"
            x={endpointSnap.point.x - size / 2}
            y={endpointSnap.point.y - size / 2}
            width={size}
            height={size}
            fill="rgba(255,255,255,.92)"
            stroke="#EF233C"
            strokeWidth={1 / pageScale}
            vectorEffect="none"
            pointerEvents="none"
          />
        )
      })()}
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
