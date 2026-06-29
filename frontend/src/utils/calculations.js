export function convertFromMm(mm, unit) {
  switch (unit) {
    case 'Mm':    return mm
    case 'Cm':    return mm / 10
    case 'Meter': return mm / 1000
    case 'Feet':  return mm / 304.8
    case 'Inch':  return mm / 25.4
    case 'Yd':    return mm / 914.4
    default:      return mm
  }
}

export function getUnitLabel(unit) {
  const map = { Mm: 'mm', Cm: 'cm', Meter: 'm', Feet: 'ft', Inch: 'in', Yd: 'yd' }
  return map[unit] ?? 'mm'
}

export function ptDist(p1, p2) {
  return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2)
}

export function polylineLength(pts) {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += ptDist(pts[i - 1], pts[i])
  return total
}

export function polygonArea(pts) {
  if (pts.length < 3) return 0
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(area) / 2
}

export function fmt(v, d = 2) {
  return typeof v === 'number' ? v.toFixed(d) : '--'
}

/** Same formatting for PDF line labels and grid length column */
export function formatMeasureLength(value, unit, decimals = 2) {
  if (value == null || Number.isNaN(value)) return ''
  return `${value.toFixed(decimals)} ${getUnitLabel(unit)}`
}

export function formatMeasureArea(value, unit, decimals = 2) {
  if (value == null || Number.isNaN(value)) return ''
  return `${value.toFixed(decimals)} ${getAreaUnitLabel(unit)}`
}

const LABEL_UNIT_MAP = {
  mm: 'Mm', cm: 'Cm', m: 'Meter', ft: 'Feet', in: 'Inch', yd: 'Yd',
}

/** Parse Syncfusion label text like "5.28 in" or "13.41 cm" */
export function parseMeasureLabel(text) {
  if (!text) return null
  const m = String(text).trim().match(/([\d.]+)\s*(mm²|cm²|m²|ft²|in²|yd²|mm|cm|m|ft|in|yd)?/i)
  if (!m) return null
  const value = parseFloat(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const token = (m[2] || '').toLowerCase().replace(/²/g, '')
  return {
    value,
    unit: LABEL_UNIT_MAP[token] ?? null,
    isArea: /²/.test(m[2] || ''),
  }
}

/** Convert a Syncfusion measurement value from one unit to another */
export function convertMeasureValue(value, fromUnit, toUnit) {
  if (value == null || !fromUnit || !toUnit) return value
  return convertFromMm(toMm(value, fromUnit), toUnit)
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function toMeters(value, unit) {
  switch (unit) {
    case 'Mm':    return value / 1000
    case 'Cm':    return value / 100
    case 'Meter': return value
    case 'Feet':  return value * 0.3048
    case 'Inch':  return value * 0.0254
    case 'Yd':    return value * 0.9144
    default:      return value / 1000
  }
}

// Convert any unit value → millimetres (for scaleRatio computation)
export function toMm(value, unit) {
  switch (unit) {
    case 'Mm':    return value
    case 'Cm':    return value * 10
    case 'Meter': return value * 1000
    case 'Feet':  return value * 304.8
    case 'Inch':  return value * 25.4
    case 'Yd':    return value * 914.4
    default:      return value
  }
}

// Convert pixel length → real-world length using scaleRatio (mm per pixel)
export function pixelsToReal(pixelLength, scaleRatio, unit) {
  const mmLength = pixelLength * scaleRatio
  return convertFromMm(mmLength, unit)
}

// Compute scaleRatio (mm per pixel) from a known real-world length and pixel length
export function computeScaleRatio(realValue, realUnit, pixelLength) {
  if (!pixelLength || pixelLength === 0) return null
  const realMm = toMm(realValue, realUnit)
  return realMm / pixelLength
}

// ── Area utilities ──────────────────────────────────────────────────────

// Convert pixel² area to real-world area unit
// scaleRatio is mm per pixel → mm² per pixel² = scaleRatio²
export function pixelsAreaToReal(pixelArea, scaleRatio, unit) {
  const mmSq = pixelArea * scaleRatio * scaleRatio
  switch (unit) {
    case 'Mm':    return mmSq
    case 'Cm':    return mmSq / 100
    case 'Meter': return mmSq / 1_000_000
    case 'Feet':  return mmSq / (304.8 * 304.8)
    case 'Inch':  return mmSq / (25.4 * 25.4)
    case 'Yd':    return mmSq / (914.4 * 914.4)
    default:      return mmSq
  }
}

export function getAreaUnitLabel(unit) {
  const map = { Mm: 'mm²', Cm: 'cm²', Meter: 'm²', Feet: 'ft²', Inch: 'in²', Yd: 'yd²' }
  return map[unit] ?? 'mm²'
}

// Compute pixel area from vertex points using Shoelace formula
export function computePixelArea(vertexPoints) {
  if (!vertexPoints || vertexPoints.length < 3) return 0
  return polygonArea(vertexPoints)
}

// Compute polygon perimeter (pixel length) from closed vertex list
export function computePixelPerimeter(pts) {
  if (!pts || pts.length < 2) return 0
  const open = polylineLength(pts)
  const close = ptDist(pts[pts.length - 1], pts[0])
  return open + close
}

// Category → default color mapping for auto-color assignment
// Bluebeam-style tool-chest colors (structural steel takeoff)
export const CATEGORY_COLORS = {
  General:    '#EF233C',  // Red
  Beam:       '#3B82F6',  // Blue
  Column:     '#22C55E',  // Green
  Rafter:     '#F97316',  // Orange
  Brace:      '#8B5CF6',  // Purple
  Structural: '#EF4444',
  Concrete:   '#f97316',
  Roofing:    '#eab308',
  Electrical: '#3b82f6',
  Plumbing:   '#06b6d4',
  HVAC:       '#8b5cf6',
  Flooring:   '#22c55e',
  Painting:   '#ec4899',
  Demolition: '#dc2626',
  Purlin:     '#22c55e',
  Wall:       '#64748b',
  Slab:       '#06b6d4',
  Girt:       '#a78bfa',
  Other:      '#94a3b8',
}
