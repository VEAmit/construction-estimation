function parseJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function point(value) {
  if (!value || typeof value !== 'object') return null
  const x = Number(value.x ?? value.X)
  const y = Number(value.y ?? value.Y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function pointList(value) {
  return Array.isArray(value) ? value.map(point).filter(Boolean) : []
}

function pair(value) {
  if (typeof value !== 'string') return null
  const [x, y] = value.split(',').map(Number)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

export function annotationId(raw, fallback = '') {
  return String(raw?.annotationId ?? raw?.AnnotName ?? raw?.name ?? raw?.AnnotationName ?? fallback)
}

export function annotationPoints(raw, pageSize) {
  const ratioPoints = pointList(
    raw?.customLinePagePoints ?? raw?.CustomLinePagePoints
      ?? raw?.labelPagePoints ?? raw?.LabelPagePoints,
  )
  if (ratioPoints.length >= 2
      && ratioPoints.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
      && pageSize?.width && pageSize?.height) {
    return ratioPoints.map(p => ({ x: p.x * pageSize.width, y: p.y * pageSize.height }))
  }

  const vertices = pointList(raw?.vertexPoints ?? raw?.VertexPoints ?? raw?.points ?? raw?.Points)
  if (vertices.length >= 1) return vertices
  const start = pair(raw?.start ?? raw?.Start)
  const end = pair(raw?.end ?? raw?.End)
  return start && end ? [start, end] : []
}

function occurrenceGeometries(item, root) {
  if (!Array.isArray(root?.occurrences) || root.occurrences.length === 0) return [root]
  return root.occurrences
    .map(occurrence => occurrence?.geometry ?? occurrence?.rawAnnotation ?? occurrence)
    .filter(Boolean)
}

export function normalizeAnnotations(items, pageMetrics) {
  const result = []
  for (const item of items ?? []) {
    const root = parseJson(item?.pointsJson)
    if (!root) continue
    const geometries = occurrenceGeometries(item, root)
    geometries.forEach((raw, occurrenceIndex) => {
      const pageNumber = Math.max(1, number(
        raw.pageNumber ?? raw.PageNumber ?? (number(raw.page, 0) + 1),
        1,
      ))
      const points = annotationPoints(raw, pageMetrics?.[pageNumber])
      if (!points.length) return
      const id = annotationId(raw, `${item.id}:${occurrenceIndex}`)
      const typeText = String(raw.IT ?? raw.it ?? raw.shapeAnnotationType ?? raw.ShapeAnnotationType ?? item.itemType ?? 'Line').toLowerCase()
      const type = typeText.includes('area') || typeText.includes('polygon') ? 'area'
        : typeText.includes('perimeter') || typeText.includes('polyline') ? 'perimeter'
          : typeText.includes('count') ? 'count' : 'line'
      result.push({
        id,
        dbId: item.id,
        item,
        raw,
        occurrenceIndex,
        pageNumber,
        points,
        type,
        mark: String(item.mark ?? raw.Mark ?? raw.mark ?? ''),
        value: number(item.length ?? raw.measurementValue ?? raw.MeasurementValue, 0),
        unit: String(item.unit ?? raw.unit ?? 'mm').toLowerCase(),
        color: item.color ?? raw.strokeColor ?? raw.StrokeColor ?? '#EF233C',
        thickness: Math.max(0.5, number(raw.thickness ?? raw.Thickness, 2)),
        opacity: Math.min(1, Math.max(0.05, number(raw.opacity ?? raw.Opacity, 1))),
        lineStyle: raw.lineStyle ?? raw.LineStyle ?? 'solid',
        // Older Syncfusion records stored zoom-compensated renderer font sizes.
        // Prefer the viewer-neutral size and cap legacy values to a sane PDF size.
        labelFontSize: Math.min(18, Math.max(8, number(
          raw.labelUserFontSize ?? raw.LabelUserFontSize ?? raw.fontSize ?? raw.FontSize,
          12,
        ))),
      })
    })
  }
  return result
}

function bounds(points) {
  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  return {
    X: Math.min(...xs),
    Y: Math.min(...ys),
    Width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
    Height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
  }
}

export function createRawLine({ id, pageNumber, points, style = {}, sourceRaw = null }) {
  const [start, end] = points
  const pagePoints = style.pageSize?.width && style.pageSize?.height
    ? points.map(p => ({ x: p.x / style.pageSize.width, y: p.y / style.pageSize.height }))
    : []
  return {
    ...(sourceRaw ? structuredClone(sourceRaw) : {}),
    annotationId: id,
    AnnotName: id,
    name: id,
    type: 'Line',
    IT: 'LineDimension',
    shapeAnnotationType: 'Distance',
    pageNumber,
    PageNumber: pageNumber,
    page: String(pageNumber - 1),
    vertexPoints: points.map(p => ({ x: p.x, y: p.y })),
    VertexPoints: points.map(p => ({ X: p.x, Y: p.y })),
    start: `${start.x},${start.y}`,
    end: `${end.x},${end.y}`,
    Bounds: bounds(points),
    bounds: bounds(points),
    labelPagePoints: pagePoints,
    LabelPagePoints: pagePoints.map(p => ({ X: p.x, Y: p.y })),
    customLinePagePoints: pagePoints,
    CustomLinePagePoints: pagePoints.map(p => ({ X: p.x, Y: p.y })),
    customCoordMode: 'page-ratio',
    CustomCoordMode: 'page-ratio',
    strokeColor: style.color ?? sourceRaw?.strokeColor ?? sourceRaw?.StrokeColor ?? '#EF233C',
    StrokeColor: style.color ?? sourceRaw?.StrokeColor ?? sourceRaw?.strokeColor ?? '#EF233C',
    thickness: style.thickness ?? sourceRaw?.thickness ?? sourceRaw?.Thickness ?? 2,
    Thickness: style.thickness ?? sourceRaw?.Thickness ?? sourceRaw?.thickness ?? 2,
    opacity: style.opacity ?? sourceRaw?.opacity ?? sourceRaw?.Opacity ?? 1,
    Opacity: style.opacity ?? sourceRaw?.Opacity ?? sourceRaw?.opacity ?? 1,
    lineStyle: style.lineStyle ?? sourceRaw?.lineStyle ?? 'solid',
    labelUserFontSize: style.labelFontSize ?? sourceRaw?.labelUserFontSize ?? 12,
  }
}

export function translateRawLine(raw, targetCenter, pageNumber, pageSize) {
  const points = annotationPoints(raw, pageSize)
  if (points.length < 2) return null
  const start = points[0]
  const end = points[points.length - 1]
  const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const dx = targetCenter.x - center.x
  const dy = targetCenter.y - center.y
  const translated = points.map(p => ({ x: p.x + dx, y: p.y + dy }))
  const id = crypto.randomUUID()
  return createRawLine({ id, pageNumber, points: translated, sourceRaw: raw, style: { pageSize } })
}
