function normalizeMark(value) {
  return String(value ?? '').trim().toUpperCase()
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 0.0001) return Math.hypot(point.x - start.x, point.y - start.y)
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

function lineProjection(point, start, end) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 0.0001) return 0
  return ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
}

function parallelAngleDifference(first, second) {
  let difference = Math.abs(first - second) % Math.PI
  if (difference > Math.PI / 2) difference = Math.PI - difference
  return difference
}

function spanAngle(span) {
  const transform = window.getComputedStyle(span).transform
  if (!transform || transform === 'none') return 0
  const match = transform.match(/^matrix\(([^)]+)\)$/)
  if (!match) return 0
  const values = match[1].split(',').map(Number)
  return values.length >= 2 && values.every(Number.isFinite)
    ? Math.atan2(values[1], values[0])
    : 0
}

function markTokens(text) {
  return normalizeMark(text).split(/[^A-Z0-9.*-]+/).filter(Boolean)
}

function looksLikeStructuralMark(token) {
  // Structural marks always contain letters and a number (C1, SF3, CJ2,
  // C1X, etc.). This excludes dimensions, dates, grid numbers and note text.
  return token.length <= 12
    && /[A-Z]/.test(token)
    && /\d/.test(token)
    && /^[A-Z][A-Z0-9.*-]*$/.test(token)
}

/**
 * Match a line to selectable PDF text already positioned by PDF.js. DOM-space
 * matching deliberately avoids assumptions about PDF rotation and CropBox.
 */
export function detectScheduleMemberFromTextLayer(svg, points, pageSize, scheduleItems) {
  if (!svg || points.length < 2) return null
  const page = svg.closest('.pdfjs-page-shell')
  const spans = page?.querySelectorAll('.pdfjs-text-layer span')
  if (!spans?.length) return null

  const scheduleByMark = new Map()
  ;(scheduleItems ?? []).forEach((item) => {
    const mark = normalizeMark(item?.mark ?? item?.Mark)
    if (mark) scheduleByMark.set(mark, item)
  })

  const svgRect = svg.getBoundingClientRect()
  if (svgRect.width <= 0 || svgRect.height <= 0) return null
  const start = points[0]
  const end = points[points.length - 1]
  const lineLength = Math.hypot(end.x - start.x, end.y - start.y)
  const lineAngle = Math.atan2(end.y - start.y, end.x - start.x)
  // A page-relative radius becomes very large on architectural sheets and can
  // select an unrelated callout. Keep the search local to the measured line.
  const threshold = Math.max(14, Math.min(40, lineLength * 0.3))
  let best = null

  spans.forEach((span) => {
    const tokens = markTokens(span.textContent)
    // Prefer schedule data whenever it exists. A drawing without an extracted
    // schedule can still identify a nearby real mark from selectable PDF text.
    const mark = scheduleByMark.size
      ? tokens.find(token => scheduleByMark.has(token))
      : tokens.find(looksLikeStructuralMark)
    if (!mark) return
    const rect = span.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const point = {
      x: ((rect.left + rect.width / 2 - svgRect.left) / svgRect.width) * pageSize.width,
      y: ((rect.top + rect.height / 2 - svgRect.top) / svgRect.height) * pageSize.height,
    }
    const distance = distanceToSegment(point, start, end)
    if (distance > threshold) return

    const projection = lineProjection(point, start, end)
    const outsideDistance = projection < 0
      ? -projection * lineLength
      : projection > 1
        ? (projection - 1) * lineLength
        : 0
    const angleDifference = parallelAngleDifference(spanAngle(span), lineAngle)
    const alignmentPenalty = (angleDifference / (Math.PI / 2)) * threshold * 0.8
    const outsidePenalty = outsideDistance * 0.75
    const score = distance + alignmentPenalty + outsidePenalty

    if (!best || score < best.score) {
      best = { score, item: scheduleByMark.get(mark) ?? { mark } }
    }
  })

  return best?.item ?? null
}
