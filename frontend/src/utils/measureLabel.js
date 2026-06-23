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
  const labelFontSize = inferLabelSizeFromSfFontSize(sfFont, pdfScale)
  const arrowStyle = inferArrowStyleFromAnnot(raw)
  return {
    itemType: item.itemType || 'Line',
    color: item.color ?? raw.StrokeColor ?? raw.strokeColor ?? '#EF233C',
    category: item.category ?? 'General',
    thickness,
    labelFontSize,
    arrowStyle,
    linearLineMode: inferLinearLineModeFromAnnot(raw),
    lineStyle: raw.lineStyle ?? (raw.borderDashArray ? 'dashed' : 'solid'),
    length: item.length,
    unit: item.unit ?? 'Mm',
    pageNumber: raw.pageNumber ?? raw.PageNumber ?? (parseInt(raw.page ?? '0', 10) + 1),
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

/** Midpoint of a linear annotation — used for click-to-place paste offsets. */
export function getLinearAnnotationMidpoint(raw) {
  const pts = extractPointsFromRaw(raw)
  if (pts.length < 2) return null
  const a = pts[0]
  const b = pts[pts.length - 1]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Clone a linear annotation for paste with a positional offset and new id. */
export function cloneLinearAnnotationForPaste(raw, offsetX = 30, offsetY = 30, targetPageNumber) {
  const pts = extractPointsFromRaw(raw)
  if (pts.length < 2) return null

  const offsetPts = pts.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }))
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
    measurementValue: raw.measurementValue ?? raw.MeasurementValue ?? null,
    IsPrint: true,
    State: '',
    Comments: [],
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
  const syncLeaderHeight = preset.syncLeaderHeight ?? 8
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
  const preset = LINE_LABEL_VISUAL_SCALE[userPt] ?? LINE_LABEL_VISUAL_SCALE[DEFAULT_MEASURE_LABEL_SIZE]
  return {
    fontSize: patch.fontSize,
    fontColor: patch.fontColor,
    labelFillColor: patch.labelFillColor,
    labelBorderColor: patch.labelBorderColor,
    labelGap: computeLinearLabelGap(userPt, pdfScale),
    syncLeaderHeight: preset.syncLeaderHeight ?? 8,
    leaderLength: preset.syncLeaderHeight ?? 8,
  }
}
