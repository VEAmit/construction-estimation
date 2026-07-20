// User-facing label sizes (pt) — Bluebeam-style measurement label presets.
export const MEASURE_LABEL_PRESETS = [
  { value: 10, label: 'S', title: 'Small (10pt)' },
  { value: 14, label: 'M', title: 'Medium (14pt)' },
  { value: 18, label: 'L', title: 'Large (18pt)' },
  { value: 24, label: 'XL', title: 'Extra Large (24pt)' },
]

export const DEFAULT_MEASURE_LABEL_SIZE = 14

/** Visual scale tied to each label-size preset (line weight + label gap). */
const LINE_LABEL_VISUAL_SCALE = {
  10: { defaultThickness: 1, syncLeaderHeight: 6, leaderLineExtension: 0, labelGap: 10 },
  14: { defaultThickness: 1.5, syncLeaderHeight: 8, leaderLineExtension: 0, labelGap: 14 },
  18: { defaultThickness: 2, syncLeaderHeight: 10, leaderLineExtension: 0, labelGap: 18 },
  24: { defaultThickness: 3, syncLeaderHeight: 12, leaderLineExtension: 0, labelGap: 24 },
}

/** PDF-space gap between the measurement line and the label (scales with zoom). */
export function computeLinearLabelGap(userPt, pdfScale = 1) {
  const preset = LINE_LABEL_VISUAL_SCALE[userPt] ?? LINE_LABEL_VISUAL_SCALE[DEFAULT_MEASURE_LABEL_SIZE]
  const scale = Math.max(pdfScale, 0.25)
  return (preset.labelGap ?? 14) / scale
}

export function defaultLineThicknessForLabelSize(userPt) {
  return LINE_LABEL_VISUAL_SCALE[userPt]?.defaultThickness
    ?? LINE_LABEL_VISUAL_SCALE[DEFAULT_MEASURE_LABEL_SIZE].defaultThickness
}

export function resolveLinearThickness(userPt, thicknessOverride) {
  if (thicknessOverride != null && thicknessOverride > 0) return thicknessOverride
  return defaultLineThicknessForLabelSize(userPt)
}

function hexToRgba(hex, alpha) {
  const safe = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : '#111827'
  const r = parseInt(safe.slice(1, 3), 16)
  const g = parseInt(safe.slice(3, 5), 16)
  const b = parseInt(safe.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * Syncfusion renders labels in PDF coordinate space. Convert the user-selected
 * point size to a Syncfusion fontSize and compensate for zoom so labels stay
 * readable on screen (Bluebeam-style).
 */
export function toSyncfusionLabelSize(userPt, pdfScale = 1) {
  const scale = Math.max(pdfScale, 0.25)
  const base = userPt * 2.35
  return Math.max(12, Math.min(72, Math.round(base / scale)))
}

/** Resolve effective arrow style from line mode + toolbar arrow setting. */
export function resolveLinearArrowStyle(arrowStyle = 'none', linearLineMode = 'simple') {
  if (linearLineMode === 'simple') return 'none'
  return arrowStyle === 'none' ? 'both' : arrowStyle
}

/** Infer arrow toolbar id from stored Syncfusion line-head styles. */
export function inferArrowStyleFromAnnot(raw) {
  if (!raw || typeof raw !== 'object') return 'none'
  const start = raw.lineHeadStartStyle ?? raw.LineHeadStartStyle ?? 'None'
  const end = raw.lineHeadEndStyle ?? raw.LineHeadEndStyle ?? 'None'
  const hasStart = start === 'ClosedArrow' || start === 'OpenArrow' || start === 'ROpenArrow' || start === 'RClosedArrow'
  const hasEnd = end === 'ClosedArrow' || end === 'OpenArrow' || end === 'ROpenArrow' || end === 'RClosedArrow'
  if (hasStart && hasEnd) return 'both'
  if (hasStart) return 'start'
  if (hasEnd) return 'end'
  return 'none'
}

/** Infer simple vs arrow line mode from stored annotation. */
export function inferLinearLineModeFromAnnot(raw) {
  return inferArrowStyleFromAnnot(raw) === 'none' ? 'simple' : 'arrow'
}

function hasVisibleDash(value) {
  if (value == null || value === false) return false
  if (Array.isArray(value)) return value.some(n => Number(n) > 0)
  const text = String(value).trim()
  if (!text || text === '0' || text === '0,0' || text === '0 0') return false
  return text.split(/[,\s]+/).some(part => Number(part) > 0)
}

function inferLineStyleFromAnnot(raw) {
  const explicit = String(raw.lineStyle ?? raw.LineStyle ?? '').trim().toLowerCase()
  if (explicit === 'dashed' || explicit === 'dash') return 'dashed'
  if (explicit === 'dotted' || explicit === 'dot') return 'dotted'
  if (explicit === 'solid') return 'solid'
  return hasVisibleDash(raw.borderDashArray ?? raw.BorderDashArray) ? 'dashed' : 'solid'
}

/** Map Syncfusion fontSize back to nearest label-size preset (pt). */
export function inferLabelSizeFromSfFontSize(sfSize, pdfScale = 1) {
  const n = Number(sfSize)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MEASURE_LABEL_SIZE
  const scale = Math.max(pdfScale, 0.25)
  const userApprox = (n * scale) / 2.35
  return MEASURE_LABEL_PRESETS.reduce(
    (best, p) => (Math.abs(p.value - userApprox) < Math.abs(best - userApprox) ? p.value : best),
    DEFAULT_MEASURE_LABEL_SIZE,
  )
}

/** Build clipboard payload from a saved takeoff row + parsed pointsJson. */
export function buildLinearMeasurementClipboard(item, raw, pdfScale = 1) {
  const thickness = raw.Thickness ?? raw.thickness ?? defaultLineThicknessForLabelSize(DEFAULT_MEASURE_LABEL_SIZE)
  const sfFont = raw.FontSize ?? raw.fontSize
  const explicitLabelSize = Number(raw.labelUserFontSize ?? raw.LabelUserFontSize)
  const labelFontSize = Number.isFinite(explicitLabelSize) && explicitLabelSize > 0
    ? explicitLabelSize
    : inferLabelSizeFromSfFontSize(sfFont, pdfScale)
  const arrowStyle = inferArrowStyleFromAnnot(raw)
  const notes = item.notes ?? item.Notes ?? ''
  const msiMatch = String(notes).match(/\bmsi:(\d+)/i)
  const linkedMatch = String(notes).match(/\blinkedItem:(\d+)/i)
  const memberScheduleId = item.memberScheduleId
    ?? item.memberScheduleItemId
    ?? (msiMatch ? Number(msiMatch[1]) : null)
  const linkedItemId = linkedMatch ? Number(linkedMatch[1]) : (item.sourceItemId ?? item.id ?? null)
  const lineStyle = inferLineStyleFromAnnot(raw)
  const sourcePoints = extractPointsFromRaw(raw)
  let rootPoints = []
  try {
    const itemRaw = typeof item.pointsJson === 'string' ? JSON.parse(item.pointsJson) : item.pointsJson
    const rootOccurrence = Array.isArray(itemRaw?.occurrences)
      ? (itemRaw.occurrences.find(occ => occ?.isRoot) ?? itemRaw.occurrences[0])
      : null
    rootPoints = extractPointsFromRaw(rootOccurrence?.geometry ?? itemRaw ?? {})
  } catch (_) {}
  // Copy the occurrence the user selected. Root geometry is only a fallback
  // for legacy records that do not contain occurrence-level points.
  const vectorPoints = sourcePoints.length >= 2 ? sourcePoints : rootPoints
  const sourceVector = vectorPoints.length >= 2
    ? {
        dx: vectorPoints[vectorPoints.length - 1].x - vectorPoints[0].x,
        dy: vectorPoints[vectorPoints.length - 1].y - vectorPoints[0].y,
      }
    : null
  const pixelLength = sourceVector
    ? Math.hypot(sourceVector.dx, sourceVector.dy)
    : null
  const customLinePagePoints = extractPageRatioPointsFromRaw(raw)
  const vectorStart = vectorPoints[0] ?? null
  const vectorEnd = vectorPoints[vectorPoints.length - 1] ?? null
  const vectorBounds = vectorPoints.length >= 2
    ? {
        X: Math.min(vectorStart.x, vectorEnd.x),
        Y: Math.min(vectorStart.y, vectorEnd.y),
        Width: Math.abs(vectorEnd.x - vectorStart.x),
        Height: Math.abs(vectorEnd.y - vectorStart.y),
      }
    : null
  const copyJson = JSON.parse(JSON.stringify({
    ...raw,
    annotationId: raw.AnnotName ?? raw.annotationId ?? raw.name,
    shapeAnnotationType: raw.shapeAnnotationType ?? raw.ShapeAnnotationType ?? 'Distance',
    IT: raw.IT ?? raw.it ?? 'LineDimension',
    pageNumber: raw.pageNumber ?? raw.PageNumber ?? (parseInt(raw.page ?? '0', 10) + 1),
    page: raw.page ?? String((raw.pageNumber ?? raw.PageNumber ?? 1) - 1),
    vertexPoints: vectorPoints,
    VertexPoints: vectorPoints.map(p => ({ X: p.x, Y: p.y })),
    labelPagePoints: customLinePagePoints,
    LabelPagePoints: customLinePagePoints.map(p => ({ X: p.x, Y: p.y })),
    customLinePagePoints,
    CustomLinePagePoints: customLinePagePoints.map(p => ({ X: p.x, Y: p.y })),
    customPaste: raw.customPaste ?? raw.CustomPaste,
    renderMode: raw.renderMode ?? raw.RenderMode,
    customCoordMode: raw.customCoordMode ?? raw.CustomCoordMode,
    start: vectorStart ? `${vectorStart.x},${vectorStart.y}` : (raw.start ?? raw.Start),
    Start: vectorStart ? `${vectorStart.x},${vectorStart.y}` : (raw.Start ?? raw.start),
    end: vectorEnd ? `${vectorEnd.x},${vectorEnd.y}` : (raw.end ?? raw.End),
    End: vectorEnd ? `${vectorEnd.x},${vectorEnd.y}` : (raw.End ?? raw.end),
    Bounds: vectorBounds ?? raw.Bounds ?? raw.bounds,
    bounds: vectorBounds ?? raw.bounds ?? raw.Bounds,
    strokeColor: raw.StrokeColor ?? raw.strokeColor,
    thickness,
    Calibrate: raw.Calibrate ?? raw.calibrate,
    calibrate: raw.calibrate ?? raw.Calibrate,
    lineHeadStartStyle: raw.lineHeadStartStyle ?? raw.LineHeadStart,
    lineHeadEndStyle: raw.lineHeadEndStyle ?? raw.LineHeadEnd,
    borderDashArray: lineStyle === 'solid' ? '0' : (raw.borderDashArray ?? raw.BorderDashArray),
    lineStyle,
    leaderLength: raw.leaderLength ?? raw.LeaderLength,
    leaderLineExtension: raw.leaderLineExtension ?? raw.LeaderLineExtension,
    fontSize: raw.fontSize ?? raw.FontSize,
    labelUserFontSize: labelFontSize,
    LabelUserFontSize: labelFontSize,
    labelSettings: raw.labelSettings ?? raw.LabelSettings,
  }))
  return {
    sourceItemId: item.id ?? null,
    linkedItemId,
    occurrenceId: item.occurrenceId ?? raw.OccurrenceId ?? raw.occurrenceId ?? null,
    itemType: item.itemType || 'Line',
    mark: item.mark ?? '',
    material: item.material ?? item.mark ?? '',
    color: raw.StrokeColor ?? raw.strokeColor ?? item.color ?? '#EF233C',
    opacity: raw.opacity ?? raw.Opacity ?? 1,
    category: item.category ?? 'General',
    memberType: item.memberType ?? item.category ?? '',
    memberScheduleId,
    description: item.description ?? '',
    notes,
    quantity: item.quantity ?? 1,
    unitWeight: item.unitWeight ?? null,
    totalWeight: item.totalWeight ?? null,
    thickness,
    labelFontSize,
    arrowStyle,
    linearLineMode: inferLinearLineModeFromAnnot(raw),
    lineStyle,
    length: item.length,
    unit: item.unit ?? 'Mm',
    pageNumber: copyJson.pageNumber,
    startPoint: vectorPoints[0] ?? null,
    endPoint: vectorPoints[vectorPoints.length - 1] ?? null,
    sourcePoints: vectorPoints,
    sourceVector,
    pixelLength,
    customLinePagePoints,
    labelAnchor: vectorPoints.length >= 2
      ? {
          x: (vectorPoints[0].x + vectorPoints[vectorPoints.length - 1].x) / 2,
          y: (vectorPoints[0].y + vectorPoints[vectorPoints.length - 1].y) / 2,
        }
      : null,
    copyJson,
    raw,
  }
}

function parseCoordPair(val) {
  if (typeof val === 'object' && val !== null) {
    return { x: Number(val.x ?? val.X) || 0, y: Number(val.y ?? val.Y) || 0 }
  }
  const parts = String(val).split(',')
  return { x: parseFloat(parts[0]) || 0, y: parseFloat(parts[1]) || 0 }
}

/** True when a saved line has enough geometry to copy/paste reliably. */
export function isValidLinearMeasurementForCopy(item, raw = null) {
  if (!item || (item.itemType || 'Line') !== 'Line') return false
  const savedLen = Number(item.length)
  if (Number.isFinite(savedLen) && savedLen >= 0.5) return true
  try {
    const parsed = raw ?? (item.pointsJson ? JSON.parse(item.pointsJson) : null)
    if (!parsed) return false
    const pts = extractPointsFromRaw(parsed)
    if (pts.length < 2) return false
    const dx = pts[pts.length - 1].x - pts[0].x
    const dy = pts[pts.length - 1].y - pts[0].y
    return Math.hypot(dx, dy) >= 0.5
  } catch {
    return false
  }
}

export function extractPointsFromRaw(raw) {
  const rawPts = raw.vertexPoints ?? raw.VertexPoints ?? []
  let pts = (Array.isArray(rawPts) ? rawPts : [])
    .filter(p => p && typeof p === 'object'
      && Number.isFinite(Number(p.x ?? p.X)) && Number.isFinite(Number(p.y ?? p.Y)))
    .map(p => ({ x: Number(p.x ?? p.X), y: Number(p.y ?? p.Y) }))
  if (pts.length < 2 && raw.start && raw.end) {
    pts = [parseCoordPair(raw.start), parseCoordPair(raw.end)]
  }
  return pts
}

function extractPageRatioPointsFromRaw(raw) {
  const rawPts = raw?.customLinePagePoints
    ?? raw?.CustomLinePagePoints
    ?? raw?.labelPagePoints
    ?? raw?.LabelPagePoints
    ?? []
  const pts = (Array.isArray(rawPts) ? rawPts : [])
    .filter(p => p && typeof p === 'object'
      && Number.isFinite(Number(p.x ?? p.X)) && Number.isFinite(Number(p.y ?? p.Y)))
    .map(p => ({ x: Number(p.x ?? p.X), y: Number(p.y ?? p.Y) }))
  if (pts.length >= 2) return pts

  const coordMode = String(raw?.customCoordMode ?? raw?.CustomCoordMode ?? '')
    .replace(/[-_\s]/g, '')
    .toLowerCase()
  return coordMode === 'pageratio' ? extractPointsFromRaw(raw) : []
}

/** Midpoint of a linear annotation — used for click-to-place paste offsets. */
export function getLinearAnnotationMidpoint(raw) {
  const pts = extractPointsFromRaw(raw)
  if (pts.length < 2) return null
  const a = pts[0]
  const b = pts[pts.length - 1]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Syncfusion viewer date format (M/d/yyyy h:mm:ss a) — required for saveMeasureShapeAnnotations. */
function viewerModifiedDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return viewerModifiedDate(new Date())
  const M = d.getMonth() + 1
  const day = d.getDate()
  const y = d.getFullYear()
  let h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${M}/${day}/${y} ${h}:${m}:${s} ${ampm}`
}

/** Clone a linear annotation for paste with a positional offset and new id. */
export function cloneLinearAnnotationForPaste(raw, offsetX = 30, offsetY = 30, targetPageNumber, absolutePts = null) {
  const basePts = extractPointsFromRaw(raw)
  if (basePts.length < 2) return null

  const offsetPts = Array.isArray(absolutePts) && absolutePts.length >= 2
    ? absolutePts.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }))
    : basePts.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }))
  const pageNum = targetPageNumber ?? raw.pageNumber ?? raw.PageNumber ?? (parseInt(raw.page ?? '0', 10) + 1)
  const pageIdx = pageNum - 1
  const newId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `paste-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

  const boundsFromPts = {
    X: Math.min(offsetPts[0].x, offsetPts[offsetPts.length - 1].x),
    Y: Math.min(offsetPts[0].y, offsetPts[offsetPts.length - 1].y),
    Width: Math.max(Math.abs(offsetPts[offsetPts.length - 1].x - offsetPts[0].x), 1),
    Height: Math.max(Math.abs(offsetPts[offsetPts.length - 1].y - offsetPts[0].y), 1),
  }

  const startStr = `${offsetPts[0].x},${offsetPts[0].y}`
  const endStr = `${offsetPts[offsetPts.length - 1].x},${offsetPts[offsetPts.length - 1].y}`

  return {
    ...raw,
    annotationId: newId,
    AnnotName: newId,
    name: newId,
    uniqueKey: newId,
    pageNumber: pageNum,
    PageNumber: pageNum,
    page: String(pageIdx),
    pageIndex: pageIdx,
    ShapeAnnotationType: raw.ShapeAnnotationType ?? raw.shapeAnnotationType ?? 'Distance',
    shapeAnnotationType: raw.shapeAnnotationType ?? raw.ShapeAnnotationType ?? 'Distance',
    AnnotType: raw.AnnotType ?? 'shape_measure',
    IT: raw.IT ?? 'LineDimension',
    Bounds: boundsFromPts,
    bounds: boundsFromPts,
    VertexPoints: offsetPts.map(p => ({ X: p.x, Y: p.y })),
    vertexPoints: offsetPts.map(p => ({ x: p.x, y: p.y })),
    start: startStr,
    end: endStr,
    Start: startStr,
    End: endStr,
    enableShapeLabel: false,
    labelContent: '',
    LabelContent: '',
    Note: '',
    note: '',
    label: '',
    text: '',
    State: '',
    StateModel: '',
    Comments: [],
    Author: 'BuildTakeoff',
    Subject: 'Distance calculation',
    measurementValue: raw.measurementValue ?? raw.MeasurementValue ?? null,
    IsPrint: true,
    ModifiedDate: viewerModifiedDate(),
    CreationDate: viewerModifiedDate(),
  }
}

/** Map toolbar arrow style → Syncfusion distance line-head styles. */
export function mapLinearArrowStyle(arrowStyle = 'none') {
  switch (arrowStyle) {
    case 'start':
      return { lineHeadStartStyle: 'ClosedArrow', lineHeadEndStyle: 'None' }
    case 'end':
      return { lineHeadStartStyle: 'None', lineHeadEndStyle: 'ClosedArrow' }
    case 'both':
      return { lineHeadStartStyle: 'ClosedArrow', lineHeadEndStyle: 'ClosedArrow' }
    default:
      return { lineHeadStartStyle: 'None', lineHeadEndStyle: 'None' }
  }
}

export function buildMeasureLabelPatch(userPt, pdfScale, fontColor = '#111827') {
  const sfSize = toSyncfusionLabelSize(userPt, pdfScale)
  const haloFill = 'rgba(255,255,255,0.94)'
  const haloBorder = hexToRgba(fontColor, 0.45)
  return {
    fontSize: sfSize,
    fontColor,
    labelFillColor: haloFill,
    labelBorderColor: haloBorder,
    labelSettings: {
      fontSize: sfSize,
      fontColor,
      fillColor: haloFill,
      borderColor: haloBorder,
    },
  }
}

/**
 * Unified Bluebeam-style linear measure appearance: label text, line weight,
 * and arrow heads scale together from Label Size (S/M/L/XL).
 * Simple lines use no end-cap leaders; labels sit above the line via labelGap.
 */
export function buildLinearDistanceStyle(
  userPt, pdfScale, fontColor = '#111827', thicknessOverride, arrowStyle = 'none', linearLineMode = 'simple',
) {
  const preset = LINE_LABEL_VISUAL_SCALE[userPt] ?? LINE_LABEL_VISUAL_SCALE[DEFAULT_MEASURE_LABEL_SIZE]
  const thickness = resolveLinearThickness(userPt, thicknessOverride)
  const effectiveArrow = resolveLinearArrowStyle(arrowStyle, linearLineMode)
  const labelGap = computeLinearLabelGap(userPt, pdfScale)
  // Bluebeam-style plain line — no perpendicular witness/leader ticks at the
  // endpoints. A non-zero leader height here is what renders as a small
  // stray line at the start/end of the draw (looks like a box with the
  // endpoint resize handles). Both "simple" and "arrow" line modes are a
  // single straight line, so this is always 0.
  const syncLeaderHeight = 0
  return {
    thickness,
    leaderLength: syncLeaderHeight,
    syncLeaderHeight,
    leaderLineExtension: preset.leaderLineExtension,
    labelGap,
    ...mapLinearArrowStyle(effectiveArrow),
    ...buildMeasureLabelPatch(userPt, pdfScale, fontColor),
  }
}

/** Style fields applied to live Syncfusion diagram text (label halo + size). */
export function buildLinearLabelDiagramStyle(userPt, pdfScale, fontColor = '#111827') {
  const patch = buildMeasureLabelPatch(userPt, pdfScale, fontColor)
  return {
    fontSize: patch.fontSize,
    fontColor: patch.fontColor,
    labelFillColor: patch.labelFillColor,
    labelBorderColor: patch.labelBorderColor,
    labelGap: computeLinearLabelGap(userPt, pdfScale),
    // No perpendicular leader/witness ticks — plain Bluebeam-style line.
    syncLeaderHeight: 0,
    leaderLength: 0,
  }
}
