// Auto-detects a member mark for a freshly drawn measurement by finding the
// nearest text token on the PDF page itself, for when the user draws without
// first picking a mark from the Member Schedule panel.

import { isPlausibleDrawingMark } from '../../../utils/drawingMarkDetect.js'

const MAX_LABEL_LENGTH = 32
const MARK_TOKEN_RE = /\b[A-Z]{1,4}\d{1,3}[A-Z]?\b/gi
const STRUCTURAL_SECTION_TOKEN_RE = /\b(?:\d+(?:\.\d+)?\s*[X×]\s*\d+(?:\.\d+)?(?:\s*[X×]\s*\d+(?:\.\d+)?)?\s*(?:CHS|SHS|RHS|PFC|TFC|UB|UC|WB|WC|EA|UA)|\d+(?:\.\d+)?\s*(?:UB|UC|WB|WC|PFC|TFC|CHS|SHS|RHS|EA|UA)\s*\d+(?:\.\d+)?)\b/gi

function normalizeStructuralSection(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/×/g, 'x')
    .replace(/(\d)X(?=\d)/gi, '$1x')
    .toUpperCase()
    .replace(/(\d)X(?=\d)/g, '$1x')
}

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
      run = {
        str,
        firstX: raw.x,
        firstY: raw.y,
        lastX: raw.x,
        lastY: raw.y,
        charWidth: raw.charWidth,
      }
      merged.push(run)
    }
  }
  return merged
    // Use the centre of the complete text run, rather than the first glyph's
    // origin. This is especially important for vertical/rotated CAD labels:
    // pdf.js reports their origin at one end of the word, which can be a long
    // way from the measured line's midpoint even though the word overlaps it.
    .map(({ str, firstX, firstY, lastX, lastY }) => ({
      str: str.trim(),
      x: (firstX + lastX) / 2,
      y: (firstY + lastY) / 2,
    }))
    .filter(item => /[A-Za-z0-9]/.test(item.str))
}

function distanceToMeasurement(item, points) {
  if (points.length === 1) return Math.hypot(item.x - points[0].x, item.y - points[0].y)
  let nearest = Infinity
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    const ratio = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((item.x - start.x) * dx + (item.y - start.y) * dy) / lengthSquared))
      : 0
    nearest = Math.min(nearest, Math.hypot(
      item.x - (start.x + dx * ratio),
      item.y - (start.y + dy * ratio),
    ))
  }
  return nearest
}

export function nearestPdfLabel(textItems, target) {
  if (!Array.isArray(textItems) || !textItems.length || !target) return null
  const points = (Array.isArray(target) ? target : [target]).filter(point => (
    Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))
  ))
  if (!points.length) return null
  let best = null
  let bestDist = Infinity
  for (const item of textItems) {
    if (!item?.str || item.str.length > MAX_LABEL_LENGTH) continue
    const dist = distanceToMeasurement(item, points)
    const text = String(item.str).toUpperCase()
    const structuralSections = text.match(STRUCTURAL_SECTION_TOKEN_RE) ?? []
    // An exact section printed along the measured member is a complete label,
    // not a source of partial mark tokens (for example X3 from 114.3x3.6CHS).
    // Keep it intact and only use the mark-token fallback when no section is
    // present in that PDF text item.
    const candidates = structuralSections.length
      ? structuralSections.map(normalizeStructuralSection)
      : (text.match(MARK_TOKEN_RE) ?? []).filter(isPlausibleDrawingMark)
    for (const candidate of candidates) {
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
  // Search against the complete measured segment. A label can legitimately
  // sit anywhere along a long horizontal or vertical member, so midpoint-only
  // matching leaves otherwise valid labels blank.
  const label = nearestPdfLabel(textItems, points)
  if (!label) return measurement
  return { ...measurement, drawingMark: label }
}
