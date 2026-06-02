export function pixelsToReal(pixels, scaleRatio, unit) {
  const mm = pixels * scaleRatio
  return convertFromMm(mm, unit)
}

export function convertFromMm(mm, unit) {
  switch (unit) {
    case 'Mm':    return mm
    case 'Cm':    return mm / 10
    case 'Meter': return mm / 1000
    case 'Feet':  return mm / 304.8
    case 'Inch':  return mm / 25.4
    default:      return mm
  }
}

export function getUnitLabel(unit) {
  const map = { Mm: 'mm', Cm: 'cm', Meter: 'm', Feet: 'ft', Inch: 'in' }
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
    default:      return value
  }
}

// Compute scaleRatio (mm per pixel) from a known real-world length and pixel length
export function computeScaleRatio(realValue, realUnit, pixelLength) {
  if (!pixelLength || pixelLength === 0) return null
  const realMm = toMm(realValue, realUnit)
  return realMm / pixelLength
}
