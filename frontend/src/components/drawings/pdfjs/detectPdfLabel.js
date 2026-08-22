// Auto-detects a member mark for a freshly drawn measurement by finding the
// nearest text token on the PDF page itself, for when the user draws without
// first picking a mark from the Member Schedule panel.

import { isPlausibleDrawingMark } from '../../../utils/drawingMarkDetect'

const MAX_LABEL_LENGTH = 32
const MARK_TOKEN_RE = /\b[A-Z]{1,4}\d{1,3}[A-Z]?\b/gi

// CAD-exported PDFs commonly place every glyph as its own text-showing
// operation (e.g. "PF1" arrives from pdf.js as three separate items: "P",
// "F", "1"), so raw getTextContent() output is unusable for matching without
// first re-joining same-run characters back into words. Adjacent items are
// merged when the gap between them is small relative to their own glyph
// size; a run breaks on whitespace or a jump too large to be the same word.
export function mergePdfTextItems(rawItems) {
  const merged = []
  let run = null
  for (const raw of rawItems) {
    const str = raw?.str
    if (typeof str !== 'string' || !str.trim()) { run = null; continue }
    const gapAllow = Math.max(4, raw.charWidth * 1.6)
    if (run && Math.hypot(raw.x - run.lastX, raw.y - run.lastY) <= gapAllow) {
      run.str += str
      run.lastX = raw.x
      run.lastY = raw.y
      run.charWidth = raw.charWidth
    } else {
      run = { str, x: raw.x, y: raw.y, lastX: raw.x, lastY: raw.y, charWidth: raw.charWidth }
      merged.push(run)
    }
  }
  return merged
    .map(({ str, x, y }) => ({ str: str.trim(), x, y }))
    .filter(item => /[A-Za-z0-9]/.test(item.str))
}

export function nearestPdfLabel(textItems, point) {
  if (!Array.isArray(textItems) || !textItems.length || !point) return null
  let best = null
  let bestDist = Infinity
  for (const item of textItems) {
    if (!item?.str || item.str.length > MAX_LABEL_LENGTH) continue
    const dist = Math.hypot(item.x - point.x, item.y - point.y)
    const candidates = String(item.str).toUpperCase().match(MARK_TOKEN_RE) ?? []
    for (const candidate of candidates) {
      if (!isPlausibleDrawingMark(candidate)) continue
      if (dist < bestDist) {
        bestDist = dist
        best = candidate
      }
    }
  }
  return best
}

export function attachDetectedLabel(measurement, textItems) {
  // A manual schedule selection is authoritative. The overlay captures this
  // flag with the measurement so auto-detect cannot overwrite it later.
  if (measurement?.manualMemberSelected) return measurement
  if (measurement?.memberMark || measurement?.drawingMark) return measurement
  const points = measurement?.rawAnnotation?.vertexPoints ?? measurement?.rawAnnotation?.VertexPoints
  if (!Array.isArray(points) || points.length === 0) return measurement
  const mid = points.reduce(
    (acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }),
    { x: 0, y: 0 },
  )
  const label = nearestPdfLabel(textItems, mid)
  if (!label) return measurement
  return { ...measurement, drawingMark: label }
}
