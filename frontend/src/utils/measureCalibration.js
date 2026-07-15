import { useAppStore } from '../store/useAppStore'
import {
  pixelsToReal, pixelsAreaToReal, polylineLength,
  formatMeasureLength, formatMeasureArea,
  parseMeasureLabel, convertMeasureValue, convertFromMm, getUnitLabel,
} from './calculations'
import {
  calibrationSnapshot,
  traceCalibration,
  traceCalibrationWarn,
  traceMeasurementDebug,
} from './calibrationTrace'

const CANONICAL_UNITS = new Set(['Mm', 'Cm', 'Meter', 'Feet', 'Inch', 'Yd'])
const UNIT_ALIASES = {
  mm: 'Mm', millimeter: 'Mm', millimeters: 'Mm', Millimeter: 'Mm',
  cm: 'Cm', centimeter: 'Cm', centimeters: 'Cm', Centimeter: 'Cm',
  m: 'Meter', meter: 'Meter', meters: 'Meter', metres: 'Meter',
  ft: 'Feet', foot: 'Feet', feet: 'Feet', Foot: 'Feet',
  in: 'Inch', inch: 'Inch', inches: 'Inch', Inch: 'Inch',
  yd: 'Yd', yard: 'Yd', yards: 'Yd',
}

/** Map API / DB unit strings to our canonical unit keys. */
export function normalizeCalibrationUnit(unit) {
  if (!unit) return 'Mm'
  const raw = String(unit).trim()
  if (CANONICAL_UNITS.has(raw)) return raw
  return UNIT_ALIASES[raw] ?? UNIT_ALIASES[raw.toLowerCase()] ?? 'Mm'
}

/** Normalize API / store drawing fields to camelCase. */
export function normalizeDrawing(d) {
  if (!d) return null
  const scaleRatio = Number(d.scaleRatio ?? d.ScaleRatio ?? 0) || 0
  const rawFlag = !!(d.isCalibrated ?? d.IsCalibrated)
  const isCalibrated = rawFlag && scaleRatio > 0
  if (rawFlag && !(scaleRatio > 0)) {
    traceCalibrationWarn('normalizeDrawing.flagWithoutScale', calibrationSnapshot(d))
  }
  return {
    ...d,
    isCalibrated,
    scaleRatio,
    calibrationUnit: normalizeCalibrationUnit(d.calibrationUnit ?? d.CalibrationUnit),
  }
}

/** Read calibrated drawing from Zustand store (same rules as getCalibratedDrawing). */
export function getCalibratedDrawingFromStore() {
  return normalizeDrawing(useAppStore.getState().selectedDrawing)
}

/** Prefer viewer ref drawing, fall back to store — whichever is calibrated. */
export function getCalibratedDrawing(drawingRef) {
  const d = normalizeDrawing(drawingRef?.current)
  const sd = getCalibratedDrawingFromStore()
  if (d?.isCalibrated && d.scaleRatio > 0) return d
  if (sd?.isCalibrated && sd.scaleRatio > 0) return sd
  return d ?? sd
}

/** Parse Syncfusion px label / geometry into pixel length. */
export function extractPixelLengthFromAnnot(a, computedPx = 0) {
  if (computedPx >= 0.1) return computedPx

  const label = String(
    a?.Note ?? a?.note ?? a?.labelContent ?? a?.LabelContent ?? a?.label ?? a?.text ?? '',
  )
  const pxMatch = label.match(/([\d.]+)\s*px/i)
  if (pxMatch) {
    const v = parseFloat(pxMatch[1])
    if (Number.isFinite(v) && v > 0) return v
  }

  const mv = a?.measurementValue ?? a?.MeasurementValue
  if (mv != null && Number(mv) > 0 && /px/i.test(label)) return Number(mv)

  const cal = a?.Calibrate ?? a?.calibrate
  const dist = cal?.Distance ?? cal?.distance
  if (Array.isArray(dist) && dist.length >= 4) {
    const x1 = Number(dist[0]), y1 = Number(dist[1])
    const x2 = Number(dist[2]), y2 = Number(dist[3])
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      return Math.hypot(x2 - x1, y2 - y1)
    }
  }

  return computedPx
}

/**
 * Syncfusion display unit — always matches the right-panel Display Unit (default mm).
 */
export function getSyncfusionNativeUnit(drawing) {
  const d = normalizeDrawing(drawing)
  const active = useAppStore.getState().activeUnit
  return active ?? d?.calibrationUnit ?? 'Mm'
}

/** PDF points → display unit per point (1 pt = 1/72 in) for uncalibrated on-line preview. */
export function uncalibratedDestPerPdfPoint(displayUnit = 'Mm') {
  return convertFromMm(25.4 / 72, normalizeCalibrationUnit(displayUnit))
}

/** Give Syncfusion a default ratio so live labels show mm (not NaN) before calibration. */
export function applyUncalibratedMeasureRatioToViewer(vm, displayUnit = 'Mm') {
  if (!vm) return
  const mod = vm.annotation?.measureAnnotationModule
  const key = normalizeCalibrationUnit(displayUnit)
  const destPerPx = uncalibratedDestPerPdfPoint(key)
  const unitLabel = getUnitLabel(key)
  const depthMmPerPoint = 25.4 / 72
  const sfUnitMap = { Mm: 'Millimeter', Cm: 'Centimeter', Meter: 'Meter', Feet: 'Foot', Inch: 'Inch' }
  const sfUnit = sfUnitMap[key] ?? 'Millimeter'
  const distPatch = {
    displayUnit: sfUnit,
    conversionUnit: sfUnit,
    depth: depthMmPerPoint,
    scaleRatio: 1,
  }
  try {
    vm.measurementSettings = { ...(vm.measurementSettings ?? {}), ...distPatch }
  } catch (_) {}
  try { vm.annotation?.updateMeasurementSettings('Distance', distPatch) } catch (_) {}
  if (!mod) return
  mod.measureRatioObject = {
    ratio: destPerPx,
    unit: 'px',
    displayUnit: unitLabel,
    destValue: destPerPx,
    srcValue: 1,
    volumeDepth: depthMmPerPoint,
    depthValue: depthMmPerPoint,
    ratioString: `1 px = ${destPerPx} ${unitLabel}`,
  }
  const entry = {
    id: 'buildtakeoff-uncalibrated-default',
    annotName: 'buildtakeoff-uncalibrated-default',
    displayUnit: unitLabel,
    unit: 'px',
    ratio: destPerPx,
    destValue: destPerPx,
    srcValue: 1,
    volumeDepth: depthMmPerPoint,
    depthValue: depthMmPerPoint,
    ratioString: `1 px = ${destPerPx} ${unitLabel}`,
  }
  if (!mod.scaleRatioCollection) mod.scaleRatioCollection = []
  const idx = mod.scaleRatioCollection.findIndex(
    r => r.id === entry.id || r.annotName === entry.annotName,
  )
  if (idx >= 0) Object.assign(mod.scaleRatioCollection[idx], entry)
  else mod.scaleRatioCollection.push(entry)
  if (mod.sourceTextBox) mod.sourceTextBox.value = 1
  if (mod.destTextBox) mod.destTextBox.value = destPerPx
}

/** Per-line ratio entry while drawing (Syncfusion reads scaleRatioCollection by annot id). */
export function registerUncalibratedScaleForAnnotation(mod, annotationId, displayUnit = 'Mm') {
  if (!mod?.scaleRatioCollection || !annotationId) return
  const key = normalizeCalibrationUnit(displayUnit)
  const destPerPx = uncalibratedDestPerPdfPoint(key)
  const unitLabel = getUnitLabel(key)
  const depthMmPerPoint = 25.4 / 72
  const entry = {
    id: annotationId,
    annotName: annotationId,
    displayUnit: unitLabel,
    unit: 'px',
    ratio: destPerPx,
    destValue: destPerPx,
    srcValue: 1,
    volumeDepth: depthMmPerPoint,
    depthValue: depthMmPerPoint,
    ratioString: `1 px = ${destPerPx} ${unitLabel}`,
  }
  const idx = mod.scaleRatioCollection.findIndex(r => r.annotName === annotationId)
  if (idx >= 0) Object.assign(mod.scaleRatioCollection[idx], entry)
  else mod.scaleRatioCollection.push(entry)
}

/** PDF user-space points → real length in the user's display unit (72 pt = 1 in). */
export function lengthFromPdfPoints(pixelLength, targetUnit = 'Mm') {
  const px = pixelLength ?? 0
  if (px < 0.1) return null
  const len = convertMeasureValue(px / 72, 'Inch', targetUnit)
  return Number.isFinite(len) && len > 0 ? len : null
}

/** Resolve real length in display unit when drawing is not calibrated yet. */
export function resolveUncalibratedMeasureLength(pixelLength, annot, targetUnit = 'Mm') {
  const fromPx = lengthFromPdfPoints(pixelLength, targetUnit)
  if (fromPx != null) return fromPx

  const tryFromText = (text) => {
    const raw = String(text ?? '').trim()
    if (!raw || /nan/i.test(raw)) return null
    const parsed = parseMeasureLabel(raw)
    if (!parsed?.value || parsed.value <= 0 || !Number.isFinite(parsed.value) || parsed.isArea) return null
    return parsed.unit
      ? convertMeasureValue(parsed.value, parsed.unit, targetUnit)
      : parsed.value
  }

  const displayed = extractDisplayedMeasureFromAnnot(annot, targetUnit)
  if (displayed.length != null && displayed.length > 0 && Number.isFinite(displayed.length)) {
    return displayed.length
  }

  for (const field of [
    annot?.Note, annot?.note, annot?.notes, annot?.labelContent, annot?.LabelContent, annot?.label, annot?.text,
  ]) {
    const hit = tryFromText(field)
    if (hit != null) return hit
  }

  for (const child of annot?.wrapper?.children ?? []) {
    const text = String(child?.content ?? child?.childNodes?.[0]?.text ?? '').trim()
    const hit = tryFromText(text)
    if (hit != null) return hit
  }

  return null
}

/** Read the value Syncfusion shows on the line (e.g. "1.48 mm") when scale is not set yet. */
export function extractDisplayedMeasureFromAnnot(a, targetUnit = 'Mm') {
  if (!a) return { length: null, area: null }

  const tryParse = (text) => {
    const parsed = parseMeasureLabel(String(text ?? '').trim())
    if (!parsed?.value || parsed.value <= 0) return null
    const fromUnit = parsed.unit ?? targetUnit
    const value = fromUnit !== targetUnit
      ? convertMeasureValue(parsed.value, fromUnit, targetUnit)
      : parsed.value
    if (parsed.isArea) return { length: null, area: value }
    return { length: value, area: null }
  }

  const labelText = [
    a?.Note, a?.note, a?.notes, a?.labelContent, a?.LabelContent, a?.label, a?.text,
  ].map(v => String(v ?? '').trim()).find(t => t && !t.includes('NaN'))
  if (labelText) {
    const hit = tryParse(labelText)
    if (hit) return hit
  }

  const mv = a?.measurementValue ?? a?.MeasurementValue
  if (mv != null && Number(mv) > 0) return { length: Number(mv), area: null }

  const cal = a?.Calibrate ?? a?.calibrate
  if (cal) {
    const dist = cal?.Distance ?? cal?.distance
    let val = null
    if (Array.isArray(dist) && dist.length > 0) val = Number(dist[0])
    else if (typeof dist === 'number') val = dist
    if (val != null && val > 0) return { length: val, area: null }
  }

  for (const child of a?.wrapper?.children ?? []) {
    const text = String(child?.content ?? child?.childNodes?.[0]?.text ?? '').trim()
    if (!text || text.includes('NaN')) continue
    const hit = tryParse(text)
    if (hit) return hit
  }

  return { length: null, area: null }
}

export function extractPixelAreaFromAnnot(a, computedPxArea = 0) {
  if (computedPxArea >= 0.1) return computedPxArea
  const label = String(a?.Note ?? a?.note ?? a?.labelContent ?? a?.LabelContent ?? '')
  const m = label.match(/([\d.]+)\s*px²/i)
  if (m) {
    const v = parseFloat(m[1])
    if (Number.isFinite(v) && v > 0) return v
  }
  return computedPxArea
}

/** Extract pixel length from a stored takeoff pointsJson annotation blob. */
export function pixelLengthFromStoredAnnotation(pointsJson) {
  if (!pointsJson) return 0
  try {
    const a = typeof pointsJson === 'string' ? JSON.parse(pointsJson) : pointsJson
    let rawPts = a?.vertexPoints ?? a?.VertexPoints ?? []
    if (typeof rawPts === 'string') {
      try { rawPts = JSON.parse(rawPts) } catch { rawPts = [] }
    }
    let pts = (Array.isArray(rawPts) ? rawPts : [])
      .filter(p => p && typeof p === 'object')
      .map(p => ({ x: Number(p.x ?? p.X) || 0, y: Number(p.y ?? p.Y) || 0 }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    const start = a?.start ?? a?.Start
    const end = a?.end ?? a?.End
    if (pts.length < 2 && start != null && end != null) {
      const parseCoord = (c) => {
        if (Array.isArray(c)) return { x: Number(c[0]) || 0, y: Number(c[1]) || 0 }
        if (typeof c === 'object') return { x: Number(c.x ?? c.X) || 0, y: Number(c.y ?? c.Y) || 0 }
        return { x: 0, y: 0 }
      }
      pts = [parseCoord(start), parseCoord(end)]
    }
    if (pts.length >= 2) return polylineLength(pts)
    return extractPixelLengthFromAnnot(a, 0)
  } catch {
    return 0
  }
}

/** Real-world length from pixels when drawing is calibrated — never returns null if px > 0. */
export function computeRealLengthFromDrawing(pixelLength, drawing, displayUnit) {
  const d = normalizeDrawing(drawing)
  const px = pixelLength ?? 0
  if (!d?.isCalibrated || !(d.scaleRatio > 0) || px < 0.1) return null
  return pixelsToReal(px, d.scaleRatio, displayUnit)
}

/** Recompute length + description for all line items after scale is saved. */
export async function recalculateTakeoffItemsAfterCalibration(items, drawing, displayUnit, updateFn, onUpdated) {
  const d = normalizeDrawing(drawing)
  if (!d?.isCalibrated || !(d.scaleRatio > 0) || !items?.length) return items

  const updated = []
  for (const item of items) {
    const type = item.itemType || 'Line'
    if (type !== 'Line' && type !== 'Perimeter') {
      updated.push(item)
      continue
    }
    // Only backfill items that were never successfully calibrated at creation —
    // an item with a real stored length already reflects the calibration that
    // was active when it was drawn, and must never be rewritten by a later
    // recalibration. This is what makes it safe to call this function
    // unconditionally after every recalibration (it used to rewrite everything).
    const alreadyCalibrated = item.length != null && !/not calibrated/i.test(item.description ?? '')
    if (alreadyCalibrated) {
      updated.push(item)
      continue
    }
    let px = pixelLengthFromStoredAnnotation(item.pointsJson)
    if (px < 0.1) {
      const m = String(item.description ?? '').match(/([\d.]+)\s*px/i)
      if (m) px = parseFloat(m[1])
    }
    if (px < 0.1) {
      updated.push(item)
      continue
    }
    const length = pixelsToReal(px, d.scaleRatio, displayUnit)
    const desc = type === 'Perimeter'
      ? `Polyline: ${formatMeasureLength(length, displayUnit)}`
      : formatMeasureLength(length, displayUnit)
    try {
      const saved = await updateFn({
        ...item, length, description: desc, unit: displayUnit,
        scaleRatioAtCreation: d.scaleRatio,
        calibrationUnitAtCreation: d.calibrationUnit,
      })
      onUpdated?.(saved)
      updated.push(saved)
    } catch {
      updated.push(item)
    }
  }
  return updated
}

/** Compute real-world length/area from pixels when drawing is calibrated. */
export function resolveCalibratedMeasure(pixelLength, pixelArea, drawing, displayUnit, { isArea = false } = {}) {
  const d = normalizeDrawing(drawing)
  const pxLen = pixelLength ?? 0
  const pxArea = pixelArea ?? 0

  if (!d?.isCalibrated || !(d.scaleRatio > 0)) {
    const reason = !d ? 'noDrawing' : !(d.scaleRatio > 0) ? 'scaleRatioZeroOrMissing' : 'isCalibratedFalse'
    traceMeasurementDebug('measure.resolve.FALLBACK', {
      drawing: d,
      pixelLength: pxLen,
      pixelArea: pxArea,
      displayUnit,
      resolved: { length: null, area: null, isCalibrated: false },
      fallbackReason: reason,
    })
    return { length: null, area: null, pixelLength: pxLen, pixelArea: pxArea, isCalibrated: false, fallbackReason: reason }
  }

  let length = null
  let area = null
  if (isArea && pxArea >= 0.1) {
    area = pixelsAreaToReal(pxArea, d.scaleRatio, displayUnit)
    if (pxLen >= 0.1) length = pixelsToReal(pxLen, d.scaleRatio, displayUnit)
  } else if (pxLen >= 0.1) {
    length = pixelsToReal(pxLen, d.scaleRatio, displayUnit)
  }

  traceMeasurementDebug('measure.resolve.OK', {
    drawing: d,
    pixelLength: pxLen,
    displayUnit,
    resolved: { length, area, isCalibrated: true },
  })

  return { length, area, pixelLength: pxLen, pixelArea: pxArea, isCalibrated: true, displayUnit }
}

/** Grid description — real units when calibrated; never show px when scale exists. */
export function formatLineMeasureDescription(pixelLength, length, unit, drawing) {
  const d = normalizeDrawing(drawing)
  if (d?.isCalibrated && d.scaleRatio > 0) {
    const len = length ?? computeRealLengthFromDrawing(pixelLength, d, unit)
    if (len != null) return formatMeasureLength(len, unit)
  }
  if (length != null) return formatMeasureLength(length, unit)
  return 'Pending scale setup'
}

export function formatAreaMeasureDescription(pixelArea, area, unit, drawing) {
  const d = normalizeDrawing(drawing)
  if (d?.isCalibrated && d.scaleRatio > 0) {
    const a = area ?? (pixelArea >= 0.1 ? pixelsAreaToReal(pixelArea, d.scaleRatio, unit) : null)
    if (a != null) return formatMeasureArea(a, unit)
  }
  if (area != null) return formatMeasureArea(area, unit)
  return 'Area — pending scale setup'
}

export function formatPolylineDescription(pixelLength, length, unit, drawing) {
  const d = normalizeDrawing(drawing)
  if (d?.isCalibrated && d.scaleRatio > 0) {
    const len = length ?? computeRealLengthFromDrawing(pixelLength, d, unit)
    if (len != null) return `Polyline: ${formatMeasureLength(len, unit)}`
  }
  if (length != null) return `Polyline: ${formatMeasureLength(length, unit)}`
  return 'Polyline — pending scale setup'
}

/** Label text for PDF overlay (same format as the measurement grid). */
export function formatPdfMeasureLabel(length, area, displayUnit, { isArea = false } = {}) {
  if (isArea) return area != null ? formatMeasureArea(area, displayUnit) : ''
  return length != null ? formatMeasureLength(length, displayUnit) : ''
}
