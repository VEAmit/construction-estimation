import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { drawingService } from '../services/drawingService'
import { takeoffService } from '../services/takeoffService'
import { memberScheduleService } from '../services/memberScheduleService'
import { measurementSectionService } from '../services/measurementSectionService'
import { useAppStore } from '../store/useAppStore'
import { useBreakpoint } from '../utils/useBreakpoint'
import DrawingSidebar from '../components/drawings/DrawingSidebar'
import DrawingViewer from '../components/drawings/DrawingViewer'
import Toolbar from '../components/tools/Toolbar'
import RightPanel from '../components/tools/RightPanel'
import MeasurementTable from '../components/takeoff/TakeoffTable'
import MemberSchedulePanel from '../components/takeoff/MemberSchedulePanel'
import SectionMeasurementModal from '../components/takeoff/SectionMeasurementModal'
import SectionMeasurementsPanel from '../components/takeoff/SectionMeasurementsPanel'
import AddMeasurementModal from '../components/takeoff/AddTakeoffModal'
import AddDetectedMemberModal from '../components/takeoff/AddDetectedMemberModal'
import CalibrationModal from '../components/takeoff/CalibrationModal'
import { exportToExcel, exportToPdf } from '../utils/exportUtils'
import {
  computeScaleRatio, getUnitLabel, getAreaUnitLabel,
  formatMeasureLength, formatMeasureArea, toMeters,
} from '../utils/calculations'
import {
  normalizeDrawing,
  resolveCalibratedMeasure,
  formatLineMeasureDescription,
  formatAreaMeasureDescription,
  formatPolylineDescription,
  getCalibratedDrawingFromStore,
  computeRealLengthFromDrawing,
  recalculateTakeoffItemsAfterCalibration,
  extractDisplayedMeasureFromAnnot,
  resolveUncalibratedMeasureLength,
} from '../utils/measureCalibration'
import { calibrationSnapshot, traceCalibration, traceMeasurementDebug, mergeCalibrationState } from '../utils/calibrationTrace'
import {
  buildLinearMeasurementClipboard,
  DEFAULT_MEASURE_LABEL_SIZE,
  isValidLinearMeasurementForCopy,
  mapLinearArrowStyle,
} from '../utils/measureLabel'
import { resolveDrawColorForMemberMark } from '../utils/memberMarkColor'
import { getMeasurementMemberMark, parseMemberScheduleNoteId } from '../utils/memberMeasureLink'
import ExtractionModal from '../components/extraction/ExtractionModal'
import toast from 'react-hot-toast'
import { Files, Layers3, TableProperties } from 'lucide-react'
import { BottomDock, SideDock } from '../components/layout/WorkspaceDock'

const _MS_PALETTE = ['#3B82F6','#22C55E','#F97316','#A855F7','#06B6D4','#EAB308','#EC4899','#EF4444','#14B8A6','#F59E0B','#6366F1','#84CC16']
const _MS_HEX = /^#[0-9A-Fa-f]{6}$/
const DOCK_LAYOUT_VERSION = 2
const LEGACY_DOCK_LAYOUT_VERSION = 1
const SECTION_REVIEW_STORAGE_PREFIX = 'buildtakeoff:section-review:'
const LEFT_DOCK_MIN_WIDTH = 250
const LEFT_DOCK_DEFAULT_WIDTH = 290
const LEFT_DOCK_MIGRATION_WIDTH = 300
const LEFT_DOCK_MAX_WIDTH = 420
const bottomViewTabStyle = {
  height: 25,
  padding: '0 9px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  borderRadius: 5,
  border: '1px solid transparent',
  cursor: 'pointer',
  fontSize: 10,
  fontWeight: 750,
}

function readMeasurementSectionTemplate(section) {
  try {
    const template = typeof section?.templateJson === 'string'
      ? JSON.parse(section.templateJson)
      : section?.templateJson
    return template && typeof template === 'object' ? template : null
  } catch {
    return null
  }
}

function readPersistedSectionReview(projectId) {
  if (!projectId || typeof window === 'undefined') return null
  try {
    const sectionId = Number(localStorage.getItem(`${SECTION_REVIEW_STORAGE_PREFIX}${projectId}`))
    return Number.isFinite(sectionId) && sectionId > 0 ? sectionId : null
  } catch {
    return null
  }
}

function persistSectionReview(projectId, sectionId) {
  if (!projectId || typeof window === 'undefined') return
  try {
    const key = `${SECTION_REVIEW_STORAGE_PREFIX}${projectId}`
    if (sectionId) localStorage.setItem(key, String(sectionId))
    else localStorage.removeItem(key)
  } catch {
    // Storage can be unavailable in restricted/private browser contexts.
  }
}

function clampDockSize(value, min, max, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback
}

function getLeftDockMaxWidth(viewportWidth) {
  return Math.max(
    LEFT_DOCK_MIN_WIDTH,
    Math.min(LEFT_DOCK_MAX_WIDTH, Math.floor(viewportWidth * 0.32)),
  )
}

function getDockLayoutDefaults(isMobile, isTablet) {
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
  const leftMaxWidth = getLeftDockMaxWidth(viewportWidth)
  return {
    version: DOCK_LAYOUT_VERSION,
    leftTab: 'drawings',
    leftOpen: true,
    leftPinned: true,
    leftWidth: clampDockSize(
      Math.min(LEFT_DOCK_MIGRATION_WIDTH, viewportWidth * 0.18),
      LEFT_DOCK_MIN_WIDTH,
      leftMaxWidth,
      LEFT_DOCK_DEFAULT_WIDTH,
    ),
    rightOpen: true,
    rightPinned: true,
    rightWidth: clampDockSize(viewportWidth * 0.18, 250, 440, 280),
    bottomOpen: true,
    bottomPinned: true,
    bottomHeight: isMobile ? 190 : isTablet ? 230 : clampDockSize(viewportHeight * 0.28, 210, 380, 260),
  }
}

function readDockLayout(projectId, isMobile, isTablet) {
  const defaults = getDockLayoutDefaults(isMobile, isTablet)
  if (typeof window === 'undefined') return defaults
  try {
    const saved = JSON.parse(localStorage.getItem(`buildtakeoff:workspace:${projectId ?? 'default'}`) || 'null')
    if (!saved || ![LEGACY_DOCK_LAYOUT_VERSION, DOCK_LAYOUT_VERSION].includes(saved.version)) return defaults
    const savedLeftWidth = saved.version === LEGACY_DOCK_LAYOUT_VERSION
      ? Math.min(Number(saved.leftWidth) || defaults.leftWidth, LEFT_DOCK_MIGRATION_WIDTH)
      : saved.leftWidth
    return {
      ...defaults,
      ...saved,
      version: DOCK_LAYOUT_VERSION,
      leftTab: saved.leftTab === 'members' ? 'members' : 'drawings',
      leftWidth: clampDockSize(
        savedLeftWidth,
        LEFT_DOCK_MIN_WIDTH,
        getLeftDockMaxWidth(window.innerWidth),
        defaults.leftWidth,
      ),
      rightWidth: clampDockSize(saved.rightWidth, 250, Math.max(250, window.innerWidth * 0.4), defaults.rightWidth),
      bottomHeight: clampDockSize(saved.bottomHeight, 180, Math.max(180, window.innerHeight * 0.68), defaults.bottomHeight),
    }
  } catch {
    return defaults
  }
}

function assignMemberColors(members) {
  const sorted = [...members].sort((a, b) =>
    (a.mark ?? '').localeCompare(b.mark ?? '', undefined, { sensitivity: 'base' })
  )
  const colorMap = new Map()
  sorted.forEach((m, i) => {
    if (!m.color || !_MS_HEX.test(m.color))
      colorMap.set(m.id, _MS_PALETTE[i % _MS_PALETTE.length])
  })
  if (colorMap.size === 0) return members
  const colored = members.map(m => colorMap.has(m.id) ? { ...m, color: colorMap.get(m.id) } : m)
  colored.filter(m => colorMap.has(m.id))
    .forEach(m => memberScheduleService.update(m).catch(() => {}))
  return colored
}

function normalizeMemberIdentityPart(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, '')
    .replace(/[xX×]/g, 'X')
    .toUpperCase()
}

function getNextDefaultMemberColor(items) {
  const used = new Set(
    (items ?? [])
      .map(item => String(item?.color ?? '').toUpperCase())
      .filter(color => _MS_HEX.test(color)),
  )
  return _MS_PALETTE.find(color => !used.has(color.toUpperCase()))
    ?? _MS_PALETTE[(items?.length ?? 0) % _MS_PALETTE.length]
}

function readTakeoffPointsJson(pointsJson) {
  if (!pointsJson) return null
  try {
    return typeof pointsJson === 'string' ? JSON.parse(pointsJson) : pointsJson
  } catch {
    return null
  }
}

function getRawAnnotationId(raw) {
  if (!raw || typeof raw !== 'object') return null
  return raw.AnnotName ?? raw.annotName ?? raw.annotationId ?? raw.AnnotationId ?? raw.uniqueKey ?? raw.name ?? raw.id ?? null
}

function stripOccurrenceContainer(raw) {
  if (!raw || typeof raw !== 'object') return raw
  const { occurrences, occurrenceModelVersion, itemId, ItemId, ...geometry } = raw
  void occurrences
  void occurrenceModelVersion
  void itemId
  void ItemId
  return geometry
}

function buildTakeoffOccurrencesFromItem(item) {
  const raw = readTakeoffPointsJson(item?.pointsJson)
  if (!raw || typeof raw !== 'object') return []
  const existing = Array.isArray(raw.occurrences) ? raw.occurrences : null
  if (existing?.length) {
    return existing
      .map((occ, index) => {
        const geometry = stripOccurrenceContainer(occ?.geometry ?? occ?.rawAnnotation ?? occ)
        const annotationName = occ?.annotationName ?? getRawAnnotationId(geometry)
        if (!annotationName || !geometry) return null
        return {
          occurrenceId: occ?.occurrenceId ?? occ?.OccurrenceId ?? annotationName,
          itemId: Number(item?.id ?? raw.itemId ?? raw.ItemId) || item?.id,
          pageNumber: Number(occ?.pageNumber ?? geometry.pageNumber ?? geometry.PageNumber ?? 1) || 1,
          annotationName,
          position: occ?.position ?? null,
          rotation: occ?.rotation ?? geometry.RotateAngle ?? geometry.rotateAngle ?? 0,
          createdAt: occ?.createdAt ?? occ?.CreatedAt ?? item?.createdAt ?? new Date().toISOString(),
          isRoot: Boolean(occ?.isRoot ?? index === 0),
          length: Number.isFinite(Number(occ?.length ?? occ?.Length))
            ? Number(occ?.length ?? occ?.Length)
            : (Number.isFinite(Number(item?.length)) ? Number(item.length) : null),
          unit: occ?.unit ?? occ?.Unit ?? item?.unit ?? null,
          geometry,
        }
      })
      .filter(Boolean)
  }

  const geometry = stripOccurrenceContainer(raw)
  const annotationName = getRawAnnotationId(geometry)
  if (!annotationName) return []
  return [{
    occurrenceId: raw.occurrenceId ?? raw.OccurrenceId ?? `root-${item?.id ?? annotationName}`,
    itemId: Number(item?.id ?? raw.itemId ?? raw.ItemId) || item?.id,
    pageNumber: Number(geometry.pageNumber ?? geometry.PageNumber ?? 1) || 1,
    annotationName,
    position: null,
    rotation: geometry.RotateAngle ?? geometry.rotateAngle ?? 0,
    createdAt: item?.createdAt ?? new Date().toISOString(),
    isRoot: true,
    length: Number.isFinite(Number(item?.length)) ? Number(item.length) : null,
    unit: item?.unit ?? null,
    geometry,
  }]
}

function takeoffOccurrenceLength(occurrence, fallback = null) {
  const value = Number(occurrence?.length ?? occurrence?.Length)
  if (Number.isFinite(value) && value >= 0) return value
  const fallbackValue = Number(fallback)
  return Number.isFinite(fallbackValue) && fallbackValue >= 0 ? fallbackValue : null
}

function takeoffLengthsMatch(left, right) {
  const leftValue = Number(left)
  const rightValue = Number(right)
  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return false
  const tolerance = Math.max(0.000001, Math.max(Math.abs(leftValue), Math.abs(rightValue)) * 0.000001)
  return Math.abs(leftValue - rightValue) <= tolerance
}

function takeoffUnitsMatch(left, right) {
  if (left == null || right == null) return true
  return String(left).trim().toLowerCase() === String(right).trim().toLowerCase()
}

// A grouped row represents repeated instances of one dimension. Its Length is
// the per-instance length and Quantity is the number of occurrences; Length
// must never become the sum of all pasted instances.
function groupedTakeoffOccurrenceLength(occurrences, fallback = null) {
  const first = (occurrences ?? [])
    .map(occurrence => takeoffOccurrenceLength(occurrence, null))
    .find(value => value != null)
  return first ?? takeoffOccurrenceLength(null, fallback)
}

function groupedTakeoffTotalWeight(item, length, quantity, unit = null) {
  if (item?.unitWeight == null || length == null) return item?.totalWeight
  const totalWeight = Number(item.unitWeight)
    * toMeters(length, unit ?? item.unit)
    * Number(quantity ?? 1)
  return Number.isFinite(totalWeight) ? totalWeight : item?.totalWeight
}

function buildOccurrenceContainer(item, occurrences) {
  const raw = readTakeoffPointsJson(item?.pointsJson) ?? {}
  const normalized = (occurrences ?? []).map((occurrence, index) => ({
    ...occurrence,
    occurrenceId: occurrence?.occurrenceId
      ?? occurrence?.OccurrenceId
      ?? occurrence?.annotationName
      ?? getRawAnnotationId(occurrence?.geometry ?? occurrence?.rawAnnotation ?? occurrence),
    itemId: Number(item?.id ?? occurrence?.itemId) || item?.id,
    annotationName: occurrence?.annotationName
      ?? getRawAnnotationId(occurrence?.geometry ?? occurrence?.rawAnnotation ?? occurrence),
    isRoot: index === 0,
    geometry: stripOccurrenceContainer(
      occurrence?.geometry ?? occurrence?.rawAnnotation ?? occurrence,
    ),
  }))
  const rootGeometry = normalized[0]?.geometry ?? stripOccurrenceContainer(raw)
  return {
    ...rootGeometry,
    occurrenceModelVersion: 2,
    itemId: item?.id,
    occurrences: normalized,
  }
}

function appendTakeoffOccurrence(item, {
  geometry,
  annotationId,
  pageNumber,
  occurrenceId,
  length,
  unit,
}) {
  if (!item || !geometry || !annotationId) return null
  const existing = buildTakeoffOccurrencesFromItem(item)
  if (existing.some(occ => String(occ.annotationName) === String(annotationId))) {
    return { item, occurrences: existing, appended: false, duplicate: true }
  }
  const groupedLength = groupedTakeoffOccurrenceLength(existing, item.length)
  const incomingLength = takeoffOccurrenceLength({ length }, null)
  const groupedUnit = existing[0]?.unit ?? item.unit
  const incomingUnit = unit ?? item.unit
  if ((groupedLength != null && incomingLength != null && !takeoffLengthsMatch(groupedLength, incomingLength))
      || !takeoffUnitsMatch(groupedUnit, incomingUnit)) {
    return { item, occurrences: existing, appended: false, lengthMismatch: true }
  }
  const occurrences = [
    ...existing,
    {
      occurrenceId: occurrenceId ?? annotationId,
      itemId: item.id,
      pageNumber: Number(pageNumber ?? geometry.pageNumber ?? geometry.PageNumber ?? 1) || 1,
      annotationName: annotationId,
      position: null,
      rotation: geometry.RotateAngle ?? geometry.rotateAngle ?? 0,
      createdAt: new Date().toISOString(),
      isRoot: false,
      length: Number.isFinite(Number(length)) ? Number(length) : null,
      unit: unit ?? item.unit ?? null,
      geometry: stripOccurrenceContainer(geometry),
    },
  ]
  const rowLength = groupedTakeoffOccurrenceLength(occurrences, item.length)
  const next = {
    ...item,
    quantity: occurrences.length,
    length: rowLength,
    totalWeight: groupedTakeoffTotalWeight(item, rowLength, occurrences.length, unit),
    pointsJson: JSON.stringify(buildOccurrenceContainer(item, occurrences)),
  }
  return { item: next, occurrences, appended: true }
}

function updateTakeoffOccurrence(item, annotationId, updater) {
  if (!item?.pointsJson || annotationId == null) return null
  const raw = readTakeoffPointsJson(item.pointsJson)
  if (!Array.isArray(raw?.occurrences) || !raw.occurrences.length) return null
  let changed = false
  const occurrences = buildTakeoffOccurrencesFromItem(item).map(occurrence => {
    if (String(occurrence.annotationName) !== String(annotationId)) return occurrence
    changed = true
    return updater(occurrence)
  })
  if (!changed) return null
  const rowLength = groupedTakeoffOccurrenceLength(occurrences, item.length)
  return {
    ...item,
    quantity: occurrences.length,
    length: rowLength,
    totalWeight: groupedTakeoffTotalWeight(item, rowLength, occurrences.length),
    pointsJson: JSON.stringify(buildOccurrenceContainer(item, occurrences)),
  }
}

function removeTakeoffOccurrence(item, annotationId) {
  if (!item?.pointsJson || annotationId == null) return null
  const raw = readTakeoffPointsJson(item.pointsJson)
  if (!Array.isArray(raw?.occurrences) || !raw.occurrences.length) return null
  const existing = buildTakeoffOccurrencesFromItem(item)
  const occurrences = existing.filter(
    occurrence => String(occurrence.annotationName) !== String(annotationId),
  )
  if (occurrences.length === existing.length) return null
  if (!occurrences.length) return { item: null, occurrences, removed: true }
  const rowLength = groupedTakeoffOccurrenceLength(occurrences, item.length)
  return {
    item: {
      ...item,
      quantity: occurrences.length,
      length: rowLength,
      totalWeight: groupedTakeoffTotalWeight(item, rowLength, occurrences.length),
      pointsJson: JSON.stringify(buildOccurrenceContainer(item, occurrences)),
    },
    occurrences,
    removed: true,
  }
}

function buildChangedLineGeometry(item, occurrence, payload, annotationId, fallbackUnit) {
  const movedRaw = JSON.parse(JSON.stringify(payload.rawAnnotation))
  const baseGeometry = stripOccurrenceContainer(occurrence?.geometry ?? readTakeoffPointsJson(item?.pointsJson) ?? {})
  const stableAnnotId = annotationId ?? getRawAnnotationId(baseGeometry) ?? getRawAnnotationId(movedRaw)
  const geometry = {
    ...baseGeometry,
    ...movedRaw,
    annotationId: stableAnnotId,
    AnnotName: stableAnnotId,
    name: stableAnnotId,
    strokeColor: baseGeometry.strokeColor ?? baseGeometry.StrokeColor ?? movedRaw.strokeColor,
    StrokeColor: baseGeometry.StrokeColor ?? baseGeometry.strokeColor ?? movedRaw.StrokeColor,
    thickness: baseGeometry.thickness ?? baseGeometry.Thickness ?? movedRaw.thickness,
    Thickness: baseGeometry.Thickness ?? baseGeometry.thickness ?? movedRaw.Thickness,
  }
  const movedPoints = movedRaw.vertexPoints ?? movedRaw.VertexPoints ?? []
  const firstPoint = movedPoints[0]
  const lastPoint = movedPoints[movedPoints.length - 1]
  const derivedPixelLength = firstPoint && lastPoint
    ? Math.hypot(
        Number(lastPoint.x ?? lastPoint.X) - Number(firstPoint.x ?? firstPoint.X),
        Number(lastPoint.y ?? lastPoint.Y) - Number(firstPoint.y ?? firstPoint.Y),
      )
    : null
  const pixelLength = Number.isFinite(Number(payload.pixelLength))
    ? Number(payload.pixelLength)
    : derivedPixelLength
  const unit = payload.unit ?? occurrence?.unit ?? item?.unit ?? fallbackUnit
  const nextLength = payload.length != null
    && Number.isFinite(Number(payload.length))
    && Number(payload.length) >= 0
    ? Number(payload.length)
    : takeoffOccurrenceLength(occurrence, item?.length)
  const description = formatLineMeasureDescription(
    pixelLength,
    nextLength,
    unit,
    getCalibratedDrawingFromStore(),
  )
  return { geometry, movedRaw, pixelLength, unit, nextLength, description, stableAnnotId }
}

function buildIndependentGeometryItem(item, occurrence, payload, annotationId, fallbackUnit) {
  const change = buildChangedLineGeometry(item, occurrence, payload, annotationId, fallbackUnit)
  const quantity = Number(item?.quantity ?? 1)
  return {
    change,
    item: {
      ...item,
      quantity,
      unit: change.unit,
      length: change.nextLength,
      totalWeight: groupedTakeoffTotalWeight(item, change.nextLength, quantity, change.unit),
      description: change.description,
      pointsJson: JSON.stringify(change.geometry),
    },
  }
}

function linkedTakeoffRootId(notes) {
  const match = String(notes ?? '').match(/\blinkedItem:(\d+)/i)
  return match ? Number(match[1]) : null
}

function withoutLegacyOccurrenceLinkNotes(notes) {
  return String(notes ?? '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !/^linkedItem:/i.test(part) && !/^occurrence:/i.test(part))
    .join(';')
}

async function consolidateLegacyLinkedTakeoffRows(items) {
  let working = [...(items ?? [])]
  const childrenByRoot = new Map()
  working.forEach(item => {
    const rootId = linkedTakeoffRootId(item?.notes)
    if (rootId == null || Number(item.id) === rootId) return
    const children = childrenByRoot.get(rootId) ?? []
    children.push(item)
    childrenByRoot.set(rootId, children)
  })

  let changed = false
  for (const [rootId, children] of childrenByRoot) {
    const originalRoot = working.find(item => Number(item.id) === Number(rootId))
    if (!originalRoot || !children.length) continue

    let groupedRoot = originalRoot
    let appendedAny = false
    const mergedChildren = []
    children.forEach(child => {
      const childOccurrences = buildTakeoffOccurrencesFromItem(child)
      let candidateRoot = groupedRoot
      let childCanMerge = childOccurrences.length > 0
      let childAppended = false
      childOccurrences.forEach(occurrence => {
        if (!childCanMerge) return
        const appended = appendTakeoffOccurrence(candidateRoot, {
          geometry: occurrence.geometry,
          annotationId: occurrence.annotationName,
          occurrenceId: occurrence.occurrenceId,
          pageNumber: occurrence.pageNumber,
          length: occurrence.length,
          unit: occurrence.unit ?? child.unit,
        })
        if (appended?.appended) {
          candidateRoot = appended.item
          childAppended = true
        } else if (!appended?.duplicate) {
          childCanMerge = false
        }
      })
      if (childCanMerge) {
        groupedRoot = candidateRoot
        mergedChildren.push(child)
        appendedAny = appendedAny || childAppended
      }
    })
    if (!appendedAny || !mergedChildren.length) continue

    const deletedChildren = []
    try {
      const savedRoot = await takeoffService.update(groupedRoot)
      for (const child of mergedChildren) {
        await takeoffService.delete(child.id)
        deletedChildren.push(child)
      }
      const childIds = new Set(mergedChildren.map(child => Number(child.id)))
      working = working
        .filter(item => !childIds.has(Number(item.id)))
        .map(item => Number(item.id) === Number(rootId) ? savedRoot : item)
      changed = true
    } catch (error) {
      // Consolidation is all-or-nothing for a group. Restore any children that
      // were already soft-deleted and put the untouched root back if a later
      // request failed, so a migration can never lose an annotation.
      await Promise.allSettled(deletedChildren.map(child => takeoffService.restore(child)))
      await takeoffService.update(originalRoot).catch(() => {})
      console.warn('[BuildTakeoff] legacy pasted-row consolidation skipped:', error)
    }
  }

  return { items: working, changed }
}

function groupTakeoffOccurrencesByLength(occurrences, fallbackLength, fallbackUnit) {
  const groups = []
  ;(occurrences ?? []).forEach(occurrence => {
    const length = takeoffOccurrenceLength(occurrence, fallbackLength)
    const unit = occurrence?.unit ?? fallbackUnit
    const existing = groups.find(group => (
      takeoffUnitsMatch(group.unit, unit)
      && ((group.length == null && length == null)
        || (group.length != null && length != null && takeoffLengthsMatch(group.length, length)))
    ))
    if (existing) existing.occurrences.push(occurrence)
    else groups.push({ length, unit, occurrences: [occurrence] })
  })
  return groups
}

function buildTakeoffOccurrenceGroupItem(item, occurrences) {
  const rowLength = groupedTakeoffOccurrenceLength(occurrences, item.length)
  const rowUnit = occurrences[0]?.unit ?? item.unit
  const quantity = occurrences.length
  const pointsJson = quantity === 1
    ? JSON.stringify(stripOccurrenceContainer(occurrences[0].geometry))
    : JSON.stringify(buildOccurrenceContainer(item, occurrences))
  return {
    ...item,
    quantity,
    unit: rowUnit,
    length: rowLength,
    totalWeight: groupedTakeoffTotalWeight(item, rowLength, quantity, rowUnit),
    pointsJson,
  }
}

// Records created by older builds may contain different occurrence lengths in
// one row or may store the sum in Length. Normalize them on load so upgraded
// projects obey the same per-dimension grouping invariant as new pastes.
async function normalizeGroupedTakeoffRows(items) {
  let working = [...(items ?? [])]
  let changed = false

  for (const original of [...working]) {
    const raw = readTakeoffPointsJson(original?.pointsJson)
    if (!Array.isArray(raw?.occurrences) || raw.occurrences.length === 0) continue
    const occurrences = buildTakeoffOccurrencesFromItem(original)
    if (!occurrences.length) continue
    const groups = groupTakeoffOccurrencesByLength(occurrences, original.length, original.unit)
    if (!groups.length) continue

    if (groups.length === 1) {
      const normalized = buildTakeoffOccurrenceGroupItem(original, groups[0].occurrences)
      const totalWeightChanged = normalized.totalWeight != null
        && !takeoffLengthsMatch(normalized.totalWeight, original.totalWeight)
      if (Number(original.quantity ?? 1) === normalized.quantity
          && takeoffLengthsMatch(original.length, normalized.length)
          && takeoffUnitsMatch(original.unit, normalized.unit)
          && !totalWeightChanged) continue
      try {
        const saved = await takeoffService.update(normalized)
        working = working.map(item => Number(item.id) === Number(original.id) ? saved : item)
        changed = true
      } catch (error) {
        console.warn('[BuildTakeoff] grouped measurement normalization skipped:', error)
      }
      continue
    }

    const createdRows = []
    try {
      for (const group of groups.slice(1)) {
        const template = buildTakeoffOccurrenceGroupItem(
          { ...original, quantity: group.occurrences.length },
          group.occurrences,
        )
        let created = await takeoffService.create({
          drawingId: original.drawingId,
          itemType: original.itemType || 'Line',
          mark: original.mark,
          description: original.description,
          quantity: template.quantity,
          unit: template.unit,
          material: original.material,
          notes: withoutLegacyOccurrenceLinkNotes(original.notes),
          length: template.length,
          area: original.area,
          unitWeight: original.unitWeight,
          totalWeight: template.totalWeight,
          color: original.color,
          category: original.category,
          pointsJson: template.pointsJson,
          scaleRatioAtCreation: original.scaleRatioAtCreation,
          calibrationUnitAtCreation: original.calibrationUnitAtCreation,
        })
        createdRows.push(created)
        if (group.occurrences.length > 1) {
          created = await takeoffService.update({
            ...created,
            pointsJson: JSON.stringify(buildOccurrenceContainer(created, group.occurrences)),
          })
          createdRows[createdRows.length - 1] = created
        }
      }

      const root = await takeoffService.update(
        buildTakeoffOccurrenceGroupItem(original, groups[0].occurrences),
      )
      working = working
        .map(item => Number(item.id) === Number(original.id) ? root : item)
        .concat(createdRows)
      changed = true
    } catch (error) {
      await Promise.allSettled(createdRows.map(item => takeoffService.delete(item.id)))
      console.warn('[BuildTakeoff] mixed-length measurement split skipped:', error)
    }
  }

  return { items: working, changed }
}

function extractTakeoffAnnotationIds(pointsJson) {
  const raw = readTakeoffPointsJson(pointsJson)
  if (!raw) return []
  if (Array.isArray(raw.occurrences) && raw.occurrences.length) {
    return raw.occurrences
      .map(occ => occ?.annotationName ?? getRawAnnotationId(occ?.geometry ?? occ?.rawAnnotation ?? occ))
      .filter(Boolean)
  }
  const id = getRawAnnotationId(raw)
  return id ? [id] : []
}

function cloneHistoryValue(value) {
  if (value == null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function buildTakeoffAnnotationIndex(items) {
  const map = {}
  const persistedIds = new Set()
  ;(items ?? []).forEach(item => {
    if (!item?.pointsJson) return
    const annotationIds = extractTakeoffAnnotationIds(item.pointsJson)
    annotationIds.forEach(id => persistedIds.add(id))
    const annotId = annotationIds[0]
    if (!annotId) return
    const stored = readTakeoffPointsJson(item.pointsJson) ?? {}
    const firstGeometry = buildTakeoffOccurrencesFromItem(item)[0]?.geometry ?? stored
    const page0 = stored.page != null
      ? parseInt(stored.page, 10)
      : (firstGeometry.pageIndex ?? firstGeometry.page ?? 0)
    map[item.id] = {
      annotationId: annotId,
      annotationIds,
      pageNumber: (Number.isFinite(page0) ? page0 : 0) + 1,
    }
  })
  return { map, persistedIds }
}

const TAKEOFF_HISTORY_FIELDS = [
  'mark', 'description', 'itemType', 'length', 'area', 'quantity', 'unit',
  'material', 'unitWeight', 'totalWeight', 'notes', 'pointsJson', 'color',
  'category', 'scaleRatioAtCreation', 'calibrationUnitAtCreation', 'drawingId',
]

function takeoffItemsMatch(left, right) {
  return TAKEOFF_HISTORY_FIELDS.every(field => {
    const a = left?.[field] ?? null
    const b = right?.[field] ?? null
    if (a == null || b == null) return a == null && b == null
    return typeof a === 'number' || typeof b === 'number'
      ? Number(a) === Number(b)
      : String(a ?? '') === String(b ?? '')
  })
}

export default function DrawingsPage() {
  const navigate = useNavigate()
  const { isMobile, isTablet } = useBreakpoint()

  const {
    selectedProject, setSelectedProject,
    drawings: storeDrawings, setDrawings, selectedDrawing, setSelectedDrawing,
    takeoffItems, addTakeoffItem, setTakeoffItems, updateTakeoffItem,
    setSummary, activeTool, setActiveTool, setActiveUnit, activeUnit, updateDrawingCalibration,
    memberScheduleItems, addMemberScheduleItem, setMemberScheduleItems, setMemberScheduleSummary, updateMemberScheduleItem, removeMemberScheduleItem,
    setSelectedMemberScheduleItem,
    triggerPdfCommand,
    _hydrated,
    measureColor, lineThickness, lineStyle, arrowStyle, measureCategory,
    measureLabelFontSize, setMeasureLabelFontSize,
    measurementClipboard, setMeasurementClipboard, clearMeasurementClipboard, clearPasteAnchor,
    pdfScale,
    removeTakeoffItem,
    setMeasureColor,
    setLineThickness,
    resetDrawingInteraction,
  } = useAppStore()

  useEffect(() => {
    resetDrawingInteraction()
  }, [resetDrawingInteraction])

  const initialDockLayoutRef = useRef(null)
  if (initialDockLayoutRef.current == null) {
    initialDockLayoutRef.current = readDockLayout(selectedProject?.id, isMobile, isTablet)
  }
  const initialDockLayout = initialDockLayoutRef.current

  const readThicknessFromPointsJson = useCallback((pointsJson, annotationId = null) => {
    if (!pointsJson) return null
    try {
      const d = JSON.parse(pointsJson)
      const selectedOccurrence = annotationId != null && Array.isArray(d.occurrences)
        ? d.occurrences.find(occ => {
            const geometry = occ?.geometry ?? occ?.rawAnnotation ?? occ
            return String(occ?.annotationName ?? getRawAnnotationId(geometry)) === String(annotationId)
          })
        : null
      const source = selectedOccurrence?.geometry
        ?? selectedOccurrence?.rawAnnotation
        ?? selectedOccurrence
        ?? d
      const t = source.Thickness ?? source.thickness
      return t != null && Number.isFinite(Number(t)) && Number(t) > 0 ? Number(t) : null
    } catch {
      return null
    }
  }, [])

  const readLabelSizeFromPointsJson = useCallback((pointsJson, annotationId = null) => {
    if (!pointsJson) return null
    try {
      const d = JSON.parse(pointsJson)
      const selectedOccurrence = annotationId != null && Array.isArray(d.occurrences)
        ? d.occurrences.find(occ => {
            const geometry = occ?.geometry ?? occ?.rawAnnotation ?? occ
            const occurrenceAnnotationId = occ?.annotationName ?? getRawAnnotationId(geometry)
            return occurrenceAnnotationId != null
              && String(occurrenceAnnotationId) === String(annotationId)
          })
        : null
      const source = selectedOccurrence?.geometry
        ?? selectedOccurrence?.rawAnnotation
        ?? selectedOccurrence
        ?? d
      const s = source.labelUserFontSize ?? source.LabelUserFontSize
      if (s != null && Number.isFinite(Number(s)) && Number(s) > 0) return Number(s)
      // The PDF renderer uses the shared default when an older occurrence has
      // no explicit size. Reflect that same value in the toolbar instead of
      // leaving whichever unrelated measurement size happened to be selected.
      return selectedOccurrence ? DEFAULT_MEASURE_LABEL_SIZE : null
    } catch {
      return null
    }
  }, [])

  const syncToolbarFromTakeoffItem = useCallback((item, annotationId = null) => {
    if (!item) return
    const HEX_RE = /^#[0-9A-Fa-f]{6}$/
    const raw = readTakeoffPointsJson(item.pointsJson)
    const selectedOccurrence = annotationId != null && Array.isArray(raw?.occurrences)
      ? raw.occurrences.find(occ => {
          const geometry = occ?.geometry ?? occ?.rawAnnotation ?? occ
          return String(occ?.annotationName ?? getRawAnnotationId(geometry)) === String(annotationId)
        })
      : null
    const selectedGeometry = selectedOccurrence?.geometry
      ?? selectedOccurrence?.rawAnnotation
      ?? selectedOccurrence
    const selectedColor = selectedGeometry?.strokeColor
      ?? selectedGeometry?.StrokeColor
      ?? item.color
    if (selectedColor && HEX_RE.test(selectedColor)) {
      setMeasureColor(selectedColor)
    } else {
      const memberMark = (item.material || item.mark || '').trim().toLowerCase()
      if (memberMark) {
        const msi = useAppStore.getState().memberScheduleItems
          .find(m => (m.mark || '').trim().toLowerCase() === memberMark)
        if (msi?.color && HEX_RE.test(msi.color)) setMeasureColor(msi.color)
      }
    }
    const t = readThicknessFromPointsJson(item.pointsJson, annotationId)
    if (t != null) setLineThickness(t)
    // Reflect this item's own current label size in the toolbar so the S/M/L/XL
    // buttons and the custom pt input show what's actually on the drawing —
    // otherwise the control kept showing whatever was last used elsewhere,
    // and changing it appeared to do nothing to the label you just selected.
    const labelSize = readLabelSizeFromPointsJson(item.pointsJson, annotationId)
    if (labelSize != null) setMeasureLabelFontSize(labelSize)

    // Reciprocal of Member Schedule → grid/PDF selection: selecting a measurement
    // (grid row or PDF label) now also highlights its member in the schedule panel.
    const mark = getMeasurementMemberMark(item, useAppStore.getState().memberScheduleItems).trim().toLowerCase()
    if (mark) {
      const member = useAppStore.getState().memberScheduleItems
        .find(m => (m.mark || '').trim().toLowerCase() === mark)
      if (member) setSelectedMemberScheduleItem(member)
    }
  }, [
    readThicknessFromPointsJson, readLabelSizeFromPointsJson,
    setMeasureColor, setLineThickness, setMeasureLabelFontSize, setSelectedMemberScheduleItem,
  ])

  const drawings = Array.isArray(storeDrawings) ? storeDrawings : []
  const activeDrawing = normalizeDrawing(selectedDrawing)
  useEffect(() => {
    if (storeDrawings != null && !Array.isArray(storeDrawings)) setDrawings([])
  }, [storeDrawings, setDrawings])

  const [lastMeasurement,  setLastMeasurement]  = useState(null)
  const [showAddModal,     setShowAddModal]      = useState(false)
  const [pendingMeas,      setPendingMeas]       = useState(null)
  const [showCalModal,     setShowCalModal]      = useState(false)
  const [scaleSetupFirstMeasure, setScaleSetupFirstMeasure] = useState(false)
  const [calSaving,        setCalSaving]         = useState(false)
  const [autoSaving,       setAutoSaving]        = useState(false)
  const [showBottom,       setShowBottom]        = useState(initialDockLayout.bottomOpen)
  const [bottomPinned,     setBottomPinned]      = useState(initialDockLayout.bottomPinned)
  const [bottomHovered,    setBottomHovered]     = useState(false)
  const [bottomH,          setBottomH]           = useState(initialDockLayout.bottomHeight)
  const [isDraggingBottom, setIsDraggingBottom]  = useState(false)
  const [summary,          setSummaryLocal]      = useState(null)
  const [selectedAnnotId,  setSelectedAnnotId]   = useState(null)
  // Database row selection and PDF occurrence selection are different IDs.
  // Keep both so the grid and SVG overlay can stay selected together.
  const [selectedViewerAnnotId, setSelectedViewerAnnotId] = useState(null)
  const [showExtractModal, setShowExtractModal]  = useState(false)
  const [measurementSections, setMeasurementSections] = useState([])
  const [sectionSelection, setSectionSelection] = useState(null)
  const [sectionSaving, setSectionSaving] = useState(false)
  const [sectionError, setSectionError] = useState('')
  const [activeSectionId, setActiveSectionId] = useState(null)
  const [focusedSectionId, setFocusedSectionId] = useState(null)
  const [editingSectionId, setEditingSectionId] = useState(null)
  const [bottomView, setBottomView] = useState('measurements')
  const sectionPlacementSavingRef = useRef(false)
  // Project resources load in parallel. Track when the drawing request has
  // completed so a slower schedule/section response can never repopulate
  // orphaned data after the project is confirmed to contain zero PDFs.
  const projectDrawingLoadRef = useRef({ projectId: null, loaded: false, count: 0 })
  const [detectedMemberPrompt, setDetectedMemberPrompt] = useState(null)
  const [detectedMemberSaving, setDetectedMemberSaving] = useState(false)
  const [detectedMemberError, setDetectedMemberError] = useState('')
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y } | null — right-click context menu
  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])

  // ── Bluebeam-style multi-select (for group copy/paste) ────────────────
  // Parallel to selectedAnnotId/selectedViewerAnnotId above, NOT a
  // replacement: every plain (non ctrl/shift) selection change keeps
  // writing those scalars exactly as before, and additionally collapses
  // these two Sets to match (solo member, or empty). Whenever a Set's size
  // is <=1, selectedAnnotId is always its sole member (or null) — so every
  // existing single-target consumer (resolveCopyTargetId, the style-persist
  // effect, wheel-resize, delete) keeps working unchanged; only the
  // copy/paste path branches on `.size > 1`.
  const [selectedAnnotIds, setSelectedAnnotIds] = useState(() => new Set())
  const [selectedViewerAnnotIds, setSelectedViewerAnnotIds] = useState(() => new Set())
  const selectedAnnotIdsRef = useRef(new Set())
  const selectedViewerAnnotIdsRef = useRef(new Set())

  const clearAllSelection = useCallback(() => {
    selectedOccurrenceAnnotIdRef.current = null
    setSelectedAnnotId(null)
    setSelectedViewerAnnotId(null)
    setStyleEditTargetId(null)
    annotStyleBaselineRef.current = null
    selectedAnnotIdsRef.current = new Set()
    selectedViewerAnnotIdsRef.current = new Set()
    setSelectedAnnotIds(new Set())
    setSelectedViewerAnnotIds(new Set())
  }, [])

  // Mobile panel drawer state
  const [sidebarOpen,  setSidebarOpen]  = useState(false)
  const [rightOpen,    setRightOpen]    = useState(false)

  // Desktop side panel open/hover state (independent of mobile)
  const [leftPanelOpen,  setLeftPanelOpen]  = useState(initialDockLayout.leftOpen)
  const [rightPanelOpen, setRightPanelOpen] = useState(initialDockLayout.rightOpen)
  const [leftPanelPinned, setLeftPanelPinned] = useState(initialDockLayout.leftPinned)
  const [rightPanelPinned, setRightPanelPinned] = useState(initialDockLayout.rightPinned)
  const [leftPanelTab, setLeftPanelTab] = useState(initialDockLayout.leftTab)
  const [leftPanelWidth, setLeftPanelWidth] = useState(initialDockLayout.leftWidth)
  const [rightPanelWidth, setRightPanelWidth] = useState(initialDockLayout.rightWidth)
  const [leftHovered,    setLeftHovered]    = useState(false)
  const [rightHovered,   setRightHovered]   = useState(false)
  const [isResizingLeft, setIsResizingLeft] = useState(false)
  const [isResizingRight, setIsResizingRight] = useState(false)
  const leftHoverTimer  = useRef(null)
  const rightHoverTimer = useRef(null)
  const bottomHoverTimer = useRef(null)
  const dockLayoutProjectIdRef = useRef(selectedProject?.id ?? null)
  const skipNextDockLayoutSaveRef = useRef(false)

  const annotationMapRef = useRef({})
  const selectedOccurrenceAnnotIdRef = useRef(null)
  const lastCopyTargetRef = useRef(null)
  const persistedAnnotIdsRef = useRef(new Set())
  const savingAnnotIdsRef = useRef(new Set())
  const geometrySaveTimersRef = useRef(new Map())
  const geometrySaveRevisionRef = useRef(new Map())
  // Maps an occurrence UUID to the row created when that copied occurrence is
  // first moved/resized. It prevents repeated pointer-move events from
  // creating more than one detached row while the first save is in flight.
  const geometryDetachmentsRef = useRef(new Map())
  const labelSizeSaveTimersRef = useRef(new Map())
  const measureReleaseRef = useRef(null)
  // Last auto-saved measurement — Clear removes it; mark reused on next draw after Clear
  const pendingMeasurementRef = useRef(null)
  const clearedMarkRef = useRef(null)
  const pendingCalibMeasureRef = useRef(null)
  const calibrateOnlyRef = useRef(false)
  // Calibrate can be armed first and Linear selected afterwards. Keep that
  // one-shot intent separate from activeTool so selecting Linear does not
  // silently fall back to the drawing's existing scale.
  const calibrationDrawPendingRef = useRef(false)
  const undoStackRef = useRef([])
  const redoStackRef = useRef([])
  const historyBusyRef = useRef(false)
  const detectedMemberResolverRef = useRef(null)
  const [undoDepth, setUndoDepth] = useState(0)
  const [redoDepth, setRedoDepth] = useState(0)

  const finishDetectedMemberPrompt = useCallback((member = null) => {
    const resolve = detectedMemberResolverRef.current
    detectedMemberResolverRef.current = null
    setDetectedMemberPrompt(null)
    setDetectedMemberSaving(false)
    setDetectedMemberError('')
    resolve?.(member)
  }, [])

  const requestDetectedMemberConfirmation = useCallback(({ detectedValue, drawingId }) => {
    if (detectedMemberResolverRef.current) {
      detectedMemberResolverRef.current(null)
      detectedMemberResolverRef.current = null
    }

    const currentItems = useAppStore.getState().memberScheduleItems ?? []
    return new Promise(resolve => {
      detectedMemberResolverRef.current = resolve
      setDetectedMemberSaving(false)
      setDetectedMemberError('')
      setDetectedMemberPrompt({
        detectedValue,
        drawingId,
        color: getNextDefaultMemberColor(currentItems),
      })
    })
  }, [])

  const handleAddDetectedMember = useCallback(async ({ mark, sectionSize }) => {
    const projectId = useAppStore.getState().selectedProject?.id
    if (!projectId || !detectedMemberPrompt) {
      setDetectedMemberError('No project is selected. Cancel and try again.')
      return
    }

    setDetectedMemberSaving(true)
    setDetectedMemberError('')
    try {
      let member
      try {
        member = await memberScheduleService.createForProject(projectId, {
          mark,
          memberSize: sectionSize,
          memberType: 'Other',
          quantity: 0,
          color: detectedMemberPrompt.color,
        })
        const liveItems = useAppStore.getState().memberScheduleItems ?? []
        if (!liveItems.some(item => Number(item.id) === Number(member.id))) {
          addMemberScheduleItem(member)
        }
      } catch (error) {
        // Another request may have added this exact Mark + Section while the
        // dialog was open. Reuse that project item instead of creating or
        // displaying a second copy.
        if (error?.response?.status !== 409) throw error
        const members = await memberScheduleService.getByProject(projectId)
        const markKey = normalizeMemberIdentityPart(mark)
        const sectionKey = normalizeMemberIdentityPart(sectionSize)
        const coloredMembers = assignMemberColors(members)
        member = coloredMembers.find(item =>
          normalizeMemberIdentityPart(item.mark) === markKey
          && normalizeMemberIdentityPart(item.memberSize) === sectionKey)
        if (!member) throw error
        setMemberScheduleItems(coloredMembers)
      }

      memberScheduleService.getProjectSummary(projectId)
        .then(setMemberScheduleSummary)
        .catch(() => {})
      setLeftPanelTab('members')
      setLeftPanelOpen(true)
      finishDetectedMemberPrompt(member)
    } catch (error) {
      setDetectedMemberSaving(false)
      setDetectedMemberError(
        error?.response?.data?.message
        ?? 'Could not add this item to the schedule. Please try again.',
      )
    }
  }, [
    addMemberScheduleItem,
    detectedMemberPrompt,
    finishDetectedMemberPrompt,
    setMemberScheduleItems,
    setMemberScheduleSummary,
  ])

  useEffect(() => () => {
    detectedMemberResolverRef.current?.(null)
    detectedMemberResolverRef.current = null
  }, [])

  const clearCopiedMeasurements = useCallback(() => {
    clearMeasurementClipboard()
    clearPasteAnchor()
    triggerPdfCommand({ type: 'cancelPastePlacement' })
  }, [clearMeasurementClipboard, clearPasteAnchor, triggerPdfCommand])

  // A copied measurement belongs only to the drawing it was copied from.
  // Clear both the toolbar clipboard and any active canvas paste session when
  // the drawing changes (including the first load after a browser refresh).
  useEffect(() => {
    calibrationDrawPendingRef.current = false
    geometryDetachmentsRef.current.clear()
    clearCopiedMeasurements()
  }, [selectedDrawing?.id, clearCopiedMeasurements])

  useEffect(() => {
    if (!['line', 'calibrate'].includes(activeTool)) {
      calibrationDrawPendingRef.current = false
    }
  }, [activeTool])

  // Also clear the in-memory clipboard when leaving/reloading this page. The
  // cleanup covers route changes; pagehide covers refresh and browser history.
  useEffect(() => {
    const handlePageExit = () => {
      clearMeasurementClipboard()
      clearPasteAnchor()
    }
    window.addEventListener('pagehide', handlePageExit)
    return () => {
      window.removeEventListener('pagehide', handlePageExit)
      handlePageExit()
    }
  }, [clearMeasurementClipboard, clearPasteAnchor])

  const captureHistorySnapshot = useCallback(() => {
    const state = useAppStore.getState()
    return {
      drawingId: state.selectedDrawing?.id ?? null,
      drawing: cloneHistoryValue(normalizeDrawing(state.selectedDrawing)),
      items: cloneHistoryValue(state.takeoffItems ?? []),
      clipboard: cloneHistoryValue(state.measurementClipboard ?? null),
    }
  }, [])

  const recordUndoSnapshot = useCallback((label, { groupKey = null } = {}) => {
    if (historyBusyRef.current) return null
    const drawingId = useAppStore.getState().selectedDrawing?.id
    if (!drawingId) return null
    const top = undoStackRef.current[undoStackRef.current.length - 1]
    if (groupKey && top?.groupKey === groupKey) return null
    const entry = {
      ...captureHistorySnapshot(),
      label,
      groupKey,
      token: `${Date.now()}-${Math.random()}`,
    }
    undoStackRef.current.push(entry)
    if (undoStackRef.current.length > 50) undoStackRef.current.shift()
    redoStackRef.current = []
    setUndoDepth(undoStackRef.current.length)
    setRedoDepth(0)
    return entry.token
  }, [captureHistorySnapshot])

  const discardUndoSnapshot = useCallback((token) => {
    if (!token) return
    const top = undoStackRef.current[undoStackRef.current.length - 1]
    if (top?.token !== token) return
    undoStackRef.current.pop()
    setUndoDepth(undoStackRef.current.length)
  }, [])

  useEffect(() => {
    undoStackRef.current = []
    redoStackRef.current = []
    setUndoDepth(0)
    setRedoDepth(0)
  }, [selectedDrawing?.id])

  const extractAnnotIdFromPointsJson = useCallback((pointsJson) => {
    return extractTakeoffAnnotationIds(pointsJson)[0] ?? null
  }, [])

  const resolveMeasurementDbId = useCallback((annotId) => {
    const pending = pendingMeasurementRef.current
    const annotationKey = annotId == null ? '' : String(annotId)
    if (!annotationKey) return pending?.dbId ?? null
    if (pending?.annotationId != null && String(pending.annotationId) === annotationKey) {
      return pending.dbId ?? null
    }
    const fromMap = Object.entries(annotationMapRef.current).find(([, v]) => {
      if (v.annotationId != null && String(v.annotationId) === annotationKey) return true
      return Array.isArray(v.annotationIds)
        && v.annotationIds.some(id => String(id) === annotationKey)
    })
    if (fromMap) return Number(fromMap[0])
    const items = useAppStore.getState().takeoffItems ?? []
    const item = items.find(t => extractTakeoffAnnotationIds(t.pointsJson)
      .some(id => String(id) === annotationKey))
    return item?.id ?? null
  }, [])

  // Shared by both ways to resize a label's font size: hovering it and
  // scrolling (PdfSvgOverlay, fires one payload per wheel tick), and clicking
  // a S/M/L/XL preset or typing a pt value in the toolbar while it's selected
  // (see the style-sync effect below). Routing both through the same
  // per-item debounce timer means whichever one changes the size LAST always
  // wins — without this they raced: a wheel tick's pending save could fire
  // after a toolbar click and silently overwrite it, or vice versa, making
  // it look like clicking S/M/L/XL "did nothing" right after using the wheel.
  const handleMeasurementLabelSizeChange = useCallback((payload) => {
    const annotId = payload?.annotationId
    const dbId = payload?.dbId ?? resolveMeasurementDbId(annotId)
    const size = Number(payload?.size)
    if (dbId == null || !Number.isFinite(size)) return

    // Instant feedback (store-level, so the grid/right panel update live too,
    // not just the canvas) — only the network save below is debounced.
    const currentItem = (useAppStore.getState().takeoffItems ?? []).find(t => t.id === dbId)
    if (!currentItem?.pointsJson) return
    const existingTimer = labelSizeSaveTimersRef.current.get(dbId)
    try {
      const raw = JSON.parse(currentItem.pointsJson)
      const applyLabelSize = geometry => ({
        ...geometry,
        labelUserFontSize: size,
        LabelUserFontSize: size,
      })
      let nextRaw = raw

      // Older pasted measurements may still live as separate occurrence
      // geometries inside one takeoff row. Update only the occurrence whose
      // annotation UUID was selected; independent/new pasted rows continue
      // through the ordinary flat-geometry branch below.
      if (annotId != null && Array.isArray(raw.occurrences) && raw.occurrences.length) {
        let matched = false
        const occurrences = raw.occurrences.map(occ => {
          const geometry = occ?.geometry ?? occ?.rawAnnotation ?? occ
          const occurrenceAnnotationId = occ?.annotationName ?? getRawAnnotationId(geometry)
          if (occurrenceAnnotationId == null
              || String(occurrenceAnnotationId) !== String(annotId)) return occ
          matched = true
          if (occ?.geometry) return { ...occ, geometry: applyLabelSize(occ.geometry) }
          if (occ?.rawAnnotation) return { ...occ, rawAnnotation: applyLabelSize(occ.rawAnnotation) }
          return applyLabelSize(occ)
        })
        if (matched) nextRaw = { ...raw, occurrences }
        else nextRaw = applyLabelSize(raw)
      } else {
        nextRaw = applyLabelSize(raw)
      }

      const pointsJson = JSON.stringify(nextRaw)
      if (pointsJson !== currentItem.pointsJson) {
        if (!existingTimer) recordUndoSnapshot('label resize')
        updateTakeoffItem({ ...currentItem, pointsJson })
      }
    } catch (_) { return }

    if (existingTimer) clearTimeout(existingTimer)

    const timer = setTimeout(async () => {
      labelSizeSaveTimersRef.current.delete(dbId)
      // Re-read at save time — picks up whatever the latest call (from either
      // source) optimistically wrote, not this particular call's own value.
      const item = (useAppStore.getState().takeoffItems ?? []).find(t => t.id === dbId)
      if (!item?.pointsJson) return
      try {
        const saved = await takeoffService.update(item)
        updateTakeoffItem(saved)
      } catch (err) {
        console.warn('[BuildTakeoff] measurement label size update failed:', err)
      }
    }, 400)

    labelSizeSaveTimersRef.current.set(dbId, timer)
  }, [recordUndoSnapshot, resolveMeasurementDbId, updateTakeoffItem])

  const parseLinkedItemId = useCallback((notes) => {
    const match = String(notes ?? '').match(/\blinkedItem:(\d+)/i)
    return match ? Number(match[1]) : null
  }, [])

  const countLinkedOccurrences = useCallback((items, rootItemId) => {
    const root = Number(rootItemId)
    if (!Number.isFinite(root)) return 0
    return (items ?? []).filter(item => {
      if (Number(item.id) === root) return true
      return parseLinkedItemId(item.notes) === root
    }).length
  }, [parseLinkedItemId])

  // Track style values at the moment an annotation is selected.
  // Used to detect when the user actually changes a style prop (vs. selecting an annotation
  // for the first time) so we only write to the DB on genuine style changes.
  const annotStyleBaselineRef = useRef(null)
  const pasteStyleOverrideRef = useRef(null)
  const blobSaveTimerRef = useRef(null)
  /** DB row user explicitly picked for toolbar style edits — not auto-selected after draw. */
  const [styleEditTargetId, setStyleEditTargetId] = useState(null)

  // Persist toolbar style changes when a measurement row is selected.
  useEffect(() => {
    if (!selectedAnnotId) {
      annotStyleBaselineRef.current = null
      return
    }
    const current = {
      color: measureColor, thickness: lineThickness, lineStyle, arrowStyle,
      labelFontSize: measureLabelFontSize,
    }

    if (annotStyleBaselineRef.current === null) {
      // First render after annotation selection — snapshot the baseline, no DB write
      annotStyleBaselineRef.current = current
      return
    }

    const prev = annotStyleBaselineRef.current
    const styleChanged =
      prev.color !== current.color ||
      prev.thickness !== current.thickness ||
      prev.lineStyle !== current.lineStyle ||
      prev.arrowStyle !== current.arrowStyle
    const labelSizeChanged = prev.labelFontSize !== current.labelFontSize

    if (!styleChanged && !labelSizeChanged) return
    annotStyleBaselineRef.current = current
    const selectedRowIds = selectedAnnotIdsRef.current.size
      ? [...selectedAnnotIdsRef.current]
      : [selectedAnnotId]
    const selectedOccurrenceIds = new Set(
      [...selectedViewerAnnotIdsRef.current].map(String),
    )
    const isBulkSelection = selectedRowIds.length > 1 || selectedOccurrenceIds.size > 1

    // Label size shares the same debounced pipeline as hover+scroll resize —
    // see handleMeasurementLabelSizeChange for why (avoids the two racing).
    if (labelSizeChanged) {
      if (isBulkSelection) {
        const liveItems = useAppStore.getState().takeoffItems ?? []
        selectedRowIds.forEach(dbId => {
          const row = liveItems.find(item => Number(item.id) === Number(dbId))
          const occurrences = buildTakeoffOccurrencesFromItem(row)
            .filter(occurrence =>
              selectedOccurrenceIds.has(String(occurrence.annotationName)),
            )
          if (occurrences.length) {
            occurrences.forEach(occurrence => {
              handleMeasurementLabelSizeChange({
                annotationId: occurrence.annotationName,
                dbId: row.id,
                size: current.labelFontSize,
              })
            })
          } else {
            handleMeasurementLabelSizeChange({
              annotationId: dbId === selectedAnnotId
                ? selectedOccurrenceAnnotIdRef.current
                : null,
              dbId,
              size: current.labelFontSize,
            })
          }
        })
      } else {
        handleMeasurementLabelSizeChange({
          annotationId: selectedOccurrenceAnnotIdRef.current,
          dbId: selectedAnnotId,
          size: current.labelFontSize,
        })
      }
    }
    if (!styleChanged) return

    // Re-read live (not the `takeoffItems` this render closed over) in case
    // the label-size call just above already updated this same item's
    // pointsJson — using a stale snapshot here would silently revert it.
    const item = (useAppStore.getState().takeoffItems ?? []).find(t => t.id === selectedAnnotId)
    if (!item) return

    if (!labelSizeChanged) recordUndoSnapshot('measurement style change')
    const arrowPatch = mapLinearArrowStyle(arrowStyle)
    const patchGeometry = geometry => ({
      ...geometry,
      strokeColor: measureColor,
      StrokeColor: measureColor,
      thickness: lineThickness,
      Thickness: lineThickness,
      lineStyle,
      LineStyle: lineStyle,
      borderDashArray: lineStyle === 'solid'
        ? '0'
        : (geometry.borderDashArray ?? geometry.BorderDashArray ?? '6,3'),
      BorderDashArray: lineStyle === 'solid'
        ? '0'
        : (geometry.BorderDashArray ?? geometry.borderDashArray ?? '6,3'),
      ...arrowPatch,
      LineHeadStartStyle: arrowPatch.lineHeadStartStyle,
      LineHeadEndStyle: arrowPatch.lineHeadEndStyle,
    })
    if (isBulkSelection) {
      const liveItems = useAppStore.getState().takeoffItems ?? []
      selectedRowIds.forEach(dbId => {
        const liveItem = liveItems.find(item => Number(item.id) === Number(dbId))
        if (!liveItem) return
        const occurrences = buildTakeoffOccurrencesFromItem(liveItem)
        const selectedOccurrences = occurrences.filter(occurrence =>
          selectedOccurrenceIds.has(String(occurrence.annotationName)),
        )
        let optimistic = liveItem

        if (selectedOccurrences.length) {
          selectedOccurrences.forEach(occurrence => {
            optimistic = updateTakeoffOccurrence(
              optimistic,
              occurrence.annotationName,
              currentOccurrence => ({
                ...currentOccurrence,
                geometry: patchGeometry(currentOccurrence.geometry),
              }),
            ) ?? optimistic
          })
        } else {
          const raw = readTakeoffPointsJson(liveItem.pointsJson)
          optimistic = {
            ...liveItem,
            pointsJson: raw ? JSON.stringify(patchGeometry(raw)) : liveItem.pointsJson,
          }
        }

        if (!occurrences.length || selectedOccurrences.length === occurrences.length) {
          optimistic = {
            ...optimistic,
            color: measureColor,
            category: measureCategory,
          }
        }
        updateTakeoffItem(optimistic)
        takeoffService.update(optimistic)
          .then(saved => updateTakeoffItem(saved))
          .catch(() => {})
      })
      return
    }
    const occurrenceId = selectedOccurrenceAnnotIdRef.current
    const occurrenceUpdate = updateTakeoffOccurrence(item, occurrenceId, occurrence => ({
      ...occurrence,
      geometry: patchGeometry(occurrence.geometry),
    }))
    let optimistic = occurrenceUpdate
    if (!optimistic) {
      const raw = readTakeoffPointsJson(item.pointsJson)
      optimistic = {
        ...item,
        color: measureColor,
        category: measureCategory,
        pointsJson: raw ? JSON.stringify(patchGeometry(raw)) : item.pointsJson,
      }
    }
    updateTakeoffItem(optimistic)
    takeoffService.update(optimistic)
      .then(saved => updateTakeoffItem(saved))
      .catch(() => {})
  }, [measureColor, measureCategory, lineStyle, arrowStyle, measureLabelFontSize, selectedAnnotId, selectedAnnotIds, selectedViewerAnnotIds, styleEditTargetId, handleMeasurementLabelSizeChange, recordUndoSnapshot, updateTakeoffItem])  // eslint-disable-line react-hooks/exhaustive-deps

  // Zooming in/out auto-deselects the current measurement — otherwise it stays
  // selected (and wheel keeps resizing its label, see PdfSvgOverlay) even
  // after the user has moved on to just looking around the drawing at a
  // different zoom level. Skips the very first render so loading a drawing
  // (which sets an initial fit-to-width scale) doesn't clear a selection that
  // was restored/made before the scale settled.
  const prevPdfScaleRef = useRef(pdfScale)
  useEffect(() => {
    if (prevPdfScaleRef.current === pdfScale) return
    prevPdfScaleRef.current = pdfScale
    if (!selectedAnnotId && !selectedViewerAnnotId && selectedAnnotIds.size === 0) return
    clearAllSelection()
  }, [pdfScale, selectedAnnotId, selectedViewerAnnotId, selectedAnnotIds, clearAllSelection])

  // Close mobile drawers on route change or desktop switch
  useEffect(() => {
    if (!isMobile) { setSidebarOpen(false); setRightOpen(false) }
  }, [isMobile])

  useEffect(() => {
    const projectId = selectedProject?.id
    if (!projectId || dockLayoutProjectIdRef.current === projectId) return

    const layout = readDockLayout(projectId, isMobile, isTablet)
    dockLayoutProjectIdRef.current = projectId
    skipNextDockLayoutSaveRef.current = true
    setLeftPanelTab(layout.leftTab)
    setLeftPanelOpen(layout.leftOpen)
    setLeftPanelPinned(layout.leftPinned)
    setLeftPanelWidth(layout.leftWidth)
    setRightPanelOpen(layout.rightOpen)
    setRightPanelPinned(layout.rightPinned)
    setRightPanelWidth(layout.rightWidth)
    setShowBottom(layout.bottomOpen)
    setBottomPinned(layout.bottomPinned)
    setBottomH(layout.bottomHeight)
    setLeftHovered(false)
    setRightHovered(false)
    setBottomHovered(false)
  }, [selectedProject?.id, isMobile, isTablet])

  useEffect(() => {
    if (!selectedProject?.id || typeof window === 'undefined') return
    if (skipNextDockLayoutSaveRef.current) {
      skipNextDockLayoutSaveRef.current = false
      return
    }
    const layout = {
      version: DOCK_LAYOUT_VERSION,
      leftTab: leftPanelTab,
      leftOpen: leftPanelOpen,
      leftPinned: leftPanelPinned,
      leftWidth: leftPanelWidth,
      rightOpen: rightPanelOpen,
      rightPinned: rightPanelPinned,
      rightWidth: rightPanelWidth,
      bottomOpen: showBottom,
      bottomPinned,
      bottomHeight: bottomH,
    }
    localStorage.setItem(`buildtakeoff:workspace:${selectedProject.id}`, JSON.stringify(layout))
  }, [
    selectedProject?.id,
    leftPanelTab, leftPanelOpen, leftPanelPinned, leftPanelWidth,
    rightPanelOpen, rightPanelPinned, rightPanelWidth,
    showBottom, bottomPinned, bottomH,
  ])

  useEffect(() => () => {
    clearTimeout(leftHoverTimer.current)
    clearTimeout(rightHoverTimer.current)
    clearTimeout(bottomHoverTimer.current)
  }, [])

  useEffect(() => {
    const clampLayoutToViewport = () => {
      const leftMax = getLeftDockMaxWidth(window.innerWidth)
      const rightMax = Math.max(250, Math.floor(window.innerWidth * 0.4))
      const bottomMax = Math.max(180, Math.floor(window.innerHeight * 0.68))
      setLeftPanelWidth(width => clampDockSize(width, LEFT_DOCK_MIN_WIDTH, leftMax, LEFT_DOCK_DEFAULT_WIDTH))
      setRightPanelWidth(width => clampDockSize(width, 250, rightMax, 280))
      setBottomH(height => clampDockSize(height, 180, bottomMax, 260))
    }

    window.addEventListener('resize', clampLayoutToViewport)
    return () => window.removeEventListener('resize', clampLayoutToViewport)
  }, [])

  useEffect(() => {
    if (!_hydrated) return
    if (!selectedProject) navigate('/dashboard')
  }, [_hydrated, selectedProject])

  useEffect(() => {
    if (!selectedProject) return
    let cancelled = false
    const projectId = Number(selectedProject.id)
    projectDrawingLoadRef.current = { projectId, loaded: false, count: 0 }
    setSelectedDrawing(null)
    setDrawings([])
    setMemberScheduleItems([])
    setMemberScheduleSummary(null)
    setMeasurementSections([])
    setSectionSelection(null)
    setActiveSectionId(null)
    setFocusedSectionId(null)
    setEditingSectionId(null)
    setBottomView('measurements')
    useAppStore.getState().clearSelectedMemberScheduleItem?.()
    drawingService.getByProject(selectedProject.id)
      .then(data => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : (data ? [data] : [])
        const normalized = list.map(normalizeDrawing).filter(Boolean)
        projectDrawingLoadRef.current = { projectId, loaded: true, count: normalized.length }
        setDrawings(normalized)
        if (normalized.length > 0) {
          setSelectedDrawing(normalized[0])
        } else {
          // A project with no PDFs cannot own visible measurements, schedule
          // members, or reusable sections. This also protects the UI while an
          // older backend deployment is being upgraded and still returns
          // legacy orphan rows.
          setMemberScheduleItems([])
          setMemberScheduleSummary(null)
          setMeasurementSections([])
          setSectionSelection(null)
          setActiveSectionId(null)
          setFocusedSectionId(null)
          setEditingSectionId(null)
          persistSectionReview(selectedProject.id, null)
        }
      })
      .catch(() => { if (!cancelled) toast.error('Failed to load drawings') })
    return () => { cancelled = true }
  }, [selectedProject?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // Section Measurement groups are project-level. Loading them independently
  // keeps the existing drawing/takeoff/member-schedule requests unchanged and
  // lets a saved group remain available as the user moves between PDFs.
  useEffect(() => {
    if (!selectedProject?.id) {
      setMeasurementSections([])
      return
    }
    let cancelled = false
    measurementSectionService.getByProject(selectedProject.id)
      .then(sections => {
        if (cancelled) return
        const drawingState = projectDrawingLoadRef.current
        if (drawingState.projectId === Number(selectedProject.id) &&
            drawingState.loaded && drawingState.count === 0) {
          setMeasurementSections([])
          return
        }
        const list = Array.isArray(sections) ? sections : []
        setMeasurementSections(list)
        const persistedSectionId = readPersistedSectionReview(selectedProject.id)
        if (persistedSectionId && list.some(section => Number(section.id) === persistedSectionId)) {
          setFocusedSectionId(persistedSectionId)
        } else if (persistedSectionId) {
          persistSectionReview(selectedProject.id, null)
        }
      })
      .catch(() => {
        if (!cancelled) toast.error('Failed to load project measurement sections')
      })
    return () => { cancelled = true }
  }, [selectedProject?.id])

  // The member schedule belongs to the project, so it is loaded once per
  // project and remains available while users move between that project's PDFs.
  useEffect(() => {
    if (!selectedProject?.id) {
      setMemberScheduleItems([])
      setMemberScheduleSummary(null)
      return
    }

    let cancelled = false
    Promise.all([
      memberScheduleService.getByProject(selectedProject.id),
      memberScheduleService.getProjectSummary(selectedProject.id),
    ])
      .then(([members, memberSum]) => {
        if (cancelled) return
        const drawingState = projectDrawingLoadRef.current
        if (drawingState.projectId === Number(selectedProject.id) &&
            drawingState.loaded && drawingState.count === 0) {
          setMemberScheduleItems([])
          setMemberScheduleSummary(null)
          return
        }
        setMemberScheduleItems(assignMemberColors(members))
        setMemberScheduleSummary(memberSum)
      })
      .catch(() => {
        if (!cancelled) toast.error('Failed to load project member schedule')
      })

    return () => { cancelled = true }
  }, [selectedProject?.id, setMemberScheduleItems, setMemberScheduleSummary])

  // Reload saved calibration from DB whenever the active drawing changes (Bluebeam-style persistence).
  useEffect(() => {
    if (!selectedDrawing?.id) return
    let cancelled = false
    drawingService.getById(selectedDrawing.id)
      .then(data => {
        if (cancelled) return
        const norm = normalizeDrawing(data)
        if (!norm) return
        traceCalibration('drawing.select.loaded', calibrationSnapshot(norm))
        setSelectedDrawing(norm)
        setDrawings(prev => {
          const list = Array.isArray(prev) ? prev : []
          if (list.some(d => d.id === norm.id)) {
            return list.map(d => (d.id === norm.id ? norm : normalizeDrawing(d)))
          }
          return [...list, norm]
        })
        triggerPdfCommand('refreshCalibration')
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedDrawing?.id, triggerPdfCommand])

  useEffect(() => {
    if (!selectedDrawing) {
      setTakeoffItems([])
      setSummaryLocal(null)
      annotationMapRef.current = {}
      persistedAnnotIdsRef.current = new Set()
      pendingMeasurementRef.current = null
      clearedMarkRef.current = null
      return
    }
    pendingMeasurementRef.current = null
    clearedMarkRef.current = null
    Promise.all([
      takeoffService.getByDrawing(selectedDrawing.id),
      takeoffService.getSummary(selectedDrawing.id),
    ])
      .then(async ([items, sum]) => {
        const drw = getCalibratedDrawingFromStore()
        const { activeUnit } = useAppStore.getState()
        const needsFix = drw?.isCalibrated && items.some(
          i => (i.itemType || 'Line') === 'Line' && (/not calibrated/i.test(i.description ?? '') || i.length == null),
        )
        let finalItems = items
        if (needsFix) {
          finalItems = await recalculateTakeoffItemsAfterCalibration(
            items,
            drw,
            activeUnit ?? drw.calibrationUnit ?? 'Mm',
            (item) => takeoffService.update(item),
            (saved) => updateTakeoffItem(saved),
          )
          triggerPdfCommand('rehydrateMeasureLabels')
        }
        const consolidation = await consolidateLegacyLinkedTakeoffRows(finalItems)
        finalItems = consolidation.items
        const normalization = await normalizeGroupedTakeoffRows(finalItems)
        finalItems = normalization.items
        const finalSummary = consolidation.changed || normalization.changed
          ? await takeoffService.getSummary(selectedDrawing.id).catch(() => sum)
          : sum
        setTakeoffItems(finalItems)
        setSummaryLocal(finalSummary)
        setSummary(finalSummary)
        const index = buildTakeoffAnnotationIndex(finalItems)
        annotationMapRef.current = index.map
        persistedAnnotIdsRef.current = index.persistedIds
      })
      .catch(() => toast.error('Failed to load drawing data'))
  }, [selectedDrawing?.id, updateTakeoffItem, triggerPdfCommand])

  const deletePendingMeasurement = useCallback(async (pending, { silent = false } = {}) => {
    if (!pending || persistedAnnotIdsRef.current.has(pending.annotationId)) return false
    const undoToken = recordUndoSnapshot('clear measurement')
    try {
      await takeoffService.delete(pending.dbId)
      removeTakeoffItem(pending.dbId)
      delete annotationMapRef.current[pending.dbId]
      triggerPdfCommand({
        type: 'deleteAnnotation',
        annotationId: pending.annotationId,
        pageNumber: pending.pageNumber ?? 1,
      })
      if (selectedAnnotId === pending.dbId) setSelectedAnnotId(null)
      if (String(selectedViewerAnnotId) === String(pending.annotationId)) {
        setSelectedViewerAnnotId(null)
        selectedOccurrenceAnnotIdRef.current = null
      }
      if (pendingMeasurementRef.current?.dbId === pending.dbId) {
        pendingMeasurementRef.current = null
      }
      if (selectedDrawing) {
        takeoffService.getSummary(selectedDrawing.id)
          .then(sum => { setSummaryLocal(sum); setSummary(sum) })
          .catch(() => {})
      }
      if (!silent) toast.success('Cleared measurement')
      return true
    } catch {
      discardUndoSnapshot(undoToken)
      if (!silent) toast.error('Failed to clear measurement')
      return false
    }
  }, [discardUndoSnapshot, recordUndoSnapshot, removeTakeoffItem, selectedAnnotId, selectedDrawing, selectedViewerAnnotId, setSummary, triggerPdfCommand])

  const scheduleAnnotationBlobSave = useCallback(() => {
    if (blobSaveTimerRef.current) clearTimeout(blobSaveTimerRef.current)
    blobSaveTimerRef.current = setTimeout(() => {
      triggerPdfCommand('saveAnnotationBlob')
    }, 1500)
  }, [triggerPdfCommand])

  const restoreHistorySnapshot = useCallback(async (snapshot) => {
    const drawingId = Number(snapshot?.drawingId)
    const liveDrawingId = Number(useAppStore.getState().selectedDrawing?.id)
    if (!drawingId || drawingId !== liveDrawingId) {
      throw new Error('Undo history belongs to a different drawing')
    }

    if (blobSaveTimerRef.current) {
      clearTimeout(blobSaveTimerRef.current)
      blobSaveTimerRef.current = null
    }
    geometrySaveTimersRef.current.forEach(timer => clearTimeout(timer))
    geometrySaveTimersRef.current.clear()
    geometrySaveRevisionRef.current.clear()
    geometryDetachmentsRef.current.clear()
    labelSizeSaveTimersRef.current.forEach(timer => clearTimeout(timer))
    labelSizeSaveTimersRef.current.clear()

    const targetDrawing = normalizeDrawing(snapshot.drawing)
    const currentDrawing = normalizeDrawing(useAppStore.getState().selectedDrawing)
    let restoredDrawing = currentDrawing
    const targetCalibrated = Boolean(targetDrawing?.isCalibrated && Number(targetDrawing?.scaleRatio) > 0)
    const calibrationChanged = targetCalibrated !== Boolean(currentDrawing?.isCalibrated)
      || Number(targetDrawing?.scaleRatio ?? 0) !== Number(currentDrawing?.scaleRatio ?? 0)
      || String(targetDrawing?.calibrationUnit ?? '') !== String(currentDrawing?.calibrationUnit ?? '')

    if (calibrationChanged) {
      restoredDrawing = targetCalibrated
        ? await drawingService.calibrate(drawingId, targetDrawing.scaleRatio, targetDrawing.calibrationUnit ?? 'Mm')
        : await drawingService.resetCalibration(drawingId)
    } else {
      restoredDrawing = normalizeDrawing(await drawingService.getById(drawingId))
    }

    const currentItems = await takeoffService.getByDrawing(drawingId)
    const targetItems = Array.isArray(snapshot.items) ? snapshot.items : []
    const currentById = new Map(currentItems.map(item => [Number(item.id), item]))
    const targetById = new Map(targetItems.map(item => [Number(item.id), item]))

    for (const item of currentItems) {
      if (!targetById.has(Number(item.id))) await takeoffService.delete(item.id)
    }

    for (const item of targetItems) {
      if (currentById.has(Number(item.id))) {
        if (!takeoffItemsMatch(currentById.get(Number(item.id)), item)) {
          await takeoffService.update(item)
        }
      } else {
        await takeoffService.restore(item)
      }
    }

    const [restoredItems, restoredSummary] = await Promise.all([
      takeoffService.getByDrawing(drawingId),
      takeoffService.getSummary(drawingId),
    ])
    const normalizedDrawing = normalizeDrawing(restoredDrawing)
    setSelectedDrawing(normalizedDrawing)
    setDrawings(prev => {
      const list = Array.isArray(prev) ? prev : []
      return list.map(d => Number(d.id) === drawingId ? normalizedDrawing : normalizeDrawing(d))
    })
    if (normalizedDrawing?.calibrationUnit) setActiveUnit(normalizedDrawing.calibrationUnit)
    setTakeoffItems(restoredItems)
    setSummaryLocal(restoredSummary)
    setSummary(restoredSummary)
    setMeasurementClipboard(cloneHistoryValue(snapshot.clipboard ?? null))

    const index = buildTakeoffAnnotationIndex(restoredItems)
    annotationMapRef.current = index.map
    persistedAnnotIdsRef.current = index.persistedIds
    pendingMeasurementRef.current = null
    clearAllSelection()
    triggerPdfCommand({
      type: 'historyRestored',
      annotationIds: [...index.persistedIds],
    })
    setTimeout(() => triggerPdfCommand('rehydrateMeasureLabels'), 100)
  }, [
    clearAllSelection,
    setActiveUnit,
    setDrawings,
    setMeasurementClipboard,
    setSelectedDrawing,
    setSummary,
    setTakeoffItems,
    triggerPdfCommand,
  ])

  const handleUndo = useCallback(async () => {
    if (historyBusyRef.current || undoStackRef.current.length === 0) return
    const target = undoStackRef.current.pop()
    const redoEntry = {
      ...captureHistorySnapshot(),
      label: target.label,
      groupKey: target.groupKey,
      token: `${Date.now()}-${Math.random()}`,
    }
    historyBusyRef.current = true
    setUndoDepth(undoStackRef.current.length)
    try {
      await restoreHistorySnapshot(target)
      redoStackRef.current.push(redoEntry)
      setRedoDepth(redoStackRef.current.length)
      toast.success(`Undid ${target.label}`, { duration: 1800 })
    } catch (error) {
      undoStackRef.current.push(target)
      setUndoDepth(undoStackRef.current.length)
      console.error('[BuildTakeoff] undo failed:', error)
      toast.error('Undo could not be completed — please try again')
    } finally {
      historyBusyRef.current = false
    }
  }, [captureHistorySnapshot, restoreHistorySnapshot])

  const handleRedo = useCallback(async () => {
    if (historyBusyRef.current || redoStackRef.current.length === 0) return
    const target = redoStackRef.current.pop()
    const undoEntry = {
      ...captureHistorySnapshot(),
      label: target.label,
      groupKey: target.groupKey,
      token: `${Date.now()}-${Math.random()}`,
    }
    historyBusyRef.current = true
    setRedoDepth(redoStackRef.current.length)
    try {
      await restoreHistorySnapshot(target)
      undoStackRef.current.push(undoEntry)
      setUndoDepth(undoStackRef.current.length)
      toast.success(`Redid ${target.label}`, { duration: 1800 })
    } catch (error) {
      redoStackRef.current.push(target)
      setRedoDepth(redoStackRef.current.length)
      console.error('[BuildTakeoff] redo failed:', error)
      toast.error('Redo could not be completed — please try again')
    } finally {
      historyBusyRef.current = false
    }
  }, [captureHistorySnapshot, restoreHistorySnapshot])

  useEffect(() => () => {
    if (blobSaveTimerRef.current) clearTimeout(blobSaveTimerRef.current)
    geometrySaveTimersRef.current.forEach(t => clearTimeout(t))
    geometrySaveTimersRef.current.clear()
    geometrySaveRevisionRef.current.clear()
    geometryDetachmentsRef.current.clear()
    labelSizeSaveTimersRef.current.forEach(t => clearTimeout(t))
    labelSizeSaveTimersRef.current.clear()
  }, [])

  const pickMeasureTool = useCallback((toolId) => {
    setEditingSectionId(null)
    if (toolId === 'section') {
      setActiveSectionId(null)
      setSectionSelection(null)
      setSectionError('')
      setBottomView('sections')
      setShowBottom(true)
      setBottomPinned(true)
      clearAllSelection()
    } else {
      setActiveSectionId(null)
    }
    if (toolId === 'calibrate') {
      calibrationDrawPendingRef.current = true
    } else if (toolId !== 'line') {
      calibrationDrawPendingRef.current = false
    }
    // Linear must stay visibly active whenever the user selects it. On an
    // uncalibrated drawing we arm the one-shot calibration flow separately;
    // the completed line still opens the scale dialog, but the toolbar does
    // not misleadingly switch the active command to Calibrate.
    if (toolId === 'line') {
      const drw = normalizeDrawing(useAppStore.getState().selectedDrawing)
      if (drw && !drw.isCalibrated) {
        calibrationDrawPendingRef.current = true
      }
      // Reset the thickness override to its default (2) each time Linear is picked, rather
      // than carrying over whatever value was last manually set — the override button row
      // still lets the user change it for that session same as before.
      setLineThickness(2)
    }
    setActiveTool(toolId)
    triggerPdfCommand('ensureMeasureMode')
  }, [clearAllSelection, setActiveTool, triggerPdfCommand, setLineThickness])

  const activeMeasurementSection = useMemo(
    () => measurementSections.find(section => Number(section.id) === Number(activeSectionId)) ?? null,
    [activeSectionId, measurementSections],
  )

  const focusedMeasurementSection = useMemo(
    () => measurementSections.find(section => Number(section.id) === Number(focusedSectionId)) ?? null,
    [focusedSectionId, measurementSections],
  )

  const editingMeasurementSection = useMemo(
    () => measurementSections.find(section => Number(section.id) === Number(editingSectionId)) ?? null,
    [editingSectionId, measurementSections],
  )

  const visibleSectionFocus = useMemo(() => {
    if (!focusedMeasurementSection
      || Number(focusedMeasurementSection.sourceDrawingId) !== Number(selectedDrawing?.id)) return null
    const template = readMeasurementSectionTemplate(focusedMeasurementSection)
    const sourcePlacement = (focusedMeasurementSection.placements ?? [])
      .find(placement => placement.isSource)
    return {
      id: focusedMeasurementSection.id,
      name: focusedMeasurementSection.name,
      pageNumber: Number(focusedMeasurementSection.sourcePageNumber ?? sourcePlacement?.pageNumber ?? 1) || 1,
      xRatio: Number(sourcePlacement?.xRatio ?? .5),
      yRatio: Number(sourcePlacement?.yRatio ?? .5),
      widthRatio: Number(template?.bounds?.widthRatio ?? 0),
      heightRatio: Number(template?.bounds?.heightRatio ?? 0),
      measurementCount: Number(focusedMeasurementSection.measurementCount ?? template?.measurements?.length ?? 0),
      editing: Number(focusedMeasurementSection.id) === Number(editingSectionId),
    }
  }, [editingSectionId, focusedMeasurementSection, selectedDrawing?.id])

  useEffect(() => {
    if (activeTool !== 'section' && activeSectionId != null) setActiveSectionId(null)
  }, [activeSectionId, activeTool])

  const visibleSectionPlacements = useMemo(() => {
    const drawingId = Number(selectedDrawing?.id)
    // Section markers are an interaction aid, not permanent PDF markup.
    // Keep the drawing clean during normal viewing. Show counted locations
    // either while placing the section or while the user explicitly reviews
    // it with the Eye action. A second Eye click clears focusedSectionId and
    // hides every marker again.
    const visibleSectionId = activeTool === 'section'
      ? activeSectionId
      : focusedSectionId
    if (!drawingId || !visibleSectionId) return []
    return measurementSections
      .filter(section => Number(section.id) === Number(visibleSectionId))
      .flatMap(section => {
        const placements = section.placements ?? []
        return placements
          .map((placement, index) => ({
            ...placement,
            sectionId: section.id,
            sectionName: section.name,
            placeNumber: index + 1,
            placeCount: placements.length,
          }))
          .filter(placement => Number(placement.drawingId) === drawingId)
      })
  }, [activeSectionId, activeTool, focusedSectionId, measurementSections, selectedDrawing?.id])

  const startSectionSelection = useCallback(() => {
    setActiveSectionId(null)
    setFocusedSectionId(null)
    setEditingSectionId(null)
    setSectionSelection(null)
    setSectionError('')
    setBottomView('sections')
    setShowBottom(true)
    setBottomPinned(true)
    clearAllSelection()
    setActiveTool('section')
  }, [clearAllSelection, setActiveTool])

  const handleSectionSelection = useCallback((selection) => {
    if (!selection?.annotations?.length) {
      toast.error('No measurements were found inside that rectangle')
      return
    }
    setSectionError('')
    setSectionSelection(selection)
    setBottomView('sections')
    setShowBottom(true)
  }, [])

  const saveMeasurementSection = useCallback(async (name) => {
    const projectId = Number(useAppStore.getState().selectedProject?.id)
    const drawingId = Number(useAppStore.getState().selectedDrawing?.id)
    const selection = sectionSelection
    if (!projectId || !drawingId || !selection?.annotations?.length) return

    const { bounds, pageSize, center } = selection
    const width = Math.max(.000001, Number(bounds.width))
    const height = Math.max(.000001, Number(bounds.height))
    const template = {
      version: 1,
      bounds: {
        widthRatio: width / Math.max(1, pageSize.width),
        heightRatio: height / Math.max(1, pageSize.height),
      },
      measurements: selection.annotations.map(annotation => ({
        sourceTakeoffItemId: annotation.dbId,
        sourceAnnotationId: annotation.id,
        type: annotation.type,
        relativePoints: (annotation.points ?? []).map(point => ({
          x: (Number(point.x) - bounds.left) / width,
          y: (Number(point.y) - bounds.top) / height,
        })),
        mark: annotation.mark,
        length: annotation.value,
        unit: annotation.unit,
        color: annotation.color,
        thickness: annotation.thickness,
        opacity: annotation.opacity,
        lineStyle: annotation.lineStyle,
        labelFontSize: annotation.labelFontSize,
        rawAnnotation: annotation.raw,
        properties: {
          itemType: annotation.item?.itemType,
          material: annotation.item?.material,
          description: annotation.item?.description,
          category: annotation.item?.category,
          quantity: annotation.item?.quantity,
          unitWeight: annotation.item?.unitWeight,
          totalWeight: annotation.item?.totalWeight,
          notes: annotation.item?.notes,
        },
      })),
    }

    setSectionSaving(true)
    setSectionError('')
    try {
      if (editingSectionId) {
        const updated = await measurementSectionService.updateTemplate(editingSectionId, {
          name,
          templateJson: JSON.stringify(template),
          measurementCount: selection.annotations.length,
          sourcePageNumber: selection.pageNumber,
          sourceXRatio: center.x / Math.max(1, pageSize.width),
          sourceYRatio: center.y / Math.max(1, pageSize.height),
        })
        setMeasurementSections(current => current
          .map(section => Number(section.id) === Number(updated.id) ? updated : section)
          .sort((left, right) => String(left.name).localeCompare(String(right.name))))
        setSectionSelection(null)
        setEditingSectionId(null)
        setFocusedSectionId(updated.id)
        setActiveSectionId(null)
        setActiveTool('select')
        setBottomView('sections')
        toast.success(`${updated.name} updated — counted places were preserved`)
        return
      }
      const saved = await measurementSectionService.create(projectId, {
        name,
        templateJson: JSON.stringify(template),
        measurementCount: selection.annotations.length,
        sourceDrawingId: drawingId,
        sourcePageNumber: selection.pageNumber,
        sourceXRatio: center.x / Math.max(1, pageSize.width),
        sourceYRatio: center.y / Math.max(1, pageSize.height),
      })
      setMeasurementSections(current => [...current, saved]
        .sort((left, right) => String(left.name).localeCompare(String(right.name))))
      setSectionSelection(null)
      setActiveSectionId(saved.id)
      setActiveTool('section')
      setBottomView('sections')
      toast.success(`${saved.name} saved — click each place where it occurs`)
    } catch (error) {
      setSectionError(
        error?.response?.data?.message
        ?? error?.response?.data?.errors?.[0]
        ?? 'Could not save this section. Please try again.',
      )
    } finally {
      setSectionSaving(false)
    }
  }, [editingSectionId, sectionSelection, setActiveTool])

  const handleSectionPlacement = useCallback(async (placement) => {
    const sectionId = Number(placement?.sectionId ?? activeSectionId)
    const drawingId = Number(useAppStore.getState().selectedDrawing?.id)
    if (!sectionId || !drawingId || sectionPlacementSavingRef.current) return
    sectionPlacementSavingRef.current = true
    try {
      const updated = await measurementSectionService.addPlacement(sectionId, {
        drawingId,
        pageNumber: placement.pageNumber,
        xRatio: placement.xRatio,
        yRatio: placement.yRatio,
      })
      setMeasurementSections(current => current.map(section =>
        Number(section.id) === sectionId ? updated : section))
    } catch (error) {
      toast.error(error?.response?.data?.message ?? 'Could not count this section location')
    } finally {
      sectionPlacementSavingRef.current = false
    }
  }, [activeSectionId])

  const activateMeasurementSection = useCallback((section) => {
    setSectionSelection(null)
    setEditingSectionId(null)
    setActiveSectionId(section.id)
    setFocusedSectionId(section.id)
    setBottomView('sections')
    setShowBottom(true)
    setBottomPinned(true)
    clearAllSelection()
    setActiveTool('section')
  }, [clearAllSelection, setActiveTool])

  const viewMeasurementSectionSource = useCallback((section) => {
    // The Eye action is a real visibility toggle. If this section is already
    // focused, a second click clears both the boundary focus and the grouped
    // measurement selections without navigating or changing the PDF again.
    if (Number(focusedSectionId) === Number(section?.id)) {
      clearAllSelection()
      setFocusedSectionId(null)
      persistSectionReview(useAppStore.getState().selectedProject?.id, null)
      setEditingSectionId(null)
      setActiveSectionId(null)
      setActiveTool('select')
      return
    }

    const sourceDrawing = drawings.find(drawing => Number(drawing.id) === Number(section?.sourceDrawingId))
    if (!sourceDrawing) {
      toast.error('The source PDF for this section is no longer available in the project')
      return
    }

    const template = readMeasurementSectionTemplate(section)
    const measurements = Array.isArray(template?.measurements) ? template.measurements : []
    const viewerIds = new Set(measurements
      .map(measurement => measurement?.sourceAnnotationId)
      .filter(id => id != null)
      .map(String))
    const rowIds = new Set(measurements
      .map(measurement => Number(measurement?.sourceTakeoffItemId))
      .filter(id => Number.isFinite(id) && id > 0))

    clearAllSelection()
    setEditingSectionId(null)
    setActiveSectionId(null)
    setFocusedSectionId(section.id)
    persistSectionReview(useAppStore.getState().selectedProject?.id, section.id)
    setBottomView('sections')
    setShowBottom(true)
    setBottomPinned(true)
    setActiveTool('select')
    setSelectedDrawing(normalizeDrawing(sourceDrawing))

    selectedAnnotIdsRef.current = rowIds
    selectedViewerAnnotIdsRef.current = viewerIds
    setSelectedAnnotIds(rowIds)
    setSelectedViewerAnnotIds(viewerIds)
    setSelectedAnnotId([...rowIds][0] ?? null)
    setSelectedViewerAnnotId([...viewerIds][0] ?? null)
  }, [clearAllSelection, drawings, focusedSectionId, setActiveTool, setSelectedDrawing])

  const editMeasurementSection = useCallback((section) => {
    // The Pencil action is a toggle. Clicking it again before saving exits
    // resize mode and restores the last persisted section boundary without
    // requiring a page refresh.
    if (Number(editingSectionId) === Number(section?.id)) {
      setSectionSelection(null)
      setSectionError('')
      setEditingSectionId(null)
      setFocusedSectionId(section.id)
      setActiveSectionId(null)
      clearAllSelection()
      setActiveTool('select')
      return
    }

    const sourceDrawing = drawings.find(drawing => Number(drawing.id) === Number(section?.sourceDrawingId))
    if (!sourceDrawing) {
      toast.error('The source PDF for this section is no longer available in the project')
      return
    }

    setSectionSelection(null)
    setSectionError('')
    setActiveSectionId(null)
    setEditingSectionId(section.id)
    setFocusedSectionId(section.id)
    setBottomView('sections')
    setShowBottom(true)
    setBottomPinned(true)
    clearAllSelection()
    setSelectedDrawing(normalizeDrawing(sourceDrawing))
    setActiveTool('section')
    toast('Drag any corner of the highlighted section, then release to review the updated members', { duration: 4200 })
  }, [clearAllSelection, drawings, editingSectionId, setActiveTool, setSelectedDrawing])

  const editMeasurementSectionById = useCallback((sectionId) => {
    const section = measurementSections.find(item => Number(item.id) === Number(sectionId))
    if (section) editMeasurementSection(section)
  }, [editMeasurementSection, measurementSections])

  const stopSectionPlacement = useCallback(() => {
    setActiveSectionId(null)
    setEditingSectionId(null)
    setActiveTool('select')
  }, [setActiveTool])

  const undoSectionPlacement = useCallback(async (section, placement) => {
    if (!placement?.id) return
    try {
      const updated = await measurementSectionService.deletePlacement(section.id, placement.id)
      setMeasurementSections(current => current.map(item =>
        Number(item.id) === Number(section.id) ? updated : item))
      toast.success('Last counted section location removed')
    } catch (error) {
      toast.error(error?.response?.data?.message ?? 'Could not remove the last section location')
    }
  }, [])

  const deleteMeasurementSection = useCallback(async (section) => {
    if (!window.confirm(`Delete section “${section.name}”? Original measurements will not be deleted.`)) return
    try {
      await measurementSectionService.delete(section.id)
      setMeasurementSections(current => current.filter(item => Number(item.id) !== Number(section.id)))
      if (Number(focusedSectionId) === Number(section.id)) {
        setFocusedSectionId(null)
        persistSectionReview(useAppStore.getState().selectedProject?.id, null)
      }
      if (Number(editingSectionId) === Number(section.id)) setEditingSectionId(null)
      if (Number(activeSectionId) === Number(section.id)) {
        setActiveSectionId(null)
        setActiveTool('select')
      }
      toast.success('Measurement section deleted')
    } catch (error) {
      toast.error(error?.response?.data?.message ?? 'Could not delete this section')
    }
  }, [activeSectionId, editingSectionId, focusedSectionId, setActiveTool])

  const autoSave = useCallback(async (
    measurement,
    { calibratedDrawing, isPaste = false, historyGroupId = null, skipUndo = false } = {},
  ) => {
    console.log('[BT-Lifecycle] autoSave called — length:', measurement?.length, 'unit:', measurement?.unit, 'annotationId:', measurement?.annotationId)
    const {
      selectedDrawing: drw, takeoffItems: current, measureColor: color,
      measureCategory: category, activeUnit,
      selectedMemberScheduleItem,
      memberScheduleItems: liveScheduleItems,
    } = useAppStore.getState()
    // Resolve the member captured at line finalization before consulting live
    // selection state. This preserves the user's explicit mark, type, color,
    // and schedule link even if another UI event clears selection while the
    // asynchronous save is in flight.
    const capturedMember = measurement.memberScheduleId == null
      ? null
      : liveScheduleItems.find(member => Number(member.id) === Number(measurement.memberScheduleId))
    let linkedMember = isPaste
      ? selectedMemberScheduleItem
      : (capturedMember ?? selectedMemberScheduleItem)
    const payloadMemberMark = (
      (measurement.memberMark || '').trim()
      || (measurement.drawingMark || '').trim()
      || (measurement.material || '').trim()
      || ''
    )
    const detectedMemberValue = String(
      measurement.drawingMark
      || measurement.memberMark
      || '',
    ).trim()
    const detectedMarkKey = normalizeMemberIdentityPart(detectedMemberValue)
    const existingDetectedMember = !linkedMember && detectedMarkKey
      ? liveScheduleItems.find(member =>
          normalizeMemberIdentityPart(member.mark ?? member.Mark) === detectedMarkKey)
      : null
    if (existingDetectedMember) linkedMember = existingDetectedMember

    let linkedMemberMark = linkedMember?.mark?.trim() || linkedMember?.Mark?.trim() || ''
    // Normal drawing: selected schedule member wins. Paste: copied measurement metadata wins.
    let memberMark = isPaste ? (payloadMemberMark || linkedMemberMark) : (linkedMemberMark || payloadMemberMark)
    if (!drw?.id) {
      console.warn('[BT-Lifecycle] autoSave ABORTED — no drawing id in store')
      toast.error('Measurement was not saved — no drawing selected')
      return false
    }

    if (isPaste && measurement.annotationId) {
      const items = useAppStore.getState().takeoffItems ?? []
      const dup = items.some(t => {
        return extractTakeoffAnnotationIds(t.pointsJson).includes(measurement.annotationId)
      })
      if (dup) return true
    }

    const shouldOfferDetectedMember = !isPaste
      && (measurement.measureType ?? 'Line') === 'Line'
      && !linkedMember
      && !!detectedMemberValue
    if (shouldOfferDetectedMember) {
      const addedMember = await requestDetectedMemberConfirmation({
        detectedValue: detectedMemberValue,
        drawingId: drw.id,
      })
      if (addedMember) {
        linkedMember = addedMember
        linkedMemberMark = addedMember.mark?.trim() || addedMember.Mark?.trim() || ''
        memberMark = linkedMemberMark || detectedMemberValue
      }
    }

    const normDrwGuard = calibratedDrawing ? normalizeDrawing(calibratedDrawing) : getCalibratedDrawingFromStore()
    const needsCalib = ['Line', 'Area', 'Perimeter'].includes(measurement.measureType)
    // Save immediately — calibration can be applied later via the right panel (no blocking popup).
    void needsCalib
    void normDrwGuard

    const pasteOverride = pasteStyleOverrideRef.current
    if (pasteOverride) pasteStyleOverrideRef.current = null
    const { takeoffItems: itemsForColor, memberScheduleItems } = useAppStore.getState()
    const copiedRaw = measurement.rawAnnotation ?? {}
    const copiedColor = measurement.color ?? copiedRaw.strokeColor ?? copiedRaw.StrokeColor
    let saveColor = isPaste
      ? (copiedColor ?? pasteOverride?.color ?? color ?? '#111827')
      : (pasteOverride?.color
        ?? resolveDrawColorForMemberMark(memberMark, color, itemsForColor, memberScheduleItems)
        ?? '#111827')
    const saveCategory = isPaste
      ? (measurement.category ?? pasteOverride?.category ?? category ?? 'General')
      : (pasteOverride?.category ?? category ?? 'General')
    const saveMaterialOverride = isPaste
      ? (measurement.material ?? pasteOverride?.material)
      : pasteOverride?.material

    const annotKey = measurement.annotationId
      ?? `${measurement.pageNumber}-${measurement.pixelLength}-${measurement.length}`
    if (annotKey && savingAnnotIdsRef.current.has(annotKey)) {
      // Previously silent (console.warn only) — a save that hits this guard
      // vanishes with zero visible feedback: no grid row, no toast, nothing.
      // Surface it so a stuck/duplicate save is at least visibly reported
      // instead of looking like the draw was silently dropped.
      console.warn('[BT-Lifecycle] autoSave skipped — duplicate in flight:', annotKey)
      toast.error('Measurement was not saved — please try drawing it again')
      return false
    }
    if (annotKey) savingAnnotIdsRef.current.add(annotKey)

    setAutoSaving(true)

    const unit       = activeUnit ?? drw.calibrationUnit ?? 'Mm'
    const isArea     = measurement.measureType === 'Area'
    const isPerim    = measurement.measureType === 'Perimeter'
    const isCount    = measurement.measureType === 'Count'
    const normDrw    = calibratedDrawing ? normalizeDrawing(calibratedDrawing) : getCalibratedDrawingFromStore()

    const resolved = resolveCalibratedMeasure(
      measurement.pixelLength ?? 0,
      measurement.pixelArea ?? 0,
      normDrw,
      unit,
      { isArea },
    )
    let saveLength = normDrw?.isCalibrated && normDrw.scaleRatio > 0
      ? (resolved.length ?? computeRealLengthFromDrawing(measurement.pixelLength, normDrw, unit) ?? measurement.length)
      : (measurement.length ?? resolved.length)
    let saveArea = normDrw?.isCalibrated && normDrw.scaleRatio > 0
      ? (resolved.area ?? measurement.area)
      : (measurement.area ?? resolved.area)

    if (!isCount && measurement.rawAnnotation) {
      const displayed = extractDisplayedMeasureFromAnnot(measurement.rawAnnotation, unit)
      if ((saveLength == null || saveLength <= 0) && displayed.length != null) saveLength = displayed.length
      if ((saveArea == null || saveArea <= 0) && displayed.area != null) saveArea = displayed.area
    }

    // Prefer Syncfusion computed length only when it is a valid finite number
    if (!isCount && !isArea && measurement.length != null && measurement.length > 0
        && Number.isFinite(measurement.length)) {
      saveLength = measurement.length
    }

    if (!isCount && !isArea && (saveLength == null || saveLength <= 0)) {
      const fb = resolveUncalibratedMeasureLength(
        measurement.pixelLength ?? 0,
        measurement.rawAnnotation,
        unit,
      )
      if (fb != null && Number.isFinite(fb) && fb > 0) saveLength = fb
    }

    const itemType   = isArea ? 'Area' : isPerim ? 'Perimeter' : isCount ? 'Count' : 'Line'

    // Mark: use a real selected/detected member mark. Do not generate M1/M2 for
    // automatic line measurements; generated marks belong only to manual entries.
    const prefix     = isArea ? 'A' : isPerim ? 'P' : isCount ? 'C' : 'M'
    const sameType   = current.filter(t => (t.itemType || 'Line') === itemType)
    const reuseMark  = clearedMarkRef.current
    if (reuseMark) clearedMarkRef.current = null
    const defaultMark = `${prefix}${sameType.length + 1}`
    const nextMark   = reuseMark ?? (memberMark || (itemType === 'Line' ? '' : defaultMark))

    const copiedDescription = isPaste ? String(measurement.description ?? '').trim() : ''
    const generatedDesc = isCount
      ? `Count: ${measurement.count} × ${category}`
      : isArea
        ? formatAreaMeasureDescription(measurement.pixelArea, saveArea, unit, normDrw)
        : isPerim
          ? formatPolylineDescription(measurement.pixelLength, saveLength, unit, normDrw)
          : formatLineMeasureDescription(measurement.pixelLength, saveLength, unit, normDrw)
    const desc = copiedDescription || generatedDesc

    // Safe serialise — skips circular refs so Syncfusion internal objects never crash this
    const safeJson = (obj) => {
      if (!obj) return null
      try {
        const seen = new WeakSet()
        return JSON.stringify(obj, (_, v) => {
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return undefined
            seen.add(v)
          }
          return v
        })
      } catch { return null }
    }

    const buildPointsJson = () => {
      if (!measurement.rawAnnotation) {
        return measurement.points?.length ? safeJson(measurement.points) : null
      }
      try {
        const seen = new WeakSet()
        const raw = JSON.parse(JSON.stringify(measurement.rawAnnotation, (_, v) => {
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return undefined
            seen.add(v)
          }
          return v
        }))
        const thick = isPaste
          ? (measurement.thickness ?? raw.thickness ?? raw.Thickness ?? 2)
          : (pendingMeasurementRef.current?.pendingThickness
            ?? useAppStore.getState().lineThickness
            ?? raw.thickness
            ?? raw.Thickness
            ?? 2)
        raw.thickness = Number(thick) > 0 ? Number(thick) : 2
        raw.Thickness = raw.thickness
        // Keep the rendered stroke color in sync with the resolved save color.
        // The line is drawn with the toolbar's default color before a member is
        // known (e.g. auto-detected from PDF text only after the draw finishes),
        // but the renderer prefers this embedded color over the item's own
        // `color` field — without this, a measurement auto-linked to a member
        // schedule entry would save the right color yet keep rendering the
        // wrong (default) one. Paste keeps its own copied color unchanged.
        if (!isPaste) {
          raw.strokeColor = saveColor
          raw.StrokeColor = saveColor
        }
        if (pendingMeasurementRef.current) {
          pendingMeasurementRef.current.rawPointsJson = raw
        }
        return JSON.stringify(raw)
      } catch {
        return safeJson(measurement.rawAnnotation)
      }
    }

    console.log('[BuildTakeoff] autoSave — mark:', nextMark, 'length:', saveLength,
      'pixelLength:', measurement.pixelLength, 'drawingId:', drw.id,
      'isCalibrated:', normDrw.isCalibrated, 'scaleRatio:', normDrw.scaleRatio)

    traceMeasurementDebug('measure.autoSave', {
      drawing: normDrw,
      pixelLength: measurement.pixelLength,
      pixelArea: measurement.pixelArea,
      displayUnit: unit,
      resolved,
      saveLength,
      description: desc,
      fallbackReason: /not calibrated/i.test(desc) ? 'autoSave: drawing not calibrated at save time' : null,
    })

    const payloadMemberType = String(measurement.memberType ?? '').trim()
    const memberType = isPaste
      ? (payloadMemberType || linkedMember?.memberType?.trim() || '')
      : (linkedMember?.memberType?.trim() ?? '')
    const saveCategoryFinal = memberType || saveCategory
    const saveMaterial = saveMaterialOverride || measurement.material || memberMark
    const msiId = isPaste
      ? (measurement.memberScheduleId ?? linkedMember?.id)
      : (linkedMember?.id ?? measurement.memberScheduleId)
    const baseNotes = measurement.notes || (msiId ? `msi:${msiId}` : '')
    const linkedRootItemId = isPaste
      ? (measurement.linkedItemId ?? measurement.sourceItemId ?? null)
      : null
    const saveNotes = baseNotes

    const undoToken = skipUndo
      ? null
      : recordUndoSnapshot(
          isPaste ? 'paste measurement' : 'create measurement',
          { groupKey: historyGroupId ? `paste:${historyGroupId}` : null },
        )
    try {
      const pointsJson = buildPointsJson()
      const liveItems = useAppStore.getState().takeoffItems ?? []
      const normalizeMemberKey = value => String(value ?? '').trim().toLowerCase()
      const pastedMemberKeys = new Set(
        [nextMark, saveMaterial, memberMark]
          .map(normalizeMemberKey)
          .filter(Boolean),
      )
      const isSamePastedMember = item => {
        if (!item || Number(item.drawingId) !== Number(drw.id)) return false
        return [item.mark, item.material, getMeasurementMemberMark(item, memberScheduleItems)]
          .map(normalizeMemberKey)
          .filter(Boolean)
          .some(key => pastedMemberKeys.has(key))
      }
      const isSamePastedDimension = item => {
        if (!isSamePastedMember(item)) return false
        const occurrences = buildTakeoffOccurrencesFromItem(item)
        if (!occurrences.length) return false
        const groupedLength = groupedTakeoffOccurrenceLength(occurrences, item.length)
        const groupedUnit = occurrences[0]?.unit ?? item.unit
        return groupedLength != null
          && saveLength != null
          && takeoffLengthsMatch(groupedLength, saveLength)
          && takeoffUnitsMatch(groupedUnit, unit)
      }
      const linkedRoot = isPaste && linkedRootItemId != null
        ? liveItems.find(item => Number(item.id) === Number(linkedRootItemId))
        : null
      const pasteGroup = isPaste
        ? (
            (linkedRoot && isSamePastedDimension(linkedRoot) ? linkedRoot : null)
            ?? liveItems.find(item => isSamePastedDimension(item))
            ?? null
          )
        : null

      // Equal copies share one quantity row while retaining unique annotation
      // UUIDs. A different length always starts its own independent row.
      let finalSaved
      if (pasteGroup && measurement.rawAnnotation && measurement.annotationId) {
        const appended = appendTakeoffOccurrence(pasteGroup, {
          geometry: measurement.rawAnnotation,
          annotationId: measurement.annotationId,
          occurrenceId: measurement.occurrenceId,
          pageNumber: measurement.pageNumber,
          length: saveLength,
          unit,
        })
        finalSaved = appended?.appended
          ? await takeoffService.update(appended.item)
          : pasteGroup
        updateTakeoffItem(finalSaved)
      } else {
        const saved = await takeoffService.create({
          drawingId:   drw.id,
          itemType,
          mark:        nextMark,
          description: desc,
          quantity:    isCount ? measurement.count : 1,
          unit,
          material:    saveMaterial,
          notes:       saveNotes,
          length:      isCount ? null : (saveLength ?? null),
          area:        isCount ? null : (saveArea ?? null),
          unitWeight:  isPaste ? (measurement.unitWeight ?? null) : null,
          totalWeight: isPaste ? (measurement.totalWeight ?? null) : null,
          color:       saveColor,
          category:    saveCategoryFinal,
          pointsJson,
          scaleRatioAtCreation:      normDrw.scaleRatio,
          calibrationUnitAtCreation: normDrw.calibrationUnit,
        })
        finalSaved = saved
        addTakeoffItem(finalSaved)
      }
      const latestThick = isPaste
        ? null
        : (pendingMeasurementRef.current?.pendingThickness ?? useAppStore.getState().lineThickness)
      if (latestThick != null && pointsJson) {
        try {
          const raw = JSON.parse(pointsJson)
          if (Number(raw.thickness) !== Number(latestThick)) {
            const patchedJson = JSON.stringify({ ...raw, thickness: Number(latestThick), Thickness: Number(latestThick) })
            finalSaved = await takeoffService.update({ ...finalSaved, pointsJson: patchedJson })
            updateTakeoffItem(finalSaved)
          }
        } catch (_) {}
      }
      console.log('[BT-Lifecycle] autoSave — database success, id:', finalSaved.id, 'mark:', finalSaved.mark, 'length:', finalSaved.length)
      setShowBottom(true)

      if (linkedMember?.id && !isCount && !isArea && itemType === 'Line') {
        try {
          const lengthM = saveLength != null ? toMeters(saveLength, unit) : (linkedMember.length ?? 0)
          const updatedMember = await memberScheduleService.update({
            ...linkedMember,
            takeoffItemId: finalSaved.id,
            length: Number.isFinite(lengthM) ? lengthM : (linkedMember.length ?? 0),
            quantity: (linkedMember.quantity ?? 0) > 0 ? linkedMember.quantity : 1,
          })
          updateMemberScheduleItem(updatedMember)
        } catch (err) {
          console.warn('[BuildTakeoff] member schedule link failed:', err)
        }
      }
      if (isPaste) {
        setSelectedAnnotId(finalSaved.id)
        const occurrenceId = measurement.annotationId == null ? null : String(measurement.annotationId)
        setSelectedViewerAnnotId(occurrenceId)
        selectedOccurrenceAnnotIdRef.current = occurrenceId
        setStyleEditTargetId(null)
        annotStyleBaselineRef.current = null
      } else {
        // Continuous draw: do not keep the new row in "style edit" mode — toolbar color is for the next mark.
        setSelectedAnnotId(null)
        setSelectedViewerAnnotId(null)
        selectedOccurrenceAnnotIdRef.current = null
        setStyleEditTargetId(null)
        annotStyleBaselineRef.current = null
      }
      if (measurement.annotationId) {
        const annotationIds = extractTakeoffAnnotationIds(finalSaved.pointsJson)
        annotationMapRef.current[finalSaved.id] = {
          annotationId: measurement.annotationId,
          annotationIds: annotationIds.length ? annotationIds : [measurement.annotationId],
          pageNumber:   measurement.pageNumber ?? 1,
        }
        persistedAnnotIdsRef.current.add(measurement.annotationId)
      }
      pendingMeasurementRef.current = {
        dbId: finalSaved.id,
        annotationId: measurement.annotationId,
        mark: finalSaved.mark,
        pageNumber: measurement.pageNumber ?? 1,
        pendingThickness: isPaste
          ? (measurement.thickness
            ?? measurement.rawAnnotation?.thickness
            ?? measurement.rawAnnotation?.Thickness
            ?? 2)
          : (pendingMeasurementRef.current?.pendingThickness ?? useAppStore.getState().lineThickness),
        rawPointsJson: pendingMeasurementRef.current?.rawPointsJson ?? null,
      }
      lastCopyTargetRef.current = finalSaved.id
      takeoffService.getSummary(drw.id)
        .then(sum => { setSummaryLocal(sum); setSummary(sum) })
        .catch(() => {})
      if (!isPaste) scheduleAnnotationBlobSave()
      if (isCount) {
        toast.success(`${nextMark}: ${measurement.count} × ${category} saved`, { duration: 2500, icon: '🔢' })
      } else if (isArea && saveArea != null) {
        toast.success(`${nextMark}: ${saveArea.toFixed(2)} ${getAreaUnitLabel(unit)}`, { duration: 2500, icon: '📐' })
      } else if (saveLength != null) {
        const memberHint = memberMark && nextMark !== memberMark ? ` → ${memberMark}` : ''
        toast.success(`${nextMark}${memberHint}: ${saveLength.toFixed(3)} ${getUnitLabel(unit)}`, { duration: 2500, icon: '📐' })
      } else {
        const memberHint = memberMark && nextMark !== memberMark ? ` → ${memberMark}` : ''
        toast(`${nextMark}${memberHint} saved${normDrw?.isCalibrated ? '' : ' — set scale for real lengths'}`, { duration: 3500, icon: '📐' })
      }
      return true
    } catch (err) {
      discardUndoSnapshot(undoToken)
      console.error('[BuildTakeoff] autoSave failed:', err)
      if (measurement.annotationId) measureReleaseRef.current?.(measurement.annotationId)
      toast.error('Could not save measurement — try again')
      return false
    } finally {
      savingAnnotIdsRef.current.delete(annotKey)
      setAutoSaving(false)
    }
  }, [
    addTakeoffItem,
    scheduleAnnotationBlobSave,
    updateMemberScheduleItem,
    updateTakeoffItem,
    countLinkedOccurrences,
    discardUndoSnapshot,
    recordUndoSnapshot,
    requestDetectedMemberConfirmation,
  ])

  const handleMeasure = useCallback((measurement, opts = {}) => {
    const { activeTool: currentTool } = useAppStore.getState()
    console.log('[BT-Lifecycle] handleMeasure — tool:', currentTool, 'length:', measurement?.length, 'unit:', measurement?.unit, 'annotationId:', measurement?.annotationId)

    const isRequestedCalibrationLine = currentTool === 'calibrate'
      || (currentTool === 'line' && calibrationDrawPendingRef.current)

    if (isRequestedCalibrationLine) {
      calibrationDrawPendingRef.current = false
      const drw = getCalibratedDrawingFromStore()
      const isFirstTimeCal = !drw?.isCalibrated

      // Bluebeam workflow, same for first-time calibration AND re-calibration: the reference
      // line that establishes the scale IS also the first measurement under that scale.
      // Store it so handleCalibrationApply saves it after the scale is confirmed.
      // calibrateOnly = false → autoSave will be called; annotation stays on canvas.
      // Nullify length so autoSave recalculates it from pixelLength using the just-applied scale.
      console.log('[BT-Lifecycle] handleMeasure —', isFirstTimeCal ? 'first-time' : 're-', 'calibration, storing measurement for post-calibration save')
      calibrateOnlyRef.current = false
      pendingCalibMeasureRef.current = { ...measurement, length: null }
      pendingMeasurementRef.current = {
        annotationId: measurement.annotationId,
        dbId: null,
        mark: measurement.memberMark || measurement.drawingMark || null,
        pageNumber: measurement.pageNumber ?? 1,
        pendingThickness: useAppStore.getState().lineThickness,
        rawPointsJson: measurement.rawAnnotation ?? null,
      }

      setScaleSetupFirstMeasure(isFirstTimeCal)
      setLastMeasurement(measurement)
      setShowCalModal(true)
      return
    }

    // Fallback intercept: non-calibrate tool on an uncalibrated drawing (e.g. Area/Perimeter).
    // Same Bluebeam logic: store the measurement and let handleCalibrationApply save it.
    if (!opts.isPaste && (measurement.measureType ?? 'Line') === 'Line') {
      const drw = getCalibratedDrawingFromStore()
      if (!(drw?.isCalibrated)) {
        console.log('[BT-Lifecycle] handleMeasure — uncalibrated drawing (non-calibrate tool), storing for post-calibration save')
        calibrateOnlyRef.current = false
        pendingCalibMeasureRef.current = { ...measurement, length: null }
        pendingMeasurementRef.current = {
          annotationId: measurement.annotationId,
          dbId: null,
          mark: measurement.memberMark || measurement.drawingMark || null,
          pageNumber: measurement.pageNumber ?? 1,
          pendingThickness: useAppStore.getState().lineThickness,
          rawPointsJson: measurement.rawAnnotation ?? null,
        }
        setScaleSetupFirstMeasure(true)
        setLastMeasurement(measurement)
        setShowCalModal(true)
        return
      }
    }

    console.log('[BT-Lifecycle] handleMeasure — proceeding to autoSave, length:', measurement?.length)
    if (!opts.isPaste) {
      // New mark — toolbar thickness applies to this line, not a previously selected row.
      setSelectedAnnotId(null)
      setSelectedViewerAnnotId(null)
      selectedOccurrenceAnnotIdRef.current = null
      setStyleEditTargetId(null)
      annotStyleBaselineRef.current = null
      pendingMeasurementRef.current = {
        annotationId: measurement.annotationId,
        dbId: null,
        mark: measurement.memberMark || measurement.drawingMark || null,
        pageNumber: measurement.pageNumber ?? 1,
        pendingThickness: useAppStore.getState().lineThickness,
        rawPointsJson: measurement.rawAnnotation ?? null,
      }
    }

    setLastMeasurement(measurement)
    return autoSave(measurement, opts).then((ok) => {
      if (ok) {
        console.log('[BT-Lifecycle] handleMeasure — autoSave success, triggering label rehydrate')
        triggerPdfCommand('rehydrateMeasureLabels')
      } else {
        console.warn('[BT-Lifecycle] handleMeasure — autoSave did not complete')
      }
      return ok
    })
  }, [autoSave, triggerPdfCommand])

  const handleSaveCalib = useCallback(() => {
    const px = lastMeasurement?.pixelLength
    if (!px || px <= 0) {
      toast.error('Draw a line along a labelled dimension on the plan first')
      return
    }
    // Same Bluebeam workflow as handleMeasure's calibrate branch: the reference line becomes
    // a real measurement under the new scale, whether this is first-time or re-calibration.
    calibrateOnlyRef.current = false
    pendingCalibMeasureRef.current = { ...lastMeasurement, length: null }
    pendingMeasurementRef.current = {
      annotationId: lastMeasurement.annotationId,
      dbId: null,
      mark: lastMeasurement.memberMark || lastMeasurement.drawingMark || null,
      pageNumber: lastMeasurement.pageNumber ?? 1,
      pendingThickness: useAppStore.getState().lineThickness,
      rawPointsJson: lastMeasurement.rawAnnotation ?? null,
    }
    setScaleSetupFirstMeasure(!getCalibratedDrawingFromStore()?.isCalibrated)
    setShowCalModal(true)
  }, [lastMeasurement])

  const handleCalibrationApply = useCallback(async (realLength, unit) => {
    const drawingId = useAppStore.getState().selectedDrawing?.id ?? selectedDrawing?.id
    if (!drawingId) { toast.error('No drawing selected'); return }

    const pendingMeasure = pendingCalibMeasureRef.current
    const calibrateOnly = calibrateOnlyRef.current
    const pxLen = lastMeasurement?.pixelLength ?? pendingMeasure?.pixelLength
    if (!pxLen || pxLen === 0) { toast.error('No reference line found — draw on a labelled dimension first'); return }

    const scaleRatio = computeScaleRatio(realLength, unit, pxLen)
    if (!scaleRatio) { toast.error('Could not save scale — check the length you entered'); return }

    recordUndoSnapshot('calibration')
    setCalSaving(true)
    try {
      await drawingService.calibrate(drawingId, scaleRatio, unit)
      const apiDrawing = await drawingService.getById(drawingId)
      const updated = normalizeDrawing(mergeCalibrationState(apiDrawing, scaleRatio, unit))
      traceCalibration('calibration.apply.success', {
        pixelLength: pxLen, realLength, unit, scaleRatio,
        drawing: calibrationSnapshot(updated),
      })
      setSelectedDrawing(updated)
      setDrawings(prev => {
        const list = Array.isArray(prev) ? prev : Array.isArray(useAppStore.getState().drawings) ? useAppStore.getState().drawings : []
        const exists = list.some(d => d.id === updated.id)
        if (!exists) return [...list, updated]
        return list.map(d => (d.id === updated.id ? updated : normalizeDrawing(d)))
      })
      updateDrawingCalibration(drawingId, scaleRatio, unit)
      setActiveUnit(unit)
      triggerPdfCommand('refreshCalibration')
      await recalculateTakeoffItemsAfterCalibration(
        useAppStore.getState().takeoffItems,
        updated,
        unit,
        (item) => takeoffService.update(item),
        (saved) => updateTakeoffItem(saved),
      )

      const measureToSave = pendingMeasure && !calibrateOnly ? pendingMeasure : null
      let savedFirst = false
      if (measureToSave) {
        savedFirst = await autoSave(measureToSave, { calibratedDrawing: updated, skipUndo: true })
        if (savedFirst) triggerPdfCommand('rehydrateMeasureLabels')
      } else {
        if (lastMeasurement?.annotationId && calibrateOnly) {
          // Delete the calibration reference line first, then rehydrate labels after it's gone.
          // Two triggerPdfCommand calls in the same sync block would overwrite each other (single-slot store).
          triggerPdfCommand({ type: 'deleteAnnotation', annotationId: lastMeasurement.annotationId, pageNumber: lastMeasurement.pageNumber ?? 1 })
          setTimeout(() => triggerPdfCommand('rehydrateMeasureLabels'), 200)
        } else {
          triggerPdfCommand('rehydrateMeasureLabels')
        }
      }

      setShowCalModal(false)
      setScaleSetupFirstMeasure(false)
      pendingCalibMeasureRef.current = null
      calibrateOnlyRef.current = false
      setActiveTool('line')

      if (savedFirst) {
        const savedMark = measureToSave?.memberMark || measureToSave?.drawingMark
        toast.success(
          savedMark ? `Scale saved — ${savedMark} measurement added` : 'Scale saved — your first measurement was added',
          { duration: 3500, icon: '✅' },
        )
      } else if (measureToSave && !savedFirst) {
        toast.error('Scale saved but measurement could not be added — draw the line again')
      } else {
        toast.success('Scale saved — you can measure now', { duration: 3500, icon: '✅' })
      }
    } catch (err) {
      console.error('[BuildTakeoff] calibration apply failed:', err)
      const apiMessage = err?.response?.data?.message || err?.response?.data?.errors?.[0]
      toast.error(apiMessage || err?.message || 'Could not save scale — try again')
    } finally {
      setCalSaving(false)
    }
  }, [lastMeasurement, selectedDrawing, triggerPdfCommand, updateDrawingCalibration, setActiveUnit, updateTakeoffItem, autoSave, recordUndoSnapshot])

  const handleQuickScale = useCallback(async (scaleRatio, unit) => {
    if (!selectedDrawing) return
    recordUndoSnapshot('calibration')
    try {
      await drawingService.calibrate(selectedDrawing.id, scaleRatio, unit)
      const apiDrawing = await drawingService.getById(selectedDrawing.id)
      const updated = normalizeDrawing(mergeCalibrationState(apiDrawing, scaleRatio, unit))
      setSelectedDrawing(updated)
      setDrawings(prev => {
        const list = Array.isArray(prev) ? prev : Array.isArray(useAppStore.getState().drawings) ? useAppStore.getState().drawings : []
        return list.map(d => (d.id === updated.id ? updated : normalizeDrawing(d)))
      })
      updateDrawingCalibration(selectedDrawing.id, scaleRatio, unit)
      setActiveUnit(unit)
      triggerPdfCommand('refreshCalibration')
      await recalculateTakeoffItemsAfterCalibration(
        useAppStore.getState().takeoffItems,
        updated,
        unit,
        (item) => takeoffService.update(item),
        (saved) => updateTakeoffItem(saved),
      )
      triggerPdfCommand('rehydrateMeasureLabels')
      setActiveTool('line')
      toast.success('Scale set — ready to measure', { duration: 3000, icon: '✅' })
    } catch (err) {
      console.error('[BuildTakeoff] quick scale apply failed:', err)
      const apiMessage = err?.response?.data?.message || err?.response?.data?.errors?.[0]
      toast.error(apiMessage || err?.message || 'Failed to apply quick scale')
    }
  }, [selectedDrawing, triggerPdfCommand, updateDrawingCalibration, setActiveUnit, updateTakeoffItem, recordUndoSnapshot])

  const handleRowSelect = useCallback((dbId, event = null) => {
    // See handleAnnotationSelect — selecting a different measurement (here,
    // via the grid/member-schedule row instead of the canvas) must end any
    // in-progress paste session the same way.
    triggerPdfCommand({ type: 'cancelPastePlacement' })
    const additive = !!(event && (event.ctrlKey || event.metaKey || event.shiftKey))

    if (!additive) {
      // Unchanged existing (solo-select) behavior, plus collapsing the
      // multi-select Sets to match.
      setSelectedAnnotId(dbId)
      setStyleEditTargetId(dbId)
      annotStyleBaselineRef.current = null
      if (!dbId) {
        setSelectedViewerAnnotId(null)
        selectedOccurrenceAnnotIdRef.current = null
        selectedAnnotIdsRef.current = new Set()
        selectedViewerAnnotIdsRef.current = new Set()
        setSelectedAnnotIds(new Set())
        setSelectedViewerAnnotIds(new Set())
        return
      }
      lastCopyTargetRef.current = dbId
      const item = takeoffItems.find(t => t.id === dbId)
      const annot = annotationMapRef.current[dbId]
      const occurrenceId = annot?.annotationId == null ? null : String(annot.annotationId)
      syncToolbarFromTakeoffItem(item, occurrenceId)
      selectedOccurrenceAnnotIdRef.current = occurrenceId
      setSelectedViewerAnnotId(occurrenceId)
      if (annot?.annotationId) triggerPdfCommand({ type: 'selectAnnotation', ...annot })
      const soloIds = new Set([dbId])
      const soloViewerIds = occurrenceId ? new Set([occurrenceId]) : new Set()
      selectedAnnotIdsRef.current = soloIds
      selectedViewerAnnotIdsRef.current = soloViewerIds
      setSelectedAnnotIds(soloIds)
      setSelectedViewerAnnotIds(soloViewerIds)
      return
    }

    // Ctrl/Shift+click: toggle this row's membership in the multi-selection
    // without touching the rest of it. Deliberately does NOT trigger
    // 'selectAnnotation' (no page-jump) — jumping the sheet on every
    // shift-click while building a selection would be disorienting.
    const nextIds = new Set(selectedAnnotIdsRef.current)
    const removed = dbId != null && nextIds.has(dbId)
    if (dbId != null) { if (removed) nextIds.delete(dbId); else nextIds.add(dbId) }
    selectedAnnotIdsRef.current = nextIds
    setSelectedAnnotIds(nextIds)

    const annot = dbId != null ? annotationMapRef.current[dbId] : null
    const occurrenceId = annot?.annotationId == null ? null : String(annot.annotationId)
    const nextViewerIds = new Set(selectedViewerAnnotIdsRef.current)
    if (occurrenceId) { if (nextViewerIds.has(occurrenceId)) nextViewerIds.delete(occurrenceId); else nextViewerIds.add(occurrenceId) }
    selectedViewerAnnotIdsRef.current = nextViewerIds
    setSelectedViewerAnnotIds(nextViewerIds)

    const primaryDbId = removed ? ([...nextIds].pop() ?? null) : dbId
    setSelectedAnnotId(primaryDbId)
    setStyleEditTargetId(primaryDbId)
    annotStyleBaselineRef.current = null
    if (primaryDbId != null) {
      lastCopyTargetRef.current = primaryDbId
      const primaryAnnot = annotationMapRef.current[primaryDbId]
      const primaryOccurrenceId = primaryAnnot?.annotationId == null ? null : String(primaryAnnot.annotationId)
      syncToolbarFromTakeoffItem(
        takeoffItems.find(t => t.id === primaryDbId),
        primaryOccurrenceId,
      )
      selectedOccurrenceAnnotIdRef.current = primaryOccurrenceId
      setSelectedViewerAnnotId(primaryOccurrenceId)
    } else {
      selectedOccurrenceAnnotIdRef.current = null
      setSelectedViewerAnnotId(null)
    }
  }, [triggerPdfCommand, takeoffItems, syncToolbarFromTakeoffItem])

  const handleSelectAllRows = useCallback((rowIds = []) => {
    triggerPdfCommand({ type: 'cancelPastePlacement' })

    const requestedIds = new Set(rowIds.map(id => String(id)))
    const rows = takeoffItems.filter(item => requestedIds.has(String(item.id)))
    if (!rows.length) {
      clearAllSelection()
      return
    }

    const rowSelection = new Set(rows.map(item => item.id))
    const viewerSelection = new Set()
    rows.forEach(item => {
      buildTakeoffOccurrencesFromItem(item).forEach(occurrence => {
        if (occurrence?.annotationName != null) {
          viewerSelection.add(String(occurrence.annotationName))
        }
      })
    })

    const primaryItem = rows[0]
    const primaryOccurrenceId = buildTakeoffOccurrencesFromItem(primaryItem)
      .map(occurrence => occurrence?.annotationName)
      .find(id => id != null)
    const primaryViewerId = primaryOccurrenceId == null
      ? null
      : String(primaryOccurrenceId)

    selectedAnnotIdsRef.current = rowSelection
    selectedViewerAnnotIdsRef.current = viewerSelection
    selectedOccurrenceAnnotIdRef.current = primaryViewerId
    setSelectedAnnotIds(rowSelection)
    setSelectedViewerAnnotIds(viewerSelection)
    setSelectedAnnotId(primaryItem.id)
    setSelectedViewerAnnotId(primaryViewerId)
    setStyleEditTargetId(primaryItem.id)
    annotStyleBaselineRef.current = null
    lastCopyTargetRef.current = primaryItem.id
    syncToolbarFromTakeoffItem(primaryItem, primaryViewerId)
  }, [clearAllSelection, syncToolbarFromTakeoffItem, takeoffItems, triggerPdfCommand])

  const handleMeasurementThicknessChange = useCallback((itemId, thickness, annotId = null) => {
    const pending = pendingMeasurementRef.current
    const pendingMatch = annotId && pending?.annotationId
      && (pending.annotationId === annotId || extractAnnotIdFromPointsJson(pending.rawPointsJson) === annotId)

    if (pendingMatch || (!itemId && pending?.annotationId && !annotId)) {
      pending.pendingThickness = thickness
      pendingMeasurementRef.current = pending
    }

    let targetId = itemId
    if (targetId == null && annotId) {
      targetId = resolveMeasurementDbId(annotId)
      if (targetId == null) {
        const byAnnot = (useAppStore.getState().takeoffItems ?? []).find(
          t => extractAnnotIdFromPointsJson(t.pointsJson) === annotId,
        )
        targetId = byAnnot?.id ?? null
      }
    }
    if (targetId == null && pending?.annotationId) {
      targetId = resolveMeasurementDbId(pending.annotationId)
    }
    if (targetId == null && pending?.dbId) targetId = pending.dbId
    if (targetId == null) {
      if (pendingMatch || pending?.pendingThickness != null) return
      return
    }

    const item = (useAppStore.getState().takeoffItems ?? []).find(t => t.id === targetId)
    if (!item?.pointsJson) return
    try {
      const raw = JSON.parse(item.pointsJson)
      const occurrenceId = annotId ?? selectedOccurrenceAnnotIdRef.current
      const selectedOccurrence = occurrenceId != null && Array.isArray(raw.occurrences)
        ? raw.occurrences.find(occ => {
            const geometry = occ?.geometry ?? occ?.rawAnnotation ?? occ
            return String(occ?.annotationName ?? getRawAnnotationId(geometry)) === String(occurrenceId)
          })
        : null
      const selectedGeometry = selectedOccurrence?.geometry
        ?? selectedOccurrence?.rawAnnotation
        ?? selectedOccurrence
        ?? raw
      const existing = selectedGeometry.thickness ?? selectedGeometry.Thickness
      if (existing != null && Number(existing) === Number(thickness)) return
      const occurrenceUpdate = updateTakeoffOccurrence(item, occurrenceId, occurrence => ({
        ...occurrence,
        geometry: {
          ...occurrence.geometry,
          thickness,
          Thickness: thickness,
        },
      }))
      const optimistic = occurrenceUpdate ?? {
        ...item,
        pointsJson: JSON.stringify({ ...raw, thickness, Thickness: thickness }),
      }
      recordUndoSnapshot('measurement thickness change')
      updateTakeoffItem(optimistic)
      takeoffService.update(optimistic).then(saved => updateTakeoffItem(saved)).catch(() => {})
      if (pendingMeasurementRef.current) {
        pendingMeasurementRef.current.pendingThickness = thickness
        pendingMeasurementRef.current.dbId = targetId
      }
      if (selectedAnnotId === targetId) {
        annotStyleBaselineRef.current = {
          color: measureColor,
          thickness,
          lineStyle,
          arrowStyle,
          labelFontSize: measureLabelFontSize,
        }
      }
    } catch (_) {}
  }, [takeoffItems, updateTakeoffItem, selectedAnnotId, measureColor, measureLabelFontSize, lineStyle, arrowStyle, resolveMeasurementDbId, extractAnnotIdFromPointsJson, recordUndoSnapshot])

  const handleMeasurementGeometryChange = useCallback((payload) => {
    const annotId = payload?.annotationId
    const annotationKey = annotId == null ? null : String(annotId)
    const trackedDetachment = annotationKey == null
      ? null
      : geometryDetachmentsRef.current.get(annotationKey)
    if (trackedDetachment?.inFlight) {
      trackedDetachment.latestPayload = payload
      return
    }

    const dbId = trackedDetachment?.detachedId
      ?? payload?.dbId
      ?? resolveMeasurementDbId(annotId)
    if (dbId == null || !payload?.rawAnnotation) return

    const existingTimer = geometrySaveTimersRef.current.get(dbId)
    if (existingTimer) clearTimeout(existingTimer)
    const historyGroupKey = payload.interactionId ? `geometry:${payload.interactionId}` : null
    if (historyGroupKey || !existingTimer) {
      recordUndoSnapshot('move or resize measurement', { groupKey: historyGroupKey })
    }

    const item = (useAppStore.getState().takeoffItems ?? [])
      .find(t => String(t.id) === String(dbId))
    if (!item?.pointsJson) return

    try {
      const previousRaw = JSON.parse(item.pointsJson)
      const occurrences = buildTakeoffOccurrencesFromItem(item)
      const occurrence = occurrences.find(entry => (
        String(entry.annotationName) === String(annotId)
      ))

      // A pasted occurrence shares its quantity row only until its geometry is
      // edited. The first move/resize/endpoint change splits it into a new row;
      // the in-flight map above ensures pointer-move events cannot split it twice.
      if (annotationKey != null && occurrence && occurrences.length > 1) {
        const detachment = {
          sourceId: item.id,
          detachedId: null,
          inFlight: true,
          latestPayload: payload,
        }
        geometryDetachmentsRef.current.set(annotationKey, detachment)
        if (existingTimer) {
          clearTimeout(existingTimer)
          geometrySaveTimersRef.current.delete(dbId)
        }

        void (async () => {
          let created = null
          try {
            const liveSource = (useAppStore.getState().takeoffItems ?? [])
              .find(entry => String(entry.id) === String(detachment.sourceId))
            const liveOccurrences = buildTakeoffOccurrencesFromItem(liveSource)
            const liveOccurrence = liveOccurrences.find(entry => (
              String(entry.annotationName) === annotationKey
            ))
            if (!liveSource || !liveOccurrence || liveOccurrences.length <= 1) {
              throw new Error('Copied measurement is no longer grouped')
            }

            const detachPayload = detachment.latestPayload
            const detachedTemplate = buildIndependentGeometryItem(
              { ...liveSource, quantity: 1 },
              liveOccurrence,
              detachPayload,
              annotationKey,
              activeUnit,
            ).item
            const removal = removeTakeoffOccurrence(liveSource, annotationKey)
            if (!removal?.item) throw new Error('Could not remove copied occurrence from its group')

            created = await takeoffService.create({
              drawingId: liveSource.drawingId,
              itemType: liveSource.itemType || 'Line',
              mark: liveSource.mark,
              description: detachedTemplate.description,
              quantity: 1,
              unit: detachedTemplate.unit,
              material: liveSource.material,
              notes: withoutLegacyOccurrenceLinkNotes(liveSource.notes),
              length: detachedTemplate.length,
              area: liveSource.area,
              unitWeight: liveSource.unitWeight,
              totalWeight: detachedTemplate.totalWeight,
              color: liveSource.color,
              category: liveSource.category,
              pointsJson: detachedTemplate.pointsJson,
              scaleRatioAtCreation: liveSource.scaleRatioAtCreation,
              calibrationUnitAtCreation: liveSource.calibrationUnitAtCreation,
            })

            let savedSource
            try {
              savedSource = await takeoffService.update(removal.item)
            } catch (error) {
              await takeoffService.delete(created.id).catch(() => {})
              created = null
              throw error
            }

            updateTakeoffItem(savedSource)
            addTakeoffItem(created)
            detachment.detachedId = created.id
            detachment.inFlight = false

            // If the user kept dragging while the split requests were running,
            // persist the newest geometry on the newly-created row.
            if (detachment.latestPayload !== detachPayload) {
              const latestDetached = buildIndependentGeometryItem(
                created,
                null,
                detachment.latestPayload,
                annotationKey,
                activeUnit,
              ).item
              try {
                created = await takeoffService.update(latestDetached)
                updateTakeoffItem(created)
              } catch (error) {
                // The split itself is already committed. Keep the independent
                // row and let the next geometry event retry its latest update.
                console.warn('[BuildTakeoff] detached geometry follow-up save failed:', error)
              }
            }

            const index = buildTakeoffAnnotationIndex(useAppStore.getState().takeoffItems ?? [])
            annotationMapRef.current = index.map
            persistedAnnotIdsRef.current = index.persistedIds
            if (selectedOccurrenceAnnotIdRef.current === annotationKey
                || selectedViewerAnnotIdsRef.current.has(annotationKey)) {
              const remainingSelectedInSource = buildTakeoffOccurrencesFromItem(savedSource)
                .some(entry => selectedViewerAnnotIdsRef.current.has(String(entry.annotationName)))
              const nextSelectedRowIds = new Set(selectedAnnotIdsRef.current)
              if (!remainingSelectedInSource) nextSelectedRowIds.delete(savedSource.id)
              nextSelectedRowIds.add(created.id)
              selectedAnnotIdsRef.current = nextSelectedRowIds
              setSelectedAnnotIds(nextSelectedRowIds)
              setSelectedAnnotId(created.id)
              setSelectedViewerAnnotId(annotationKey)
              selectedOccurrenceAnnotIdRef.current = annotationKey
            }
            if (pendingMeasurementRef.current?.annotationId != null
                && String(pendingMeasurementRef.current.annotationId) === annotationKey) {
              pendingMeasurementRef.current = {
                ...pendingMeasurementRef.current,
                dbId: created.id,
                rawPointsJson: readTakeoffPointsJson(created.pointsJson),
              }
            }
            if (Number(lastCopyTargetRef.current) === Number(savedSource.id)) {
              lastCopyTargetRef.current = created.id
            }
            takeoffService.getSummary(liveSource.drawingId)
              .then(sum => { setSummaryLocal(sum); setSummary(sum) })
              .catch(() => {})
            scheduleAnnotationBlobSave()
          } catch (error) {
            geometryDetachmentsRef.current.delete(annotationKey)
            console.warn('[BuildTakeoff] copied measurement detachment failed:', error)
            toast.error('Could not detach the edited copy — please try again')
          }
        })()
        return
      }

      if (Array.isArray(previousRaw.occurrences) && previousRaw.occurrences.length && !occurrence) {
        return
      }
      const { change, item: independentUpdate } = buildIndependentGeometryItem(
        item,
        occurrence,
        payload,
        annotId,
        activeUnit,
      )
      const occurrenceUpdate = updateTakeoffOccurrence(item, change.stableAnnotId, entry => ({
        ...entry,
        pageNumber: payload.pageNumber ?? entry.pageNumber ?? change.movedRaw.pageNumber ?? 1,
        rotation: change.movedRaw.RotateAngle ?? change.movedRaw.rotateAngle ?? entry.rotation ?? 0,
        length: change.nextLength,
        unit: change.unit,
        geometry: change.geometry,
      }))
      const next = occurrenceUpdate
        ? {
            ...occurrenceUpdate,
            unit: change.unit,
            description: change.description,
          }
        : independentUpdate

      updateTakeoffItem(next)
      const revision = (geometrySaveRevisionRef.current.get(dbId) ?? 0) + 1
      geometrySaveRevisionRef.current.set(dbId, revision)
      const timer = setTimeout(async () => {
        geometrySaveTimersRef.current.delete(dbId)
        const latest = (useAppStore.getState().takeoffItems ?? [])
          .find(t => String(t.id) === String(dbId))
        if (!latest) return
        try {
          const saved = await takeoffService.update(latest)
          if (geometrySaveRevisionRef.current.get(dbId) === revision) updateTakeoffItem(saved)
          if (selectedDrawing?.id) {
            takeoffService.getSummary(selectedDrawing.id)
              .then(sum => { setSummaryLocal(sum); setSummary(sum) })
              .catch(() => {})
          }
          scheduleAnnotationBlobSave()
        } catch (err) {
          console.warn('[BuildTakeoff] measurement geometry update failed:', err)
        }
      }, 250)
      geometrySaveTimersRef.current.set(dbId, timer)
    } catch (err) {
      console.warn('[BuildTakeoff] measurement geometry update failed:', err)
    }
  }, [
    activeUnit,
    addTakeoffItem,
    recordUndoSnapshot,
    resolveMeasurementDbId,
    scheduleAnnotationBlobSave,
    selectedDrawing,
    setSummary,
    updateTakeoffItem,
  ])

  const resolveCopyTargetId = useCallback(() => {
    const isValid = (item) => item && isValidLinearMeasurementForCopy(item)
    const resolveCandidate = (candidateId) => {
      if (candidateId == null) return null
      const direct = takeoffItems.find(t => String(t.id) === String(candidateId))
      if (isValid(direct)) return direct.id

      const dbId = resolveMeasurementDbId(candidateId)
      if (dbId == null) return null
      const mapped = takeoffItems.find(t => String(t.id) === String(dbId))
      return isValid(mapped) ? mapped.id : null
    }
    const candidates = [
      selectedOccurrenceAnnotIdRef.current,
      selectedAnnotId,
      styleEditTargetId,
    ].filter(id => id != null)
    for (const id of candidates) {
      const resolved = resolveCandidate(id)
      if (resolved != null) return resolved
    }
    return null
  }, [selectedAnnotId, styleEditTargetId, takeoffItems, resolveMeasurementDbId])

  // Builds one clipboard entry for a single takeoff item — extracted so both
  // the solo-select and multi-select paths call the exact same, unchanged
  // per-item logic (today's single-copy behavior IS this function called
  // once, with idsToUse === [resolveCopyTargetId()]).
  const buildClipboardItemFor = useCallback((targetId, requestedOccurrenceId = null) => {
    const item = takeoffItems.find(t => t.id === targetId)
    if (!item?.pointsJson || (item.itemType || 'Line') !== 'Line') return null
    if (!isValidLinearMeasurementForCopy(item)) return null
    try {
      const raw = JSON.parse(item.pointsJson)
      // Prefer this specific item's own occurrence id (relevant when copying
      // several items at once, each potentially selected via a different
      // occurrence) — fall back to the shared "current" occurrence ref for
      // the solo-select case, exactly as before.
      const occurrences = buildTakeoffOccurrencesFromItem(item)
      const ownOccurrenceId = annotationMapRef.current[targetId]?.annotationId
      const selectedViewerOccurrenceId = [...selectedViewerAnnotIdsRef.current]
        .find(id => occurrences.some(occ => String(occ.annotationName) === String(id)))
      const currentOccurrenceId = selectedOccurrenceAnnotIdRef.current
      const currentBelongsToItem = currentOccurrenceId != null
        && occurrences.some(occ => String(occ.annotationName) === String(currentOccurrenceId))
      const selectedOccurrenceId = requestedOccurrenceId
        ?? selectedViewerOccurrenceId
        ?? (currentBelongsToItem ? currentOccurrenceId : null)
        ?? ownOccurrenceId
      const selectedOccurrence = selectedOccurrenceId
        ? occurrences.find(
          occ => String(occ.annotationName) === String(selectedOccurrenceId)
        )
        : null
      const copyRaw = selectedOccurrence?.geometry ?? stripOccurrenceContainer(raw)
      const copyLength = takeoffOccurrenceLength(selectedOccurrence, item.length)
      const copyUnit = selectedOccurrence?.unit ?? item.unit
      const copyTotalWeight = item.unitWeight != null && copyLength != null
        ? Number(item.unitWeight) * toMeters(copyLength, copyUnit)
        : item.totalWeight
      return buildLinearMeasurementClipboard({
        ...item,
        occurrenceId: selectedOccurrenceId,
        length: copyLength,
        quantity: 1,
        totalWeight: copyTotalWeight,
      }, copyRaw, pdfScale)
    } catch {
      return null
    }
  }, [takeoffItems, pdfScale])

  const handleCopyMeasurement = useCallback(() => {
    const selectedRowIds = [...selectedAnnotIdsRef.current]
    const selectedOccurrenceIds = [...selectedViewerAnnotIdsRef.current].map(String)

    // Resolve every selected PDF occurrence UUID directly to its owning row.
    // Do not infer identity from length/label and do not depend on how many
    // occurrences happen to share one grouped grid-row id.
    const occurrenceTargetsById = new Map()
    takeoffItems.forEach(row => {
      buildTakeoffOccurrencesFromItem(row).forEach(occurrence => {
        if (occurrence?.annotationName == null) return
        occurrenceTargetsById.set(String(occurrence.annotationName), {
          targetId: row.id,
          occurrenceId: occurrence.annotationName,
        })
      })
    })
    const copyTargets = selectedOccurrenceIds
      .map(occurrenceId => occurrenceTargetsById.get(occurrenceId))
      .filter(Boolean)

    // Grid-only rows (for example a manual measurement with no viewer UUID)
    // still use the existing single-row copy fallback. Rows already represented
    // by one or more selected occurrence UUIDs are not added again.
    const representedRowIds = new Set(copyTargets.map(target => String(target.targetId)))
    selectedRowIds.forEach(targetId => {
      if (!representedRowIds.has(String(targetId))) {
        copyTargets.push({ targetId, occurrenceId: null })
      }
    })
    if (!copyTargets.length) {
      const fallbackId = resolveCopyTargetId()
      if (fallbackId != null) copyTargets.push({ targetId: fallbackId, occurrenceId: null })
    }

    const items = copyTargets
      .map(({ targetId, occurrenceId }) =>
        buildClipboardItemFor(targetId, occurrenceId),
      )
      .filter(Boolean)

    if (!items.length) {
      toast.error(copyTargets.length > 1 || selectedOccurrenceIds.length > 1
        ? 'No copyable linear measurements in selection'
        : 'Draw or select a linear measurement to copy')
      return
    }
    recordUndoSnapshot('copy measurement')
    setMeasurementClipboard({ items })
    clearPasteAnchor()
    // Paste is a "stamp" mode that stays armed across multiple placements
    // until Escape/Done or a tool switch — it does NOT clear itself just
    // because a fresh Copy happened. Without this, copying a different line
    // right after finishing several pastes of the previous one leaves the
    // canvas still silently armed with the OLD clipboard until the user
    // explicitly clicks Paste again, so the next click either does nothing
    // new or drops another copy of the wrong item.
    triggerPdfCommand({ type: 'cancelPastePlacement' })
    if (copyTargets[0]?.targetId != null) lastCopyTargetRef.current = copyTargets[0].targetId
    if (items.length > 1) toast.success(`${items.length} measurements copied`)
  }, [takeoffItems, resolveCopyTargetId, buildClipboardItemFor, recordUndoSnapshot, setMeasurementClipboard, clearPasteAnchor, triggerPdfCommand])

  const handlePasteMeasurement = useCallback(() => {
    const clipboard = useAppStore.getState().measurementClipboard ?? measurementClipboard
    if (!clipboard?.items?.length) {
      toast('Copy a measurement first (Ctrl+C)')
      return
    }
    if (!selectedDrawing) return
    // Toolbar-sync nicety only — the anchor (first-copied) item's style;
    // each pasted item still carries and preserves its own full style.
    const anchor = clipboard.items[0]
    pasteStyleOverrideRef.current = {
      color: anchor.color,
      category: anchor.category,
      material: anchor.material ?? anchor.mark ?? '',
    }
    clearPasteAnchor()
    // A right-click context menu left open from earlier (or opened right on
    // top of the drawing area while this new placement session starts) would
    // otherwise float over the canvas at a fixed position and silently
    // swallow the very clicks meant to place a copy — close it so the fresh
    // placement session isn't immediately blocked by a stale menu.
    closeCtxMenu()
    triggerPdfCommand({ type: 'pasteMeasurement', clipboard })
  }, [measurementClipboard, selectedDrawing, triggerPdfCommand, clearPasteAnchor, closeCtxMenu])

  const copyTargetId = resolveCopyTargetId()
  const selectedMeasurementCount = Math.max(
    selectedAnnotIds.size,
    selectedViewerAnnotIds.size,
  )
  const canCopyMeasurement = selectedMeasurementCount > 1 ? true : !!copyTargetId
  const canPasteMeasurement = !!measurementClipboard?.items?.length && (measurementClipboard.items[0].itemType || 'Line') === 'Line'

  // Reassign the selected PDF occurrences without moving their siblings.
  // Occurrences join an existing row for the destination member when one
  // exists; otherwise the selected occurrence becomes the first instance of a
  // new member row.
  const handleAssignMemberToSelection = useCallback(async (member, ids) => {
    const initialItems = useAppStore.getState().takeoffItems ?? []
    const rows = ids
      .map(id => initialItems.find(t => Number(t.id) === Number(id)))
      .filter(Boolean)
    if (!rows.length || !member?.mark) return

    const selectedOccurrenceIds = new Set(
      [...selectedViewerAnnotIdsRef.current].map(String),
    )
    const targets = rows.flatMap(row => {
      const occurrences = buildTakeoffOccurrencesFromItem(row)
      let selected = occurrences.filter(occurrence =>
        selectedOccurrenceIds.has(String(occurrence.annotationName)),
      )
      if (!selected.length && selectedOccurrenceAnnotIdRef.current != null) {
        selected = occurrences.filter(occurrence =>
          String(occurrence.annotationName)
            === String(selectedOccurrenceAnnotIdRef.current),
        )
      }
      if (!selected.length && occurrences.length) selected = [occurrences[0]]
      return selected.map(occurrence => ({
        sourceItemId: row.id,
        annotationId: occurrence.annotationName,
      }))
    })
    if (!targets.length) return

    recordUndoSnapshot('member reassignment')
    let lastAssignedItemId = null
    let lastAssignedAnnotationId = null
    const memberKey = String(member.mark).trim().toLowerCase()

    for (const target of targets) {
      const liveItems = useAppStore.getState().takeoffItems ?? []
      const source = liveItems.find(item => Number(item.id) === Number(target.sourceItemId))
      if (!source) continue
      const sourceOccurrences = buildTakeoffOccurrencesFromItem(source)
      const occurrence = sourceOccurrences.find(
        entry => String(entry.annotationName) === String(target.annotationId),
      )
      if (!occurrence) continue

      const newColor = member.color || source.color
      const patchedGeometry = {
        ...occurrence.geometry,
        strokeColor: newColor,
        StrokeColor: newColor,
      }
      const cleanNotes = String(source.notes ?? '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => !/^msi:/i.test(part) && !/^linkedItem:/i.test(part) && !/^occurrence:/i.test(part))
      if (member.id != null) cleanNotes.push(`msi:${member.id}`)
      const notes = cleanNotes.join(';')

      try {
        const sourceMemberKey = String(
          getMeasurementMemberMark(source, useAppStore.getState().memberScheduleItems)
            || source.material
            || source.mark
            || '',
        ).trim().toLowerCase()
        const matchingGroup = liveItems.find(item => {
          if (Number(item.id) === Number(source.id)
              || Number(item.drawingId) !== Number(source.drawingId)) return false
          const key = String(
            getMeasurementMemberMark(item, useAppStore.getState().memberScheduleItems)
              || item.material
              || item.mark
              || '',
          ).trim().toLowerCase()
          const groupedOccurrences = buildTakeoffOccurrencesFromItem(item)
          const groupedLength = groupedTakeoffOccurrenceLength(groupedOccurrences, item.length)
          const occurrenceLength = takeoffOccurrenceLength(occurrence, source.length)
          const groupedUnit = groupedOccurrences[0]?.unit ?? item.unit
          const occurrenceUnit = occurrence.unit ?? source.unit
          return key === memberKey
            && groupedLength != null
            && occurrenceLength != null
            && takeoffLengthsMatch(groupedLength, occurrenceLength)
            && takeoffUnitsMatch(groupedUnit, occurrenceUnit)
        })

        if (sourceMemberKey === memberKey) {
          const patched = updateTakeoffOccurrence(source, occurrence.annotationName, entry => ({
            ...entry,
            geometry: patchedGeometry,
          }))
          const raw = readTakeoffPointsJson(source.pointsJson)
          const optimistic = patched ?? {
            ...source,
            color: newColor,
            pointsJson: raw ? JSON.stringify(patchedGeometry) : source.pointsJson,
          }
          const saved = await takeoffService.update(optimistic)
          updateTakeoffItem(saved)
          lastAssignedItemId = saved.id
          lastAssignedAnnotationId = occurrence.annotationName
          continue
        }

        if (matchingGroup) {
          const appended = appendTakeoffOccurrence(matchingGroup, {
            geometry: patchedGeometry,
            annotationId: occurrence.annotationName,
            occurrenceId: occurrence.occurrenceId,
            pageNumber: occurrence.pageNumber,
            length: occurrence.length,
            unit: occurrence.unit ?? source.unit,
          })
          if (appended?.appended) {
            const savedTarget = await takeoffService.update(appended.item)
            updateTakeoffItem(savedTarget)
            lastAssignedItemId = savedTarget.id
          } else {
            lastAssignedItemId = matchingGroup.id
          }
        }

        const removal = removeTakeoffOccurrence(source, occurrence.annotationName)
        if (matchingGroup) {
          if (removal?.item) {
            const savedSource = await takeoffService.update(removal.item)
            updateTakeoffItem(savedSource)
          } else {
            await takeoffService.delete(source.id)
            removeTakeoffItem(source.id)
          }
        } else if (removal?.item) {
          const created = await takeoffService.create({
            drawingId: source.drawingId,
            itemType: source.itemType || 'Line',
            mark: member.mark,
            description: source.description,
            quantity: 1,
            unit: occurrence.unit ?? source.unit,
            material: member.mark,
            notes,
            length: takeoffOccurrenceLength(occurrence, source.length),
            area: source.area,
            unitWeight: source.unitWeight,
            totalWeight: source.unitWeight != null && occurrence.length != null
              ? Number(source.unitWeight) * toMeters(occurrence.length, occurrence.unit ?? source.unit)
              : source.totalWeight,
            color: newColor,
            category: member.memberType || source.category,
            pointsJson: JSON.stringify(patchedGeometry),
            scaleRatioAtCreation: source.scaleRatioAtCreation,
            calibrationUnitAtCreation: source.calibrationUnitAtCreation,
          })
          addTakeoffItem(created)
          const savedSource = await takeoffService.update(removal.item)
          updateTakeoffItem(savedSource)
          lastAssignedItemId = created.id
        } else {
          const raw = readTakeoffPointsJson(source.pointsJson)
          const wasContainer = Array.isArray(raw?.occurrences)
          const pointsJson = wasContainer
            ? JSON.stringify(buildOccurrenceContainer(source, [{
                ...occurrence,
                geometry: patchedGeometry,
              }]))
            : JSON.stringify(patchedGeometry)
          const saved = await takeoffService.update({
            ...source,
            mark: member.mark,
            material: member.mark,
            notes,
            color: newColor,
            category: member.memberType || source.category,
            quantity: 1,
            length: takeoffOccurrenceLength(occurrence, source.length),
            pointsJson,
          })
          updateTakeoffItem(saved)
          lastAssignedItemId = saved.id
        }
        lastAssignedAnnotationId = occurrence.annotationName
      } catch (err) {
        console.warn('[BuildTakeoff] occurrence member reassignment failed:', err)
        toast.error(`Could not reassign ${source.mark || 'measurement'}`)
      }
    }

    const index = buildTakeoffAnnotationIndex(useAppStore.getState().takeoffItems ?? [])
    annotationMapRef.current = index.map
    persistedAnnotIdsRef.current = index.persistedIds
    if (lastAssignedItemId != null && lastAssignedAnnotationId != null) {
      setSelectedAnnotId(lastAssignedItemId)
      setSelectedViewerAnnotId(String(lastAssignedAnnotationId))
      selectedOccurrenceAnnotIdRef.current = String(lastAssignedAnnotationId)
      selectedAnnotIdsRef.current = new Set([lastAssignedItemId])
      selectedViewerAnnotIdsRef.current = new Set([String(lastAssignedAnnotationId)])
      setSelectedAnnotIds(new Set([lastAssignedItemId]))
      setSelectedViewerAnnotIds(new Set([String(lastAssignedAnnotationId)]))
    }
    if (selectedDrawing?.id) {
      takeoffService.getSummary(selectedDrawing.id)
        .then(sum => { setSummaryLocal(sum); setSummary(sum) })
        .catch(() => {})
    }
  }, [
    addTakeoffItem,
    recordUndoSnapshot,
    removeTakeoffItem,
    selectedDrawing?.id,
    setSummary,
    updateTakeoffItem,
  ])

  const handleRowDelete = useCallback(async (
    id,
    { annotationId = null, deleteGroup = false, skipUndo = false } = {},
  ) => {
    const annot = annotationMapRef.current[id]
    const beforeDeleteItems = useAppStore.getState().takeoffItems ?? []
    const itemBeingDeleted = beforeDeleteItems.find(t => Number(t.id) === Number(id))
    const occurrenceRemoval = !deleteGroup && annotationId != null
      ? removeTakeoffOccurrence(itemBeingDeleted, annotationId)
      : null
    const annotationIds = Array.from(new Set([
      ...(annot?.annotationIds ?? []),
      annot?.annotationId,
      ...extractTakeoffAnnotationIds(itemBeingDeleted?.pointsJson),
    ].filter(Boolean)))
    const linkedRootBeforeDelete = parseLinkedItemId(itemBeingDeleted?.notes)
    const undoToken = skipUndo ? null : recordUndoSnapshot('delete measurement')
    try {
      if (occurrenceRemoval?.item) {
        const saved = await takeoffService.update(occurrenceRemoval.item)
        updateTakeoffItem(saved)
        persistedAnnotIdsRef.current.delete(annotationId)
        const remainingIds = extractTakeoffAnnotationIds(saved.pointsJson)
        annotationMapRef.current[id] = {
          annotationId: remainingIds[0] ?? null,
          annotationIds: remainingIds,
          pageNumber: buildTakeoffOccurrencesFromItem(saved)[0]?.pageNumber ?? 1,
        }
        triggerPdfCommand({
          type: 'deleteAnnotation',
          annotationId,
          pageNumber: annot?.pageNumber ?? 1,
        })
        if (String(selectedOccurrenceAnnotIdRef.current) === String(annotationId)) {
          setSelectedAnnotId(null)
          setSelectedViewerAnnotId(null)
          selectedOccurrenceAnnotIdRef.current = null
          selectedAnnotIdsRef.current = new Set()
          selectedViewerAnnotIdsRef.current = new Set()
          setSelectedAnnotIds(new Set())
          setSelectedViewerAnnotIds(new Set())
        }
        if (pendingMeasurementRef.current?.annotationId != null
            && String(pendingMeasurementRef.current.annotationId) === String(annotationId)) {
          pendingMeasurementRef.current = null
        }
        if (selectedDrawing) {
          takeoffService.getSummary(selectedDrawing.id)
            .then(sum => { setSummaryLocal(sum); setSummary(sum) })
            .catch(() => {})
        }
        return
      }

      await takeoffService.delete(id)
      removeTakeoffItem(id)
      delete annotationMapRef.current[id]
      if (linkedRootBeforeDelete != null) {
        try {
          const rowsAfterDelete = beforeDeleteItems.filter(t => Number(t.id) !== Number(id))
          const occurrenceCount = countLinkedOccurrences(rowsAfterDelete, linkedRootBeforeDelete)
          const rootItem = rowsAfterDelete.find(t => Number(t.id) === Number(linkedRootBeforeDelete))
          if (rootItem && Number(rootItem.quantity ?? 1) !== occurrenceCount) {
            const updatedRoot = await takeoffService.update({ ...rootItem, quantity: Math.max(1, occurrenceCount) })
            updateTakeoffItem(updatedRoot)
          }
        } catch (err) {
          console.warn('[BuildTakeoff] linked occurrence quantity delete update failed:', err)
        }
      }
      if (selectedAnnotId === id) {
        setSelectedAnnotId(null)
        setSelectedViewerAnnotId(null)
        selectedOccurrenceAnnotIdRef.current = null
      }
      // Purge this id from the multi-selection too, if present — otherwise a
      // deleted row's id could linger selected (e.g. still counted toward a
      // group copy) even though its row/shape no longer exists.
      if (selectedAnnotIdsRef.current.has(id)) {
        const nextIds = new Set(selectedAnnotIdsRef.current)
        nextIds.delete(id)
        selectedAnnotIdsRef.current = nextIds
        setSelectedAnnotIds(nextIds)
        const occurrenceId = annot?.annotationId == null ? null : String(annot.annotationId)
        if (occurrenceId && selectedViewerAnnotIdsRef.current.has(occurrenceId)) {
          const nextViewerIds = new Set(selectedViewerAnnotIdsRef.current)
          nextViewerIds.delete(occurrenceId)
          selectedViewerAnnotIdsRef.current = nextViewerIds
          setSelectedViewerAnnotIds(nextViewerIds)
        }
      }
      if (pendingMeasurementRef.current?.dbId === id) pendingMeasurementRef.current = null
      if (annotationIds.length) {
        annotationIds.forEach(annotationId => persistedAnnotIdsRef.current.delete(annotationId))
        triggerPdfCommand({
          type: 'deleteAnnotations',
          annotationIds,
          pageNumber: annot?.pageNumber ?? 1,
        })
      }
      if (selectedDrawing) {
        takeoffService.getSummary(selectedDrawing.id)
          .then(sum => { setSummaryLocal(sum); setSummary(sum) })
          .catch(() => {})
      }
    } catch {
      discardUndoSnapshot(undoToken)
      toast.error('Failed to delete measurement')
      throw new Error('delete failed')
    }
  }, [
    selectedAnnotId,
    selectedDrawing,
    triggerPdfCommand,
    removeTakeoffItem,
    setSummary,
    parseLinkedItemId,
    countLinkedOccurrences,
    discardUndoSnapshot,
    recordUndoSnapshot,
    updateTakeoffItem,
  ])

  const handleDeleteSelectedMeasurements = useCallback(async () => {
    const liveItems = useAppStore.getState().takeoffItems ?? []
    const selectedRowIds = selectedAnnotIdsRef.current.size
      ? [...selectedAnnotIdsRef.current]
      : [selectedAnnotId].filter(id => id != null)
    const selectedOccurrenceIds = new Set(
      [...selectedViewerAnnotIdsRef.current].map(String),
    )
    const targets = []

    selectedRowIds.forEach(rowId => {
      const row = liveItems.find(item => Number(item.id) === Number(rowId))
      if (!row) return
      const selectedOccurrences = buildTakeoffOccurrencesFromItem(row)
        .map(occurrence => occurrence?.annotationName)
        .filter(id => id != null && selectedOccurrenceIds.has(String(id)))

      if (selectedOccurrences.length) {
        selectedOccurrences.forEach(annotationId => {
          targets.push({ id: row.id, annotationId, deleteGroup: false })
        })
      } else {
        targets.push({ id: row.id, annotationId: null, deleteGroup: true })
      }
    })

    for (const target of targets) {
      await handleRowDelete(target.id, {
        annotationId: target.annotationId,
        deleteGroup: target.deleteGroup,
      })
    }
    clearAllSelection()
  }, [clearAllSelection, handleRowDelete, selectedAnnotId])

  const handleMemberScheduleDelete = useCallback(async (member, linkedMeasurements = []) => {
    const liveItems = useAppStore.getState().takeoffItems ?? []
    const linkedIds = new Set(linkedMeasurements.map(item => Number(item.id)))
    const memberId = Number(member.id)
    const targets = liveItems.filter(item =>
      linkedIds.has(Number(item.id))
      || Number(parseMemberScheduleNoteId(item.notes)) === memberId
      || Number(member.takeoffItemId) === Number(item.id))

    // Reuse the normal measurement deletion workflow. It already handles
    // grouped copy/paste occurrences, PDF annotations, grid state, selections,
    // quantities and the current drawing summary.
    for (const item of targets) {
      // Member deletion is not an undoable schedule operation. Do not leave a
      // measurement-only undo entry that could restore an orphaned row after
      // its schedule member has already been removed.
      await handleRowDelete(item.id, { deleteGroup: true, skipUndo: true })
    }

    // The backend also removes the stable member link from other drawings in
    // this project, preventing orphaned measurements when the user switches PDF.
    await memberScheduleService.delete(member.id)
    removeMemberScheduleItem(member.id)
    clearAllSelection()

    const { selectedMemberScheduleItem, lastMeasureMember } = useAppStore.getState()
    if ([selectedMemberScheduleItem, lastMeasureMember]
      .some(selected => Number(selected?.id) === Number(member.id))) {
      useAppStore.getState().clearSelectedMemberScheduleItem?.()
    }

    if (selectedProject?.id) {
      memberScheduleService.getProjectSummary(selectedProject.id)
        .then(setMemberScheduleSummary)
        .catch(() => {})
    }
  }, [
    clearAllSelection,
    handleRowDelete,
    removeMemberScheduleItem,
    selectedProject?.id,
    setMemberScheduleSummary,
  ])

  const handlePdfAreaContextMenu = useCallback((e) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const dismissFocusedSectionReview = useCallback(() => {
    // Eye is only a temporary review/highlight mode. A normal PDF click
    // should leave that review without forcing the user to return to the
    // Eye button. Do not interfere with section placement or resize/edit.
    if (focusedSectionId == null
      || activeSectionId != null
      || editingSectionId != null
      || activeTool === 'section') return false

    setFocusedSectionId(null)
    persistSectionReview(useAppStore.getState().selectedProject?.id, null)
    return true
  }, [activeSectionId, activeTool, editingSectionId, focusedSectionId])

  const handleAnnotationSelect = useCallback((annotUuid, annotation = null, event = null) => {
    // Clicking a measurement after reviewing a section should first clear
    // the Eye-selected group. The clicked measurement is then selected by
    // the unchanged logic below, instead of remaining part of that group.
    if (dismissFocusedSectionReview()) clearAllSelection()
    // Selecting a different measurement ends any in-progress paste "stamp"
    // session (same mechanism handleCopyMeasurement uses for a fresh Copy) —
    // otherwise the moving preview/ghost and "Move preview..." banner stay
    // armed in the background, silently tied to whatever was copied before,
    // even though the user's focus has clearly moved to a different item.
    triggerPdfCommand({ type: 'cancelPastePlacement' })
    const occurrenceId = annotation?.id ?? annotUuid ?? null
    // A still-pending (not yet reconciled) optimistic annotation carries its
    // client-generated UUID in `dbId` too (see normalizeAnnotations, shared
    // between real and preview items) — clicking it while that window is
    // still open would otherwise poison selection with a non-numeric id that
    // can never match a real takeoffItems row, silently breaking Copy for
    // that click until something else resets selection.
    const rawDbId = annotation?.dbId
    const dbId = Number.isFinite(Number(rawDbId)) ? Number(rawDbId) : resolveMeasurementDbId(occurrenceId)
    const viewerId = occurrenceId == null ? null : String(occurrenceId)
    const additive = !!(event && (event.ctrlKey || event.metaKey || event.shiftKey))

    if (!additive) {
      // Unchanged existing (solo-select) behavior, plus collapsing the
      // multi-select Sets to match.
      selectedOccurrenceAnnotIdRef.current = viewerId
      setSelectedViewerAnnotId(viewerId)
      setSelectedAnnotId(dbId ?? null)
      setStyleEditTargetId(dbId)
      if (dbId) lastCopyTargetRef.current = dbId
      annotStyleBaselineRef.current = null
      if (dbId) {
        const item = takeoffItems.find(t => t.id === dbId)
        syncToolbarFromTakeoffItem(item, viewerId)
      }
      const soloIds = dbId ? new Set([dbId]) : new Set()
      const soloViewerIds = viewerId ? new Set([viewerId]) : new Set()
      selectedAnnotIdsRef.current = soloIds
      selectedViewerAnnotIdsRef.current = soloViewerIds
      setSelectedAnnotIds(soloIds)
      setSelectedViewerAnnotIds(soloViewerIds)
      return
    }

    // Ctrl/Shift+click: toggle this shape's membership in the
    // multi-selection, leaving the rest of the current selection untouched.
    const nextViewerIds = new Set(selectedViewerAnnotIdsRef.current)
    const removed = viewerId != null && nextViewerIds.has(viewerId)
    if (viewerId) {
      if (removed) nextViewerIds.delete(viewerId)
      else nextViewerIds.add(viewerId)
    }

    // A grouped quantity row can own several independently selectable PDF
    // occurrences. Keep the row selected while any of its occurrence UUIDs
    // remains selected, regardless of identical lengths or labels.
    const nextIds = new Set(selectedAnnotIdsRef.current)
    if (dbId != null) {
      const rowStillHasSelectedOccurrence = [...nextViewerIds].some(id =>
        Number(resolveMeasurementDbId(id)) === Number(dbId),
      )
      if (rowStillHasSelectedOccurrence) nextIds.add(dbId)
      else nextIds.delete(dbId)
    }
    selectedAnnotIdsRef.current = nextIds
    selectedViewerAnnotIdsRef.current = nextViewerIds
    setSelectedAnnotIds(nextIds)
    setSelectedViewerAnnotIds(nextViewerIds)

    // Keep the scalar "primary" pointed at whichever item this click just
    // affected — this is what keeps resolveCopyTargetId/the style-persist
    // effect/context-menu Delete meaningful mid-multi-select.
    const primaryViewerId = removed ? ([...nextViewerIds].pop() ?? null) : viewerId
    const primaryDbId = primaryViewerId != null
      ? resolveMeasurementDbId(primaryViewerId)
      : ([...nextIds].pop() ?? null)
    selectedOccurrenceAnnotIdRef.current = primaryViewerId
    setSelectedViewerAnnotId(primaryViewerId)
    setSelectedAnnotId(primaryDbId)
    setStyleEditTargetId(primaryDbId)
    annotStyleBaselineRef.current = null
    if (primaryDbId) {
      lastCopyTargetRef.current = primaryDbId
      syncToolbarFromTakeoffItem(
        takeoffItems.find(t => t.id === primaryDbId),
        primaryViewerId,
      )
    }
  }, [clearAllSelection, dismissFocusedSectionReview, resolveMeasurementDbId, syncToolbarFromTakeoffItem, takeoffItems, triggerPdfCommand])

  const handleAnnotationContextMenu = useCallback((event, annotUuid, annotation = null) => {
    event.preventDefault()
    event.stopPropagation()
    // Right-clicking a shape that's already part of an active 2+ selection
    // must not collapse the group to just this one shape — a group
    // right-click menu should still act on (and Copy) the whole selection.
    const rawDbId = annotation?.dbId
    const occurrenceId = annotation?.id ?? annotUuid ?? null
    const dbId = Number.isFinite(Number(rawDbId)) ? Number(rawDbId) : resolveMeasurementDbId(occurrenceId)
    const occurrenceIsInMultiSelection = occurrenceId != null
      && selectedViewerAnnotIdsRef.current.size > 1
      && selectedViewerAnnotIdsRef.current.has(String(occurrenceId))
    const rowIsInMultiSelection = selectedAnnotIdsRef.current.size > 1
      && dbId != null
      && selectedAnnotIdsRef.current.has(dbId)
    const isMultiMember = occurrenceIsInMultiSelection || rowIsInMultiSelection
    if (!isMultiMember) handleAnnotationSelect(annotUuid, annotation)
    setCtxMenu({ x: event.clientX, y: event.clientY })
  }, [handleAnnotationSelect, resolveMeasurementDbId])

  useEffect(() => {
    if (!ctxMenu) return
    const onKey = (e) => { if (e.key === 'Escape') closeCtxMenu() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctxMenu, closeCtxMenu])

  // Capture-phase Ctrl+C / Ctrl+V — runs before Syncfusion's bubble-phase listeners
  // so the PDF viewer cannot intercept our copy/paste shortcuts.
  useEffect(() => {
    const handler = (e) => {
      const key = e.key?.toLowerCase?.() ?? ''
      const hasMod = e.ctrlKey || e.metaKey

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        calibrationDrawPendingRef.current = false
        closeCtxMenu()
        clearCopiedMeasurements()
        setSectionSelection(null)
        setActiveSectionId(null)
        setFocusedSectionId(null)
        persistSectionReview(useAppStore.getState().selectedProject?.id, null)
        setEditingSectionId(null)
        resetDrawingInteraction()
        clearAllSelection()
        // The calibration modal still needs its completed reference measurement.
        if (!showCalModal) setLastMeasurement(null)
        return
      }

      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (!hasMod && (e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotId) {
        e.preventDefault()
        e.stopPropagation()
        handleDeleteSelectedMeasurements().catch(() => {})
        return
      }

      if (hasMod && (key === 'z' || key === 'y')) {
        e.preventDefault()
        e.stopPropagation()
        if (key === 'y' || (key === 'z' && e.shiftKey)) handleRedo()
        else handleUndo()
        return
      }

      if (!(hasMod && (key === 'c' || key === 'v'))) return
      if (e.repeat) return
      const isC = key === 'c'
      if (isC) {
        e.preventDefault()
        e.stopPropagation()
        handleCopyMeasurement()
      } else {
        e.preventDefault()
        e.stopPropagation()
        handlePasteMeasurement()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleCopyMeasurement, handlePasteMeasurement, handleRedo, handleUndo, selectedAnnotId, handleDeleteSelectedMeasurements, closeCtxMenu, showCalModal, resetDrawingInteraction, clearAllSelection, clearCopiedMeasurements])

  const handleCalibrated = useCallback(async () => {
    if (!selectedDrawing) return
    try {
      const updated = normalizeDrawing(await drawingService.getById(selectedDrawing.id))
      setSelectedDrawing(updated)
      setDrawings(prev => {
        const list = Array.isArray(prev) ? prev : []
        return list.map(d => (d.id === updated.id ? updated : normalizeDrawing(d)))
      })
      triggerPdfCommand('refreshCalibration')
    } catch { /* ignore */ }
  }, [selectedDrawing, triggerPdfCommand])

  // "How to set scale" button when not calibrated — just activate calibrate tool
  const handleCalibrateScaleClick = useCallback(() => {
    calibrationDrawPendingRef.current = true
    setActiveTool('calibrate')
    triggerPdfCommand('ensureMeasureMode')
  }, [setActiveTool, triggerPdfCommand])

  // "Reset Scale" button when already calibrated — wipe DB calibration, return to calibrate mode
  const handleResetCalibration = useCallback(async () => {
    if (!selectedDrawing) return
    const undoToken = recordUndoSnapshot('reset calibration')
    try {
      const refreshed = await drawingService.resetCalibration(selectedDrawing.id)
      setSelectedDrawing(refreshed)
      setDrawings(prev => (Array.isArray(prev) ? prev : []).map(d => d.id === refreshed.id ? refreshed : normalizeDrawing(d)))
      triggerPdfCommand('refreshCalibration')
      calibrationDrawPendingRef.current = true
      setActiveTool('calibrate')
      triggerPdfCommand('ensureMeasureMode')
      toast('Scale reset — draw a reference line to re-calibrate', { duration: 4000, icon: '📐' })
    } catch {
      discardUndoSnapshot(undoToken)
      toast.error('Failed to reset calibration')
    }
  }, [discardUndoSnapshot, recordUndoSnapshot, selectedDrawing, triggerPdfCommand])

  const handleDrawingUploaded = async (drawing) => {
    const norm = normalizeDrawing(drawing)
    setSelectedDrawing(norm)
    setTakeoffItems([])
    // The member schedule is shared by the project, not owned by the newly
    // uploaded drawing. Keep the existing project schedule visible while the
    // new drawing becomes active; the project has not changed and upload does
    // not add or remove schedule rows.
    setSummaryLocal(null)
    annotationMapRef.current = {}
    persistedAnnotIdsRef.current = new Set()
    // Do NOT auto-arm Calibrate here. Calibrate/Linear draw on left-drag, so
    // silently arming it right after upload meant the very next drag the
    // user made — even one meant only to pan and look around the new
    // drawing — got captured as "draw the calibration line," committing a
    // stray line + popup before the user ever chose to draw anything. The
    // "Not Calibrated" banner and "Set Scale" button already guide them to
    // click Calibrate explicitly when they're ready.
    toast('New drawing uploaded — click Calibrate, then draw along a labelled dimension to set the scale.', { duration: 5500, icon: '📐' })
    if (isMobile) setSidebarOpen(false)

    try {
      if (selectedProject?.id) {
        const data = await drawingService.getByProject(selectedProject.id)
        const list = Array.isArray(data) ? data : (data ? [data] : [])
        const normalized = list.map(normalizeDrawing).filter(Boolean)
        const merged = normalized.some(d => d.id === norm.id)
          ? normalized
          : [...normalized, norm]
        setDrawings(merged)
        setSelectedDrawing(merged.find(d => d.id === norm.id) ?? norm)
      } else {
        setDrawings(prev => {
          const list = Array.isArray(prev) ? prev : []
          return list.some(d => d.id === norm.id) ? list : [...list, norm]
        })
      }
    } catch {
      setDrawings(prev => {
        const list = Array.isArray(prev) ? prev : []
        return list.some(d => d.id === norm.id) ? list : [...list, norm]
      })
    }
  }

  const handleDrawingDeleted = async (id) => {
    const rest = (Array.isArray(useAppStore.getState().drawings) ? useAppStore.getState().drawings : []).filter(d => d.id !== id)
    projectDrawingLoadRef.current = {
      projectId: Number(selectedProject?.id),
      loaded: true,
      count: rest.length,
    }
    setDrawings(rest)

    // A reusable section belongs to the PDF it was created from. Remove those
    // groups immediately when their source drawing is deleted, and remove any
    // counted placements that pointed at the deleted PDF. The server reload
    // below remains authoritative and also reconciles legacy orphaned groups.
    const removedSectionIds = new Set(measurementSections
      .filter(section => rest.length === 0 || Number(section.sourceDrawingId) === Number(id))
      .map(section => Number(section.id)))
    const remainingSections = rest.length === 0
      ? []
      : measurementSections
        .filter(section => !removedSectionIds.has(Number(section.id)))
        .map(section => {
          const placements = (section.placements ?? [])
            .filter(placement => Number(placement.drawingId) !== Number(id))
          return { ...section, placements, usedPlaces: placements.length }
        })
    setMeasurementSections(remainingSections)
    if (rest.length === 0 || removedSectionIds.has(Number(activeSectionId))) setActiveSectionId(null)
    if (rest.length === 0 || removedSectionIds.has(Number(focusedSectionId))) {
      setFocusedSectionId(null)
      persistSectionReview(selectedProject?.id, null)
    }
    if (rest.length === 0 || removedSectionIds.has(Number(editingSectionId))) setEditingSectionId(null)
    if (rest.length === 0) setSectionSelection(null)

    // The project schedule is shared, but extracted rows retain their source
    // DrawingId. Remove those rows immediately, then reload from the server so
    // counts/summary stay authoritative after the drawing's soft-delete cascade.
    const remainingMembers = rest.length === 0
      ? []
      : (useAppStore.getState().memberScheduleItems ?? [])
        .filter(member => Number(member.drawingId) !== Number(id))
    setMemberScheduleItems(remainingMembers)
    if (rest.length === 0) setMemberScheduleSummary(null)

    const { selectedMemberScheduleItem, lastMeasureMember } = useAppStore.getState()
    const removedSelectedMember = [selectedMemberScheduleItem, lastMeasureMember]
      .some(member => member && Number(member.drawingId) === Number(id))
    if (removedSelectedMember) useAppStore.getState().clearSelectedMemberScheduleItem()

    if (selectedDrawing?.id === id) {
      setSelectedDrawing(rest[0] ? normalizeDrawing(rest[0]) : null)
      setTakeoffItems([])
      setSummaryLocal(null)
      annotationMapRef.current = {}
      persistedAnnotIdsRef.current = new Set()
    }

    if (!selectedProject?.id) return
    try {
      const [members, memberSum, sections] = await Promise.all([
        memberScheduleService.getByProject(selectedProject.id),
        memberScheduleService.getProjectSummary(selectedProject.id),
        measurementSectionService.getByProject(selectedProject.id),
      ])
      if (rest.length === 0) {
        // Keep the zero-drawing invariant even if an older running API still
        // returns orphan rows. The updated API call above cleans those rows in
        // the database; the UI must never show them in the meantime.
        setMemberScheduleItems([])
        setMemberScheduleSummary(null)
        setMeasurementSections([])
      } else {
        setMemberScheduleItems(assignMemberColors(members))
        setMemberScheduleSummary(memberSum)
        setMeasurementSections(Array.isArray(sections) ? sections : [])
      }
    } catch {
      // The drawing has already been deleted successfully. Keep the safe
      // optimistic state; the normal project reload will reconcile it.
      toast.error('Drawing deleted, but related project data could not be refreshed')
    }
  }

  const handleItemAdded = async () => {
    if (!selectedDrawing) return
    try {
      const [items, sum] = await Promise.all([
        takeoffService.getByDrawing(selectedDrawing.id),
        takeoffService.getSummary(selectedDrawing.id),
      ])
      setTakeoffItems(items)
      setSummaryLocal(sum)
      setSummary(sum)
    } catch { /* ignore */ }
  }

  const handleExtractionSaved = useCallback(async (saveResult) => {
    if (!selectedProject?.id) return
    const count = typeof saveResult === 'number'
      ? saveResult
      : Number(saveResult?.savedCount ?? 0)
    try {
      const [members, memberSum] = await Promise.all([
        memberScheduleService.getByProject(selectedProject.id),
        memberScheduleService.getProjectSummary(selectedProject.id),
      ])
      setMemberScheduleItems(assignMemberColors(members))
      setMemberScheduleSummary(memberSum)
      setLeftPanelTab('members')
      setLeftPanelOpen(true)
      setLeftHovered(true)
      if (count > 0) {
        toast.success(`${count} member(s) saved — project schedule updated from PDF extraction`, { duration: 3000, icon: '🔩' })
      }
    } catch { /* ignore */ }
    setShowExtractModal(false)
  }, [selectedProject?.id, setMemberScheduleItems, setMemberScheduleSummary])

  const handleExport    = () => exportToExcel(takeoffItems, memberScheduleItems, selectedDrawing, selectedProject)
  const handleExportPdf = () => exportToPdf(takeoffItems, memberScheduleItems, selectedDrawing, selectedProject)

  const drawingUrl        = selectedDrawing ? drawingService.getFileUrl(selectedDrawing.id) : null
  const selectedAnnotItem = selectedAnnotId
    ? takeoffItems.find(t => String(t.id) === String(selectedAnnotId))
      ?? takeoffItems.find(t => t.id === resolveMeasurementDbId(selectedAnnotId))
      ?? null
    : null

  // Bottom panel height — resizable via drag
  const effectiveBottomOpen = bottomPinned ? showBottom : bottomHovered
  const leftDockMaxWidth = typeof window === 'undefined'
    ? LEFT_DOCK_MAX_WIDTH
    : getLeftDockMaxWidth(window.innerWidth)
  const rightDockMaxWidth = typeof window === 'undefined' ? 440 : Math.max(250, Math.floor(window.innerWidth * 0.4))
  const bottomDockMaxHeight = typeof window === 'undefined' ? 520 : Math.max(180, Math.floor(window.innerHeight * 0.68))

  const handleLeftDockHover = (hovered) => {
    clearTimeout(leftHoverTimer.current)
    if (hovered) setLeftHovered(true)
    else leftHoverTimer.current = setTimeout(() => setLeftHovered(false), 240)
  }
  const handleRightDockHover = (hovered) => {
    clearTimeout(rightHoverTimer.current)
    if (hovered) setRightHovered(true)
    else rightHoverTimer.current = setTimeout(() => setRightHovered(false), 240)
  }
  const handleBottomDockHover = (hovered) => {
    clearTimeout(bottomHoverTimer.current)
    if (hovered) setBottomHovered(true)
    else bottomHoverTimer.current = setTimeout(() => setBottomHovered(false), 240)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Backdrop for mobile drawers ─────────────────────────── */}
      {isMobile && (sidebarOpen || rightOpen) && (
        <div
          className="drawer-backdrop"
          onClick={() => { setSidebarOpen(false); setRightOpen(false) }}
        />
      )}

      {/* ── Breadcrumb bar ──────────────────────────────────────── */}
      <div style={{
        padding: isMobile ? '5px 10px' : '5px 16px',
        background: '#090f1e', borderBottom: '1px solid rgba(255,255,255,.07)',
        display: 'flex', alignItems: 'center', gap: isMobile ? '6px' : '8px',
        flexShrink: 0, minHeight: '40px', flexWrap: 'nowrap', overflowX: 'auto',
      }}>

        {/* Mobile: Sidebar toggle */}
        {isMobile && (
          <button
            onClick={() => { setSidebarOpen(o => !o); setRightOpen(false) }}
            style={{
              flexShrink: 0, background: sidebarOpen ? 'rgba(239,35,60,.12)' : 'transparent',
              border: `1px solid ${sidebarOpen ? 'rgba(239,35,60,.3)' : 'rgba(255,255,255,.1)'}`,
              borderRadius: '6px', padding: '5px 7px', cursor: 'pointer',
              color: sidebarOpen ? '#EF233C' : '#64748b', display: 'flex', alignItems: 'center',
              touchAction: 'manipulation',
            }}
            title="Drawings panel"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          </button>
        )}

        <button onClick={() => { setSelectedProject(null); navigate('/dashboard') }}
          style={{
            background: 'none', border: 'none', color: '#475569', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px',
            padding: '2px 6px', borderRadius: '4px', flexShrink: 0, touchAction: 'manipulation',
          }}
          onMouseEnter={e => e.currentTarget.style.color = '#94a3b8'}
          onMouseLeave={e => e.currentTarget.style.color = '#475569'}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          {!isMobile && 'Projects'}
        </button>

        {!isMobile && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.15)" strokeWidth="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        )}

        <span style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8', flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: isMobile ? '90px' : '200px' }}>
          {selectedProject?.name}
          {!isMobile && selectedProject?.projectNumber && (
            <span style={{ fontSize: '10px', color: '#EF233C', marginLeft: '6px', fontWeight: 700 }}>
              {selectedProject.projectNumber}
            </span>
          )}
        </span>

        {selectedDrawing && !isMobile && (
          <>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.15)" strokeWidth="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            <span style={{ fontSize: '12px', color: '#64748b', flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>
              {activeDrawing?.name}
            </span>
            {activeDrawing?.isCalibrated && (
              <span style={{ fontSize: '10px', color: '#22c55e', fontWeight: 700, background: 'rgba(34,197,94,.1)', padding: '1px 6px', borderRadius: '4px', flexShrink: 0 }}>
                CALIBRATED
              </span>
            )}
          </>
        )}

        {/* Calibrated badge on mobile */}
        {isMobile && activeDrawing?.isCalibrated && (
          <span style={{ fontSize: '9px', color: '#22c55e', fontWeight: 700, background: 'rgba(34,197,94,.1)', padding: '2px 6px', borderRadius: '4px', flexShrink: 0 }}>
            ✓ CAL
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Auto-saving indicator */}
        {autoSaving && (
          <span style={{ fontSize: '11px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            <svg className="spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            {!isMobile && 'Saving…'}
          </span>
        )}

        {/* Extract button — hide on small mobile */}
        {!isMobile && (
          <button
            onClick={() => selectedDrawing && setShowExtractModal(true)}
            disabled={!selectedDrawing}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '4px 10px', borderRadius: '5px',
              border: '1px solid rgba(168,85,247,.35)',
              background: 'transparent', color: '#c084fc',
              fontSize: '11px', fontWeight: 600,
              cursor: selectedDrawing ? 'pointer' : 'not-allowed',
              opacity: selectedDrawing ? 1 : 0.3, flexShrink: 0,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
            </svg>
            Schedule Extract
          </button>
        )}

        {/* Export buttons */}
        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
          <button onClick={handleExport} disabled={takeoffItems.length === 0}
            title="Export to Excel"
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '4px 8px', borderRadius: '5px',
              border: '1px solid rgba(34,197,94,.25)',
              background: 'transparent', color: '#22c55e', fontSize: '11px', fontWeight: 600,
              cursor: takeoffItems.length > 0 ? 'pointer' : 'not-allowed',
              opacity: takeoffItems.length > 0 ? 1 : 0.3, touchAction: 'manipulation',
            }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            {!isMobile && 'Excel'}
          </button>
          <button onClick={handleExportPdf} disabled={takeoffItems.length === 0}
            title="Export to PDF"
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '4px 8px', borderRadius: '5px',
              border: '1px solid rgba(248,113,113,.25)',
              background: 'transparent', color: '#f87171', fontSize: '11px', fontWeight: 600,
              cursor: takeoffItems.length > 0 ? 'pointer' : 'not-allowed',
              opacity: takeoffItems.length > 0 ? 1 : 0.3, touchAction: 'manipulation',
            }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            {!isMobile && 'PDF'}
          </button>
        </div>

        {/* Data panel toggle */}
        <button onClick={() => {
          if (!bottomPinned) {
            setBottomPinned(true)
            setShowBottom(true)
          } else {
            setShowBottom(t => !t)
          }
        }} style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          padding: '4px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 600,
          border: `1px solid ${effectiveBottomOpen ? 'rgba(239,35,60,.35)' : 'rgba(255,255,255,.1)'}`,
          background: effectiveBottomOpen ? 'rgba(239,35,60,.12)' : 'transparent',
          color: effectiveBottomOpen ? '#EF233C' : '#64748b', cursor: 'pointer',
          transition: 'all .15s', flexShrink: 0, touchAction: 'manipulation',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="15" x2="21" y2="15"/>
          </svg>
          {!isMobile && (effectiveBottomOpen ? 'Hide' : 'Show')}
          {takeoffItems.length > 0 && (
            <span style={{ background: '#EF233C', color: '#fff', borderRadius: '10px', padding: '0 5px', fontSize: '9px' }}>
              {takeoffItems.length}
            </span>
          )}
        </button>

        {/* Mobile: Right panel toggle */}
        {isMobile && (
          <button
            onClick={() => { setRightOpen(o => !o); setSidebarOpen(false) }}
            style={{
              flexShrink: 0, background: rightOpen ? 'rgba(239,35,60,.12)' : 'transparent',
              border: `1px solid ${rightOpen ? 'rgba(239,35,60,.3)' : 'rgba(255,255,255,.1)'}`,
              borderRadius: '6px', padding: '5px 7px', cursor: 'pointer',
              color: rightOpen ? '#EF233C' : '#64748b', display: 'flex', alignItems: 'center',
              touchAction: 'manipulation',
            }}
            title="Scale & Units"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>
          </button>
        )}
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <Toolbar
        isCalibrated={!!activeDrawing?.isCalibrated}
        calibrateLineReady={!!(lastMeasurement?.pixelLength > 0 && !activeDrawing?.isCalibrated)}
        onPickMeasureTool={pickMeasureTool}
        onSaveCalib={handleSaveCalib}
        onCopyMeasurement={handleCopyMeasurement}
        onPasteMeasurement={handlePasteMeasurement}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canCopy={canCopyMeasurement}
        canPaste={canPasteMeasurement}
        canUndo={undoDepth > 0}
        canRedo={redoDepth > 0}
      />

      {/* ── Main work area ──────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, position: 'relative' }}>

        {/* Left workspace: drawings and member schedule */}
        {isMobile ? (
          <div
            className="panel-drawer"
            style={{
              position: 'fixed', top: 0, bottom: 0, left: 0, zIndex: 200,
              width: 'min(92vw, 420px)',
              transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
              display: 'flex', flexDirection: 'column',
              background: '#0B1320',
              boxShadow: sidebarOpen ? '4px 0 30px rgba(0,0,0,.7)' : 'none',
            }}
          >
            <div style={{ height: 42, display: 'flex', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,.07)' }}>
              {[
                { id: 'drawings', label: 'Drawings', Icon: Files, count: drawings.length },
                { id: 'members', label: 'Members', Icon: TableProperties, count: memberScheduleItems.length },
              ].map(({ id, label, Icon, count }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setLeftPanelTab(id)}
                  style={{
                    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    color: leftPanelTab === id ? '#EF233C' : '#64748b', background: 'transparent', border: 'none',
                    borderBottom: leftPanelTab === id ? '2px solid #EF233C' : '2px solid transparent',
                    fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  <Icon size={14} />
                  {label}
                  {count > 0 && <span style={{ fontSize: 9, color: '#fff', background: '#EF233C', borderRadius: 9, padding: '1px 5px' }}>{count}</span>}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
              {leftPanelTab === 'drawings' ? (
                <DrawingSidebar
                  width="100%"
                  drawings={drawings}
                  selectedDrawing={selectedDrawing}
                  onSelect={(d) => {
                    const norm = normalizeDrawing(d)
                    setSelectedDrawing(norm)
                    // Keep an Eye-enabled section visible while navigating
                    // between PDFs. The same Eye/location toggle is the only
                    // normal action that hides the saved section review.
                    setEditingSectionId(null)
                    clearAllSelection()
                    annotationMapRef.current = {}
                    setSidebarOpen(false)
                  }}
                  onUploaded={handleDrawingUploaded}
                  onDeleted={handleDrawingDeleted}
                />
              ) : (
                <MemberSchedulePanel drawing={activeDrawing} onExport={handleExport} onSelectMeasurement={handleRowSelect} selectedAnnotIds={selectedAnnotIds} onAssignMemberToSelection={handleAssignMemberToSelection} onDeleteMember={handleMemberScheduleDelete} />
              )}
            </div>
          </div>
        ) : (
          <SideDock
            side="left"
            title="Workspace"
            width={leftPanelWidth}
            minWidth={LEFT_DOCK_MIN_WIDTH}
            maxWidth={leftDockMaxWidth}
            open={leftPanelOpen}
            pinned={leftPanelPinned}
            hovered={leftHovered}
            resizing={isResizingLeft}
            tabs={[
              { id: 'drawings', label: 'Drawings', icon: Files, badge: drawings.length },
              { id: 'members', label: 'Member Schedule', icon: TableProperties, badge: memberScheduleItems.length },
            ]}
            activeTab={leftPanelTab}
            onOpenChange={setLeftPanelOpen}
            onPinnedChange={(pinned) => {
              setLeftPanelPinned(pinned)
              if (pinned) setLeftPanelOpen(true)
              else setLeftHovered(false)
            }}
            onHoveredChange={handleLeftDockHover}
            onActiveTabChange={setLeftPanelTab}
            onWidthChange={setLeftPanelWidth}
            onResizeStart={() => setIsResizingLeft(true)}
            onResizeEnd={() => setIsResizingLeft(false)}
          >
            {leftPanelTab === 'drawings' ? (
              <DrawingSidebar
                width="100%"
                drawings={drawings}
                selectedDrawing={selectedDrawing}
                onSelect={(d) => {
                  const norm = normalizeDrawing(d)
                  setSelectedDrawing(norm)
                  // Preserve section review visibility across PDF navigation.
                  setEditingSectionId(null)
                  clearAllSelection()
                  annotationMapRef.current = {}
                }}
                onUploaded={handleDrawingUploaded}
                onDeleted={handleDrawingDeleted}
              />
            ) : (
              <MemberSchedulePanel drawing={activeDrawing} onExport={handleExport} onSelectMeasurement={handleRowSelect} selectedAnnotIds={selectedAnnotIds} onAssignMemberToSelection={handleAssignMemberToSelection} onDeleteMember={handleMemberScheduleDelete} />
            )}
          </SideDock>
        )}

        {/* Center: PDF viewer + bottom panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {/* ── Not Calibrated banner ───────────────────────────── */}
          {selectedDrawing && !activeDrawing?.isCalibrated && (
            <div style={{
              flexShrink: 0,
              background: 'linear-gradient(90deg, rgba(245,158,11,.10), rgba(245,158,11,.05))',
              borderBottom: '1px solid rgba(245,158,11,.22)',
              padding: '9px 16px',
              display: 'flex', alignItems: 'center', gap: '10px',
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2" style={{ flexShrink: 0 }}>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#F59E0B' }}>Not Calibrated</span>
                <span style={{ fontSize: '12px', color: '#94a3b8', marginLeft: '6px' }}>
                  {isMobile
                    ? 'Draw a line to set scale.'
                    : 'Select Linear tool, draw along a labelled dimension to set the drawing scale.'}
                </span>
              </div>
              <button
                onClick={() => pickMeasureTool('line')}
                style={{
                  flexShrink: 0, padding: '5px 14px', borderRadius: '5px',
                  border: '1px solid rgba(245,158,11,.45)',
                  background: 'rgba(245,158,11,.12)', color: '#F59E0B',
                  fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Set Scale
              </button>
            </div>
          )}

          {/* PDF Viewer */}
          <div
            style={{ flex: '1 1 0', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}
            onContextMenu={handlePdfAreaContextMenu}
            onClick={ctxMenu ? closeCtxMenu : undefined}
          >
            <DrawingViewer
              key={`${selectedProject?.id ?? 'p'}-${selectedDrawing?.id ?? 'd'}`}
              drawingUrl={drawingUrl}
              drawing={activeDrawing}
              activeTool={activeTool}
              onMeasure={handleMeasure}
              annotations={takeoffItems.filter(t => t.pointsJson)}
              selectedAnnotationId={selectedViewerAnnotId}
              selectedAnnotationIds={selectedViewerAnnotIds}
              styleEditTargetId={styleEditTargetId}
              onAnnotationSelect={handleAnnotationSelect}
              onAnnotationContextMenu={handleAnnotationContextMenu}
              onClearSelection={() => {
                clearAllSelection()
                dismissFocusedSectionReview()
                // Selecting a measurement mirrors it into selectedMemberScheduleItem
                // (see syncToolbarFromTakeoffItem) so the Member Schedule panel and
                // the right panel's "Selected: X" banner highlight along with it —
                // but nothing was clearing that back out on deselect, so both kept
                // showing the old mark's name/highlight even after the grid and
                // canvas selection had genuinely cleared.
                useAppStore.getState().clearSelectedMemberScheduleItem?.()
              }}
              onMeasurementThicknessChange={handleMeasurementThicknessChange}
              onMeasurementGeometryChange={handleMeasurementGeometryChange}
              onMeasurementLabelSizeChange={handleMeasurementLabelSizeChange}
              sectionPlacementMode={activeTool === 'section' ? activeMeasurementSection : null}
              sectionPlacements={visibleSectionPlacements}
              sectionFocus={visibleSectionFocus}
              sectionEditMode={editingSectionId ? visibleSectionFocus : null}
              onSectionEditRequest={editMeasurementSectionById}
              onSectionSelection={handleSectionSelection}
              onSectionPlacement={handleSectionPlacement}
              resolveMeasurementDbId={resolveMeasurementDbId}
              getProtectedAnnotIds={() => persistedAnnotIdsRef.current}
              measureReleaseRef={measureReleaseRef}
              onAnnotationsBlob={async (blobBase64) => {
                const { selectedDrawing: drw } = useAppStore.getState()
                if (!drw) return
                try {
                  // Save blob silently — patch local state only (no refetch / scale reset)
                  await drawingService.saveAnnotations(drw.id, blobBase64)
                  setSelectedDrawing({ ...drw, annotationData: blobBase64 })
                } catch (_) {}
              }}
            />

            {/* Right-click context menu */}
            {ctxMenu && (
              <div
                style={{
                  position: 'fixed',
                  top: ctxMenu.y,
                  left: ctxMenu.x,
                  zIndex: 9999,
                  background: '#0D1526',
                  border: '1px solid rgba(239,35,60,0.4)',
                  borderRadius: 6,
                  minWidth: 160,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                  overflow: 'hidden',
                }}
                onClick={e => { e.stopPropagation(); closeCtxMenu() }}
              >
                {selectedMeasurementCount > 1 && (
                  <div style={{ padding: '7px 16px', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                    {selectedMeasurementCount} selected
                  </div>
                )}
                {canCopyMeasurement && (
                  <button
                    onClick={() => { handleCopyMeasurement(); closeCtxMenu() }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 16px', background: 'transparent', border: 'none', color: '#e2e8f0', fontSize: 13, cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,35,60,0.15)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {selectedMeasurementCount > 1 ? `Copy ${selectedMeasurementCount} Measurements` : 'Copy Measurement'}
                  </button>
                )}
                {canPasteMeasurement && (
                  <button
                    onClick={() => { handlePasteMeasurement(); closeCtxMenu() }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 16px', background: 'transparent', border: 'none', color: '#e2e8f0', fontSize: 13, cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,35,60,0.15)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {measurementClipboard?.items?.length > 1 ? `Paste ${measurementClipboard.items.length} Measurements` : 'Paste Measurement'}
                  </button>
                )}
                {!canCopyMeasurement && !canPasteMeasurement && (
                  <div style={{ padding: '9px 16px', color: '#64748b', fontSize: 13 }}>
                    Select a measurement to copy
                  </div>
                )}
                {canCopyMeasurement && (
                  <>
                    <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '2px 0' }} />
                    <button
                      onClick={() => {
                        handleDeleteSelectedMeasurements().catch(() => {})
                        closeCtxMenu()
                      }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 16px', background: 'transparent', border: 'none', color: '#f87171', fontSize: 13, cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,35,60,0.15)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                    >
                      {selectedMeasurementCount > 1 ? `Delete ${selectedMeasurementCount} Measurements` : 'Delete'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <BottomDock
            title={bottomView === 'sections' ? 'Section Measurements' : 'Measurements'}
            height={bottomH}
            minHeight={180}
            maxHeight={bottomDockMaxHeight}
            open={showBottom}
            pinned={bottomPinned}
            hovered={bottomHovered}
            resizing={isDraggingBottom}
            count={bottomView === 'sections' ? measurementSections.length : takeoffItems.length}
            summary={bottomView === 'sections'
              ? (measurementSections.length > 0
                ? `${measurementSections.reduce((total, section) => total + Number(section.usedPlaces ?? section.placements?.length ?? 0), 0)} counted place(s)`
                : null)
              : (takeoffItems.length > 0 ? `${takeoffItems.length} item${takeoffItems.length === 1 ? '' : 's'}` : null)}
            onOpenChange={setShowBottom}
            onPinnedChange={(pinned) => {
              setBottomPinned(pinned)
              if (pinned) setShowBottom(true)
              else setBottomHovered(false)
            }}
            onHoveredChange={handleBottomDockHover}
            onHeightChange={setBottomH}
            onResizeStart={() => setIsDraggingBottom(true)}
            onResizeEnd={() => setIsDraggingBottom(false)}
          >
            <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{
                flexShrink: 0, height: 34, display: 'flex', alignItems: 'center', gap: 5,
                padding: '0 10px', background: '#090F1B', borderBottom: '1px solid rgba(255,255,255,.06)',
              }}>
                <button type="button" onClick={() => setBottomView('measurements')} style={{
                  ...bottomViewTabStyle,
                  color: bottomView === 'measurements' ? '#fff' : '#64748b',
                  background: bottomView === 'measurements' ? 'rgba(239,35,60,.14)' : 'transparent',
                  borderColor: bottomView === 'measurements' ? 'rgba(239,35,60,.35)' : 'transparent',
                }}><TableProperties size={12} /> Measurements <b>{takeoffItems.length}</b></button>
                <button type="button" onClick={() => setBottomView('sections')} style={{
                  ...bottomViewTabStyle,
                  color: bottomView === 'sections' ? '#fff' : '#64748b',
                  background: bottomView === 'sections' ? 'rgba(239,35,60,.14)' : 'transparent',
                  borderColor: bottomView === 'sections' ? 'rgba(239,35,60,.35)' : 'transparent',
                }}><Layers3 size={12} /> Sections <b>{measurementSections.length}</b></button>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {bottomView === 'measurements' ? (
                  <MeasurementTable
                    drawing={activeDrawing}
                    selectedId={selectedAnnotId}
                    selectedIds={selectedAnnotIds}
                    onRowSelect={handleRowSelect}
                    onSelectAll={handleSelectAllRows}
                    onDelete={handleRowDelete}
                    onBeforeUpdate={() => recordUndoSnapshot('edit measurement')}
                    onUpdateFailed={discardUndoSnapshot}
                    onAddClick={() => { setPendingMeas(null); setShowAddModal(true) }}
                  />
                ) : (
                  <SectionMeasurementsPanel
                    sections={measurementSections}
                    activeSectionId={activeSectionId}
                    placing={activeTool === 'section' && Boolean(activeSectionId)}
                    onCreate={startSectionSelection}
                    onActivate={activateMeasurementSection}
                    onStop={stopSectionPlacement}
                    onDelete={deleteMeasurementSection}
                    onUndoLastPlacement={undoSectionPlacement}
                    onViewSource={viewMeasurementSectionSource}
                    onEdit={editMeasurementSection}
                    drawings={drawings}
                    focusedSectionId={focusedSectionId}
                    editingSectionId={editingSectionId}
                  />
                )}
              </div>
            </div>
          </BottomDock>
        </div>

        {/* Right panel */}
        {isMobile ? (
          <div
            className="panel-drawer"
            style={{
              position: 'fixed', top: 0, bottom: 0, right: 0, zIndex: 200,
              width: 'min(88vw, 360px)',
              transform: rightOpen ? 'translateX(0)' : 'translateX(100%)',
              display: 'flex', flexDirection: 'column',
              boxShadow: rightOpen ? '-4px 0 30px rgba(0,0,0,.7)' : 'none',
            }}
          >
            <RightPanel
              width="100%"
              drawing={activeDrawing}
              lastMeasurement={lastMeasurement}
              selectedItem={selectedAnnotItem}
              summary={summary}
              onCalibrated={handleCalibrated}
              onQuickScale={handleQuickScale}
              onCalibrateScale={handleCalibrateScaleClick}
              onResetCalibration={handleResetCalibration}
            />
          </div>
        ) : (
          <SideDock
            side="right"
            title="Properties & Calibration"
            width={rightPanelWidth}
            minWidth={250}
            maxWidth={rightDockMaxWidth}
            open={rightPanelOpen}
            pinned={rightPanelPinned}
            hovered={rightHovered}
            resizing={isResizingRight}
            activeTab="panel"
            onOpenChange={setRightPanelOpen}
            onPinnedChange={(pinned) => {
              setRightPanelPinned(pinned)
              if (pinned) setRightPanelOpen(true)
              else setRightHovered(false)
            }}
            onHoveredChange={handleRightDockHover}
            onWidthChange={setRightPanelWidth}
            onResizeStart={() => setIsResizingRight(true)}
            onResizeEnd={() => setIsResizingRight(false)}
          >
            <RightPanel
              width="100%"
              drawing={activeDrawing}
              lastMeasurement={lastMeasurement}
              selectedItem={selectedAnnotItem}
              summary={summary}
              onCalibrated={handleCalibrated}
              onQuickScale={handleQuickScale}
              onCalibrateScale={handleCalibrateScaleClick}
              onResetCalibration={handleResetCalibration}
            />
          </SideDock>
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────── */}
      {sectionSelection && (
        <SectionMeasurementModal
          selection={sectionSelection}
          existingNames={measurementSections
            .filter(section => Number(section.id) !== Number(editingSectionId))
            .map(section => section.name)}
          saving={sectionSaving}
          error={sectionError}
          mode={editingSectionId ? 'edit' : 'create'}
          initialName={editingMeasurementSection?.name ?? ''}
          onSave={saveMeasurementSection}
          onCancel={() => {
            if (sectionSaving) return
            setSectionSelection(null)
            setSectionError('')
            if (editingSectionId) {
              setEditingSectionId(null)
              setActiveTool('select')
            }
          }}
        />
      )}

      {detectedMemberPrompt && (
        <AddDetectedMemberModal
          key={`${detectedMemberPrompt.drawingId}:${detectedMemberPrompt.detectedValue}`}
          detectedValue={detectedMemberPrompt.detectedValue}
          color={detectedMemberPrompt.color}
          saving={detectedMemberSaving}
          error={detectedMemberError}
          onAdd={handleAddDetectedMember}
          onCancel={() => finishDetectedMemberPrompt(null)}
        />
      )}

      {showCalModal && (
        <CalibrationModal
          key={`cal-${lastMeasurement?.annotationId ?? 'x'}`}
          defaultUnit={activeDrawing?.calibrationUnit ?? activeUnit ?? 'Mm'}
          isFirstMeasure={scaleSetupFirstMeasure}
          measuredPx={lastMeasurement?.pixelLength ?? null}
          saving={calSaving}
          onApply={handleCalibrationApply}
          onClose={() => {
            // Cancelling ALWAYS means "don't keep this as the calibration
            // reference" — true whether it's the first-ever calibration or a
            // later re-calibration attempt. The drawn line was never saved as
            // a real takeoff row (handleMeasure's calibrate branch only ever
            // stages it in pendingCalibMeasureRef), so without this it was
            // being left as a permanently orphaned annotation on the canvas —
            // visible, unlabeled, and with nothing in the grid to delete.
            if (lastMeasurement?.annotationId) {
              triggerPdfCommand({
                type: 'deleteAnnotation',
                annotationId: lastMeasurement.annotationId,
                pageNumber: lastMeasurement.pageNumber ?? 1,
              })
            }
            setShowCalModal(false)
            setScaleSetupFirstMeasure(false)
            pendingCalibMeasureRef.current = null
            calibrateOnlyRef.current = false
            calibrationDrawPendingRef.current = false
          }}
        />
      )}

      {showAddModal && (
        <AddMeasurementModal
          drawing={selectedDrawing}
          measurement={pendingMeas}
          onAdded={handleItemAdded}
          onBeforeAdd={() => recordUndoSnapshot('create measurement')}
          onAddFailed={discardUndoSnapshot}
          onClose={() => { setShowAddModal(false); setPendingMeas(null) }}
        />
      )}

      {showExtractModal && selectedDrawing && (
        <ExtractionModal
          drawingId={selectedDrawing.id}
          drawingName={selectedDrawing.name}
          onClose={() => setShowExtractModal(false)}
          onSaved={handleExtractionSaved}
        />
      )}

    </div>
  )
}
