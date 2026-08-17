import { OPS } from 'pdfjs-dist'

// Values used inside the compact constructPath buffer produced by PDF.js.
// They are stable PDF.js drawing op codes (move, straight line, bezier,
// quadratic, close); keeping them local avoids depending on an internal API.
const DRAW_MOVE_TO = 0
const DRAW_LINE_TO = 1
const DRAW_CURVE_TO = 2
const DRAW_QUADRATIC_TO = 3
const DRAW_CLOSE_PATH = 4

const STROKED_PATH_OPERATIONS = new Set([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
])

const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0]
// PDFs often split one visually continuous straight line into several path
// segments. Endpoints within this distance and on the same straight axis are
// treated as an internal join, not as a user-facing snap target.
const CONTINUATION_POINT_TOLERANCE = 0.75
const CONTINUATION_DIRECTION_COSINE = Math.cos((2 * Math.PI) / 180)
const SEGMENT_GRID_CELL_SIZE = 12

function multiply(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function transformedPoint(x, y, matrix, viewport) {
  const pdfX = x * matrix[0] + y * matrix[2] + matrix[4]
  const pdfY = x * matrix[1] + y * matrix[3] + matrix[5]
  const [viewportX, viewportY] = viewport.convertToViewportPoint(pdfX, pdfY)
  return Number.isFinite(viewportX) && Number.isFinite(viewportY)
    ? { x: viewportX, y: viewportY }
    : null
}

function appendUnique(result, seen, point) {
  if (!point) return
  // A quarter of a PDF point is far below the snap acquisition radius, but
  // removes the many repeated vertices emitted by joined schedule/drawing
  // strokes before they reach pointer-move hit testing.
  const key = `${Math.round(point.x * 4)}:${Math.round(point.y * 4)}`
  if (seen.has(key)) return
  seen.add(key)
  result.push(point)
}

function readPathBuffer(args) {
  const data = args?.[1]
  if (ArrayBuffer.isView(data)) return data
  if (Array.isArray(data) && ArrayBuffer.isView(data[0])) return data[0]
  if (Array.isArray(data) && Array.isArray(data[0])) return data[0]
  return null
}

function appendSegment(segments, start, end) {
  if (!start || !end) return
  const dx = end.x - start.x
  const dy = end.y - start.y
  if ((dx * dx) + (dy * dy) < 0.0001) return
  segments.push({ start, end })
}

function collectStraightPathSegments(buffer, matrix, viewport, segments) {
  let index = 0
  let current = null
  let subpathStart = null

  while (index < buffer.length) {
    const operation = buffer[index++]
    if (operation === DRAW_MOVE_TO) {
      if (index + 1 >= buffer.length) break
      current = transformedPoint(Number(buffer[index++]), Number(buffer[index++]), matrix, viewport)
      subpathStart = current
    } else if (operation === DRAW_LINE_TO) {
      if (index + 1 >= buffer.length) break
      const next = transformedPoint(Number(buffer[index++]), Number(buffer[index++]), matrix, viewport)
      appendSegment(segments, current, next)
      current = next
    } else if (operation === DRAW_CURVE_TO) {
      if (index + 5 >= buffer.length) break
      index += 4
      current = transformedPoint(Number(buffer[index++]), Number(buffer[index++]), matrix, viewport)
    } else if (operation === DRAW_QUADRATIC_TO) {
      if (index + 3 >= buffer.length) break
      index += 2
      current = transformedPoint(Number(buffer[index++]), Number(buffer[index++]), matrix, viewport)
    } else if (operation === DRAW_CLOSE_PATH) {
      appendSegment(segments, current, subpathStart)
      current = subpathStart
    } else {
      // A malformed/unknown buffer cannot be safely advanced because drawing
      // operations have different arities. Ignore its remaining content.
      break
    }
  }
}

function directionFrom(point, other) {
  const dx = other.x - point.x
  const dy = other.y - point.y
  const length = Math.hypot(dx, dy)
  return length > 0.0001 ? { x: dx / length, y: dy / length } : null
}

function endpointCellKey(point, cellSize = CONTINUATION_POINT_TOLERANCE) {
  return `${Math.floor(point.x / cellSize)}:${Math.floor(point.y / cellSize)}`
}

function buildEndpointGrid(entries) {
  const cells = new Map()
  for (const entry of entries) {
    const key = endpointCellKey(entry.point)
    const cell = cells.get(key)
    if (cell) cell.push(entry)
    else cells.set(key, [entry])
  }
  return cells
}

function buildSegmentGrid(segments) {
  const cells = new Map()
  segments.forEach((segment, segmentIndex) => {
    const dx = segment.end.x - segment.start.x
    const dy = segment.end.y - segment.start.y
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / SEGMENT_GRID_CELL_SIZE))
    const visited = new Set()
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps
      const cellX = Math.floor((segment.start.x + (dx * ratio)) / SEGMENT_GRID_CELL_SIZE)
      const cellY = Math.floor((segment.start.y + (dy * ratio)) / SEGMENT_GRID_CELL_SIZE)
      const key = `${cellX}:${cellY}`
      if (visited.has(key)) continue
      visited.add(key)
      const cell = cells.get(key)
      const entry = { ...segment, segmentIndex }
      if (cell) cell.push(entry)
      else cells.set(key, [entry])
    }
  })
  return cells
}

function nearbyEndpointEntries(point, cells) {
  const cellSize = CONTINUATION_POINT_TOLERANCE
  const cellX = Math.floor(point.x / cellSize)
  const cellY = Math.floor(point.y / cellSize)
  const nearby = []
  for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const cell = cells.get(`${cellX + offsetX}:${cellY + offsetY}`)
      if (cell) nearby.push(...cell)
    }
  }
  return nearby
}

function nearbySegments(point, cells) {
  const cellX = Math.floor(point.x / SEGMENT_GRID_CELL_SIZE)
  const cellY = Math.floor(point.y / SEGMENT_GRID_CELL_SIZE)
  const nearby = []
  for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const cell = cells.get(`${cellX + offsetX}:${cellY + offsetY}`)
      if (cell) nearby.push(...cell)
    }
  }
  return nearby
}

function liesInsideCollinearSegment(entry, segmentCells) {
  const ownDirection = directionFrom(entry.point, entry.other)
  if (!ownDirection) return false

  return nearbySegments(entry.point, segmentCells).some(segment => {
    if (segment.segmentIndex === entry.segmentIndex) return false
    const segmentDx = segment.end.x - segment.start.x
    const segmentDy = segment.end.y - segment.start.y
    const lengthSquared = (segmentDx * segmentDx) + (segmentDy * segmentDy)
    const length = Math.sqrt(lengthSquared)
    if (length < 0.0001) return false

    const segmentDirectionX = segmentDx / length
    const segmentDirectionY = segmentDy / length
    const directionDot = (ownDirection.x * segmentDirectionX) + (ownDirection.y * segmentDirectionY)
    if (Math.abs(directionDot) < CONTINUATION_DIRECTION_COSINE) return false

    const pointDx = entry.point.x - segment.start.x
    const pointDy = entry.point.y - segment.start.y
    const projection = ((pointDx * segmentDx) + (pointDy * segmentDy)) / lengthSquared
    const endpointMargin = CONTINUATION_POINT_TOLERANCE / length
    if (projection <= endpointMargin || projection >= 1 - endpointMargin) return false

    const perpendicularDistance = Math.abs((pointDx * segmentDy) - (pointDy * segmentDx)) / length
    return perpendicularDistance <= CONTINUATION_POINT_TOLERANCE
  })
}

function isInternalStraightJoin(entry, endpointCells, segmentCells) {
  const ownDirection = directionFrom(entry.point, entry.other)
  if (!ownDirection) return false
  const maxDistanceSquared = CONTINUATION_POINT_TOLERANCE ** 2

  const continuedByEndpoint = nearbyEndpointEntries(entry.point, endpointCells).some(candidate => {
    if (candidate.segmentIndex === entry.segmentIndex) return false
    const dx = candidate.point.x - entry.point.x
    const dy = candidate.point.y - entry.point.y
    if ((dx * dx) + (dy * dy) > maxDistanceSquared) return false

    const candidateDirection = directionFrom(candidate.point, candidate.other)
    if (!candidateDirection) return false
    const dot = (ownDirection.x * candidateDirection.x) + (ownDirection.y * candidateDirection.y)
    // The two directions point away from their common join in opposite
    // directions. That makes this a continuation through the point rather
    // than the outer start/end of the visible line.
    return dot <= -CONTINUATION_DIRECTION_COSINE
  })
  return continuedByEndpoint || liesInsideCollinearSegment(entry, segmentCells)
}

function collectOuterLineEndpoints(segments) {
  const entries = segments.flatMap((segment, segmentIndex) => [
    { point: segment.start, other: segment.end, segmentIndex },
    { point: segment.end, other: segment.start, segmentIndex },
  ])
  const endpointCells = buildEndpointGrid(entries)
  const segmentCells = buildSegmentGrid(segments)
  const result = []
  const seen = new Set()
  for (const entry of entries) {
    if (!isInternalStraightJoin(entry, endpointCells, segmentCells)) appendUnique(result, seen, entry.point)
  }
  return result
}

/**
 * Extract straight stroked PDF vector geometry in the same unscaled viewport
 * coordinates used by PdfSvgOverlay. Keeping the segment pairs as well as the
 * existing outer endpoint list lets the Linear tool identify a complete PDF
 * line from one click without changing endpoint snapping.
 */
export function extractPdfLineGeometry(operatorList, viewport) {
  if (!operatorList || !viewport?.convertToViewportPoint) {
    return { endpoints: [], segments: [] }
  }
  const functions = operatorList.fnArray ?? []
  const argumentsList = operatorList.argsArray ?? []
  const matrixStack = []
  let matrix = IDENTITY_MATRIX
  let insideAnnotation = false
  const segments = []

  for (let index = 0; index < functions.length; index += 1) {
    const operation = functions[index]
    const args = argumentsList[index]

    if (operation === OPS.save) {
      matrixStack.push(matrix)
    } else if (operation === OPS.restore) {
      matrix = matrixStack.pop() ?? IDENTITY_MATRIX
    } else if (operation === OPS.transform && Array.isArray(args) && args.length >= 6) {
      matrix = multiply(matrix, args.map(Number))
    } else if (operation === OPS.paintFormXObjectBegin) {
      matrixStack.push(matrix)
      if (Array.isArray(args?.[0]) && args[0].length >= 6) matrix = multiply(matrix, args[0].map(Number))
    } else if (operation === OPS.paintFormXObjectEnd) {
      matrix = matrixStack.pop() ?? IDENTITY_MATRIX
    } else if (operation === OPS.beginAnnotation) {
      // PDF annotations are handled by the application's own overlay. Skipping
      // their appearance paths prevents duplicate/incorrect snap targets.
      insideAnnotation = true
    } else if (operation === OPS.endAnnotation) {
      insideAnnotation = false
    } else if (operation === OPS.constructPath && !insideAnnotation && STROKED_PATH_OPERATIONS.has(args?.[0])) {
      const buffer = readPathBuffer(args)
      if (buffer) collectStraightPathSegments(buffer, matrix, viewport, segments)
    }
  }

  return {
    endpoints: collectOuterLineEndpoints(segments),
    segments,
  }
}

/**
 * Backwards-compatible endpoint-only API retained for any callers that do
 * not need the paired line geometry.
 */
export function extractPdfLineEndpoints(operatorList, viewport) {
  return extractPdfLineGeometry(operatorList, viewport).endpoints
}
