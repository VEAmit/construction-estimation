import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { drawingService } from '../services/drawingService'
import { takeoffService } from '../services/takeoffService'
import { memberScheduleService } from '../services/memberScheduleService'
import { useAppStore } from '../store/useAppStore'
import { useBreakpoint } from '../utils/useBreakpoint'
import DrawingSidebar from '../components/drawings/DrawingSidebar'
import DrawingViewer from '../components/drawings/DrawingViewer'
import Toolbar from '../components/tools/Toolbar'
import RightPanel from '../components/tools/RightPanel'
import MeasurementTable from '../components/takeoff/TakeoffTable'
import MemberSchedulePanel from '../components/takeoff/MemberSchedulePanel'
import AddMeasurementModal from '../components/takeoff/AddTakeoffModal'
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
import { buildLinearMeasurementClipboard, isValidLinearMeasurementForCopy } from '../utils/measureLabel'
import { resolveDrawColorForMemberMark } from '../utils/memberMarkColor'
import { getMeasurementMemberMark } from '../utils/memberMeasureLink'
import ExtractionModal from '../components/extraction/ExtractionModal'
import toast from 'react-hot-toast'
import { Files, TableProperties } from 'lucide-react'
import { BottomDock, SideDock } from '../components/layout/WorkspaceDock'

const _MS_PALETTE = ['#3B82F6','#22C55E','#F97316','#A855F7','#06B6D4','#EAB308','#EC4899','#EF4444','#14B8A6','#F59E0B','#6366F1','#84CC16']
const _MS_HEX = /^#[0-9A-Fa-f]{6}$/
const DOCK_LAYOUT_VERSION = 2
const LEGACY_DOCK_LAYOUT_VERSION = 1
const LEFT_DOCK_MIN_WIDTH = 250
const LEFT_DOCK_DEFAULT_WIDTH = 290
const LEFT_DOCK_MIGRATION_WIDTH = 300
const LEFT_DOCK_MAX_WIDTH = 420

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
    geometry,
  }]
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

export default function DrawingsPage() {
  const navigate = useNavigate()
  const { isMobile, isTablet } = useBreakpoint()

  const {
    selectedProject, setSelectedProject,
    drawings: storeDrawings, setDrawings, selectedDrawing, setSelectedDrawing,
    takeoffItems, addTakeoffItem, setTakeoffItems, updateTakeoffItem,
    setSummary, activeTool, setActiveTool, setActiveUnit, activeUnit, updateDrawingCalibration,
    memberScheduleItems, setMemberScheduleItems, setMemberScheduleSummary, updateMemberScheduleItem,
    setSelectedMemberScheduleItem,
    triggerPdfCommand,
    _hydrated,
    measureColor, lineThickness, lineStyle, arrowStyle, measureCategory,
    measureLabelFontSize, setMeasureLabelFontSize,
    measurementClipboard, setMeasurementClipboard, clearPasteAnchor,
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

  const readThicknessFromPointsJson = useCallback((pointsJson) => {
    if (!pointsJson) return null
    try {
      const d = JSON.parse(pointsJson)
      const t = d.Thickness ?? d.thickness
      return t != null && Number.isFinite(Number(t)) && Number(t) > 0 ? Number(t) : null
    } catch {
      return null
    }
  }, [])

  const readLabelSizeFromPointsJson = useCallback((pointsJson) => {
    if (!pointsJson) return null
    try {
      const d = JSON.parse(pointsJson)
      const s = d.labelUserFontSize ?? d.LabelUserFontSize
      return s != null && Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : null
    } catch {
      return null
    }
  }, [])

  const syncToolbarFromTakeoffItem = useCallback((item) => {
    if (!item) return
    // Prefer stored item color; fall back to MSI palette color for that mark
    const HEX_RE = /^#[0-9A-Fa-f]{6}$/
    if (item.color && HEX_RE.test(item.color)) {
      setMeasureColor(item.color)
    } else {
      const memberMark = (item.material || item.mark || '').trim().toLowerCase()
      if (memberMark) {
        const msi = useAppStore.getState().memberScheduleItems
          .find(m => (m.mark || '').trim().toLowerCase() === memberMark)
        if (msi?.color && HEX_RE.test(msi.color)) setMeasureColor(msi.color)
      }
    }
    const t = readThicknessFromPointsJson(item.pointsJson)
    if (t != null) setLineThickness(t)
    // Reflect this item's own current label size in the toolbar so the S/M/L/XL
    // buttons and the custom pt input show what's actually on the drawing —
    // otherwise the control kept showing whatever was last used elsewhere,
    // and changing it appeared to do nothing to the label you just selected.
    const labelSize = readLabelSizeFromPointsJson(item.pointsJson)
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
  const labelSizeSaveTimersRef = useRef(new Map())
  const measureReleaseRef = useRef(null)
  // Last auto-saved measurement — Clear removes it; mark reused on next draw after Clear
  const pendingMeasurementRef = useRef(null)
  const clearedMarkRef = useRef(null)
  const pendingCalibMeasureRef = useRef(null)
  const calibrateOnlyRef = useRef(false)

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
    try {
      const raw = JSON.parse(currentItem.pointsJson)
      const existing = raw.labelUserFontSize ?? raw.LabelUserFontSize
      if (existing == null || Number(existing) !== size) {
        const pointsJson = JSON.stringify({ ...raw, labelUserFontSize: size, LabelUserFontSize: size })
        updateTakeoffItem({ ...currentItem, pointsJson })
      }
    } catch (_) { return }

    const existingTimer = labelSizeSaveTimersRef.current.get(dbId)
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
  }, [resolveMeasurementDbId, updateTakeoffItem])

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

  const appendLinkedOccurrenceNotes = useCallback((notes, linkedItemId, occurrenceId) => {
    const parts = String(notes ?? '')
      .split(';')
      .map(p => p.trim())
      .filter(Boolean)
      .filter(p => !/^linkedItem:/i.test(p) && !/^occurrence:/i.test(p))
    if (linkedItemId != null) parts.push(`linkedItem:${linkedItemId}`)
    if (occurrenceId) parts.push(`occurrence:${occurrenceId}`)
    return parts.join(';')
  }, [])

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
      prev.lineStyle !== current.lineStyle ||
      prev.arrowStyle !== current.arrowStyle
    const labelSizeChanged = prev.labelFontSize !== current.labelFontSize

    if (!styleChanged && !labelSizeChanged) return
    annotStyleBaselineRef.current = current

    // Label size shares the same debounced pipeline as hover+scroll resize —
    // see handleMeasurementLabelSizeChange for why (avoids the two racing).
    if (labelSizeChanged) {
      handleMeasurementLabelSizeChange({ dbId: selectedAnnotId, size: current.labelFontSize })
    }
    if (!styleChanged) return

    // Re-read live (not the `takeoffItems` this render closed over) in case
    // the label-size call just above already updated this same item's
    // pointsJson — using a stale snapshot here would silently revert it.
    const item = (useAppStore.getState().takeoffItems ?? []).find(t => t.id === selectedAnnotId)
    if (!item) return

    const optimistic = { ...item, color: measureColor, category: measureCategory }
    updateTakeoffItem(optimistic)
    takeoffService.update(optimistic)
      .then(saved => updateTakeoffItem(saved))
      .catch(() => {})
  }, [measureColor, measureCategory, lineStyle, arrowStyle, measureLabelFontSize, selectedAnnotId, styleEditTargetId, handleMeasurementLabelSizeChange, updateTakeoffItem])  // eslint-disable-line react-hooks/exhaustive-deps

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
    setSelectedDrawing(null)
    setDrawings([])
    drawingService.getByProject(selectedProject.id)
      .then(data => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : (data ? [data] : [])
        const normalized = list.map(normalizeDrawing).filter(Boolean)
        setDrawings(normalized)
        if (normalized.length > 0) setSelectedDrawing(normalized[0])
      })
      .catch(() => { if (!cancelled) toast.error('Failed to load drawings') })
    return () => { cancelled = true }
  }, [selectedProject?.id])  // eslint-disable-line react-hooks/exhaustive-deps

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
      setMemberScheduleItems([])
      useAppStore.getState().clearSelectedMemberScheduleItem?.()
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
      memberScheduleService.getByDrawing(selectedDrawing.id),
      memberScheduleService.getSummary(selectedDrawing.id),
    ])
      .then(async ([items, sum, members, memberSum]) => {
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
        setTakeoffItems(finalItems)
        setSummaryLocal(sum)
        setSummary(sum)
        setMemberScheduleItems(assignMemberColors(members))
        setMemberScheduleSummary(memberSum)
        const map = {}
        finalItems.forEach(item => {
          if (!item.pointsJson) return
          try {
            const annotationIds = extractTakeoffAnnotationIds(item.pointsJson)
            const annotId = annotationIds[0]
            if (!annotId) return
            const stored = readTakeoffPointsJson(item.pointsJson) ?? {}
            const firstGeometry = buildTakeoffOccurrencesFromItem(item)[0]?.geometry ?? stored
            const page0 = stored.page != null
              ? parseInt(stored.page, 10)
              : (firstGeometry.pageIndex ?? firstGeometry.page ?? 0)
            map[item.id] = { annotationId: annotId, annotationIds, pageNumber: page0 + 1 }
          } catch (_) {}
        })
        annotationMapRef.current = map
        persistedAnnotIdsRef.current = new Set(
          finalItems.flatMap(item => extractTakeoffAnnotationIds(item.pointsJson)).filter(Boolean)
        )
      })
      .catch(() => toast.error('Failed to load drawing data'))
  }, [selectedDrawing?.id, updateTakeoffItem, triggerPdfCommand])

  const deletePendingMeasurement = useCallback(async (pending, { silent = false } = {}) => {
    if (!pending || persistedAnnotIdsRef.current.has(pending.annotationId)) return false
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
      if (!silent) toast.error('Failed to clear measurement')
      return false
    }
  }, [removeTakeoffItem, selectedAnnotId, selectedDrawing, selectedViewerAnnotId, setSummary, triggerPdfCommand])

  const scheduleAnnotationBlobSave = useCallback(() => {
    if (blobSaveTimerRef.current) clearTimeout(blobSaveTimerRef.current)
    blobSaveTimerRef.current = setTimeout(() => {
      triggerPdfCommand('saveAnnotationBlob')
    }, 1500)
  }, [triggerPdfCommand])

  useEffect(() => () => {
    if (blobSaveTimerRef.current) clearTimeout(blobSaveTimerRef.current)
    geometrySaveTimersRef.current.forEach(t => clearTimeout(t))
    geometrySaveTimersRef.current.clear()
    labelSizeSaveTimersRef.current.forEach(t => clearTimeout(t))
    labelSizeSaveTimersRef.current.clear()
  }, [])

  const pickMeasureTool = useCallback((toolId) => {
    // Bluebeam: clicking Linear on an uncalibrated drawing auto-redirects to calibrate mode.
    // Catches both toolbar clicks and keyboard shortcut (L key) via Toolbar's pickTool().
    if (toolId === 'line') {
      const drw = normalizeDrawing(useAppStore.getState().selectedDrawing)
      if (drw && !drw.isCalibrated) {
        setActiveTool('calibrate')
        triggerPdfCommand('ensureMeasureMode')
        return
      }
    }
    setActiveTool(toolId)
    triggerPdfCommand('ensureMeasureMode')
  }, [setActiveTool, triggerPdfCommand])

  const autoSave = useCallback(async (measurement, { calibratedDrawing, isPaste = false } = {}) => {
    console.log('[BT-Lifecycle] autoSave called — length:', measurement?.length, 'unit:', measurement?.unit, 'annotationId:', measurement?.annotationId)
    const {
      selectedDrawing: drw, takeoffItems: current, measureColor: color,
      measureCategory: category, activeUnit,
      selectedMemberScheduleItem,
    } = useAppStore.getState()
    const linkedMember = selectedMemberScheduleItem
    const payloadMemberMark = (
      (measurement.memberMark || '').trim()
      || (measurement.drawingMark || '').trim()
      || (measurement.material || '').trim()
      || ''
    )
    const linkedMemberMark = linkedMember?.mark?.trim() || linkedMember?.Mark?.trim() || ''
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
    const saveNotes = isPaste
      ? appendLinkedOccurrenceNotes(baseNotes, linkedRootItemId, measurement.occurrenceId)
      : baseNotes

    try {
      const pointsJson = buildPointsJson()
      if (isPaste && linkedRootItemId != null && pointsJson) {
        const rootId = Number(linkedRootItemId)
        const rootItem = (useAppStore.getState().takeoffItems ?? [])
          .find(t => Number(t.id) === rootId)
        const newGeometry = readTakeoffPointsJson(pointsJson)
        const annotationName = getRawAnnotationId(newGeometry) ?? measurement.annotationId
        if (rootItem && newGeometry && annotationName) {
          const existingOccurrences = buildTakeoffOccurrencesFromItem(rootItem)
          const occurrenceId = measurement.occurrenceId ?? newGeometry.OccurrenceId ?? newGeometry.occurrenceId ?? annotationName
          const cleanNewGeometry = stripOccurrenceContainer({
            ...newGeometry,
            annotationId: annotationName,
            AnnotName: annotationName,
            name: annotationName,
            ItemId: rootId,
            itemId: rootId,
            OccurrenceId: occurrenceId,
            occurrenceId,
            CustomData: {
              ...(newGeometry.CustomData ?? {}),
              ItemId: rootId,
              OccurrenceId: occurrenceId,
            },
            customData: {
              ...(newGeometry.customData ?? {}),
              itemId: rootId,
              occurrenceId,
            },
          })
          const nextOccurrences = existingOccurrences.some(occ => occ.annotationName === annotationName)
            ? existingOccurrences
            : [
                ...existingOccurrences,
                {
                  occurrenceId,
                  itemId: rootId,
                  pageNumber: measurement.pageNumber ?? cleanNewGeometry.pageNumber ?? cleanNewGeometry.PageNumber ?? 1,
                  annotationName,
                  position: null,
                  rotation: cleanNewGeometry.RotateAngle ?? cleanNewGeometry.rotateAngle ?? 0,
                  createdAt: new Date().toISOString(),
                  isRoot: false,
                  geometry: cleanNewGeometry,
                },
              ]
          const rootRaw = readTakeoffPointsJson(rootItem.pointsJson) ?? {}
          const rootGeometry = stripOccurrenceContainer(rootRaw)
          const occurrencePointsJson = JSON.stringify({
            ...rootGeometry,
            occurrenceModelVersion: 1,
            itemId: rootId,
            ItemId: rootId,
            occurrences: nextOccurrences,
          })
          const optimisticRoot = {
            ...rootItem,
            quantity: Math.max(1, nextOccurrences.length),
            pointsJson: occurrencePointsJson,
          }
          updateTakeoffItem(optimisticRoot)
          const savedRoot = await takeoffService.update(optimisticRoot)
          updateTakeoffItem(savedRoot)
          annotationMapRef.current[rootId] = {
            annotationId: extractTakeoffAnnotationIds(savedRoot.pointsJson)[0] ?? annotationName,
            annotationIds: extractTakeoffAnnotationIds(savedRoot.pointsJson),
            pageNumber: measurement.pageNumber ?? 1,
          }
          persistedAnnotIdsRef.current.add(annotationName)
          setShowBottom(true)
          setSelectedAnnotId(savedRoot.id)
          setSelectedViewerAnnotId(String(annotationName))
          selectedOccurrenceAnnotIdRef.current = String(annotationName)
          setStyleEditTargetId(null)
          annotStyleBaselineRef.current = null
          pendingMeasurementRef.current = {
            dbId: savedRoot.id,
            annotationId: annotationName,
            mark: savedRoot.mark,
            pageNumber: measurement.pageNumber ?? 1,
            pendingThickness: isPaste
              ? (measurement.thickness ?? cleanNewGeometry.thickness ?? cleanNewGeometry.Thickness ?? 2)
              : (pendingMeasurementRef.current?.pendingThickness ?? useAppStore.getState().lineThickness),
            rawPointsJson: cleanNewGeometry,
          }
          lastCopyTargetRef.current = savedRoot.id
          takeoffService.getSummary(drw.id)
            .then(sum => { setSummaryLocal(sum); setSummary(sum) })
            .catch(() => {})
          toast.success(`${savedRoot.mark || saveMaterial || 'Measurement'} occurrence added`, { duration: 2200 })
          return true
        }
      }
      const saved = await takeoffService.create({
        drawingId:   drw.id,
        itemType,
        mark:        nextMark,
        description: desc,
        quantity:    isCount ? measurement.count : (isPaste ? (measurement.quantity ?? 1) : 1),
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
      let finalSaved = saved
      const latestThick = isPaste
        ? null
        : (pendingMeasurementRef.current?.pendingThickness ?? useAppStore.getState().lineThickness)
      if (latestThick != null && pointsJson) {
        try {
          const raw = JSON.parse(pointsJson)
          if (Number(raw.thickness) !== Number(latestThick)) {
            const patchedJson = JSON.stringify({ ...raw, thickness: Number(latestThick), Thickness: Number(latestThick) })
            finalSaved = await takeoffService.update({ ...saved, pointsJson: patchedJson })
          }
        } catch (_) {}
      }
      addTakeoffItem(finalSaved)
      if (isPaste && linkedRootItemId != null) {
        try {
          const rootId = Number(linkedRootItemId)
          const rowsAfterPaste = useAppStore.getState().takeoffItems ?? []
          const occurrenceCount = countLinkedOccurrences(rowsAfterPaste, rootId)
          const rootItem = rowsAfterPaste.find(t => Number(t.id) === rootId)
          if (rootItem && occurrenceCount > 0 && Number(rootItem.quantity ?? 1) !== occurrenceCount) {
            const updatedRoot = await takeoffService.update({ ...rootItem, quantity: occurrenceCount })
            updateTakeoffItem(updatedRoot)
          }
        } catch (err) {
          console.warn('[BuildTakeoff] linked occurrence quantity update failed:', err)
        }
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
        annotationMapRef.current[finalSaved.id] = {
          annotationId: measurement.annotationId,
          annotationIds: [measurement.annotationId],
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
    appendLinkedOccurrenceNotes,
    countLinkedOccurrences,
  ])

  const handleMeasure = useCallback((measurement, opts = {}) => {
    const { activeTool: currentTool } = useAppStore.getState()
    console.log('[BT-Lifecycle] handleMeasure — tool:', currentTool, 'length:', measurement?.length, 'unit:', measurement?.unit, 'annotationId:', measurement?.annotationId)

    if (currentTool === 'calibrate') {
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
        savedFirst = await autoSave(measureToSave, { calibratedDrawing: updated })
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
  }, [lastMeasurement, selectedDrawing, triggerPdfCommand, updateDrawingCalibration, setActiveUnit, updateTakeoffItem, autoSave])

  const handleQuickScale = useCallback(async (scaleRatio, unit) => {
    if (!selectedDrawing) return
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
  }, [selectedDrawing, triggerPdfCommand, updateDrawingCalibration, setActiveUnit, updateTakeoffItem])

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
      syncToolbarFromTakeoffItem(item)
      const annot = annotationMapRef.current[dbId]
      const occurrenceId = annot?.annotationId == null ? null : String(annot.annotationId)
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
      syncToolbarFromTakeoffItem(takeoffItems.find(t => t.id === primaryDbId))
      const primaryAnnot = annotationMapRef.current[primaryDbId]
      const primaryOccurrenceId = primaryAnnot?.annotationId == null ? null : String(primaryAnnot.annotationId)
      selectedOccurrenceAnnotIdRef.current = primaryOccurrenceId
      setSelectedViewerAnnotId(primaryOccurrenceId)
    } else {
      selectedOccurrenceAnnotIdRef.current = null
      setSelectedViewerAnnotId(null)
    }
  }, [triggerPdfCommand, takeoffItems, syncToolbarFromTakeoffItem])

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
      const existing = raw.thickness ?? raw.Thickness
      if (existing != null && Number(existing) === Number(thickness)) return
      const pointsJson = JSON.stringify({ ...raw, thickness, Thickness: thickness })
      const optimistic = { ...item, pointsJson }
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
        }
      }
    } catch (_) {}
  }, [takeoffItems, updateTakeoffItem, selectedAnnotId, measureColor, lineStyle, arrowStyle, resolveMeasurementDbId, extractAnnotIdFromPointsJson])

  const handleMeasurementGeometryChange = useCallback((payload) => {
    const annotId = payload?.annotationId
    const dbId = payload?.dbId ?? resolveMeasurementDbId(annotId)
    if (dbId == null || !payload?.rawAnnotation) return

    const existingTimer = geometrySaveTimersRef.current.get(dbId)
    if (existingTimer) clearTimeout(existingTimer)

    const timer = setTimeout(async () => {
      geometrySaveTimersRef.current.delete(dbId)
      const item = (useAppStore.getState().takeoffItems ?? []).find(t => t.id === dbId)
      if (!item?.pointsJson) return

      try {
        const previousRaw = JSON.parse(item.pointsJson)
        const movedRaw = JSON.parse(JSON.stringify(payload.rawAnnotation))
        const stableAnnotId = annotId ?? previousRaw.annotationId ?? previousRaw.AnnotName ?? previousRaw.name
        const mergeGeometry = (baseRaw) => ({
          ...baseRaw,
          ...movedRaw,
          annotationId: stableAnnotId,
          AnnotName: stableAnnotId,
          name: stableAnnotId,
          strokeColor: baseRaw.strokeColor ?? baseRaw.StrokeColor ?? movedRaw.strokeColor,
          StrokeColor: baseRaw.StrokeColor ?? baseRaw.strokeColor ?? movedRaw.StrokeColor,
          thickness: baseRaw.thickness ?? baseRaw.Thickness ?? movedRaw.thickness,
          Thickness: baseRaw.Thickness ?? baseRaw.thickness ?? movedRaw.Thickness,
        })
        let mergedRaw
        if (Array.isArray(previousRaw.occurrences) && previousRaw.occurrences.length) {
          let updatedOccurrence = false
          const nextOccurrences = previousRaw.occurrences.map(occ => {
            const geometry = stripOccurrenceContainer(occ?.geometry ?? occ?.rawAnnotation ?? occ)
            const occurrenceAnnotId = occ?.annotationName ?? getRawAnnotationId(geometry)
            if (occurrenceAnnotId !== stableAnnotId) return occ
            updatedOccurrence = true
            return {
              ...occ,
              annotationName: stableAnnotId,
              pageNumber: payload.pageNumber ?? occ.pageNumber ?? geometry.pageNumber ?? 1,
              rotation: movedRaw.RotateAngle ?? movedRaw.rotateAngle ?? occ.rotation ?? 0,
              geometry: mergeGeometry(geometry),
            }
          })
          mergedRaw = {
            ...previousRaw,
            occurrences: updatedOccurrence ? nextOccurrences : previousRaw.occurrences,
          }
        } else {
          mergedRaw = mergeGeometry(previousRaw)
        }
        const unit = payload.unit ?? item.unit ?? activeUnit
        const nextLength = Number.isFinite(Number(payload.length)) && Number(payload.length) > 0
          ? Number(payload.length)
          : item.length
        const next = {
          ...item,
          unit,
          length: nextLength,
          description: formatLineMeasureDescription(payload.pixelLength, nextLength, unit, getCalibratedDrawingFromStore()),
          pointsJson: JSON.stringify(mergedRaw),
        }
        updateTakeoffItem(next)
        const saved = await takeoffService.update(next)
        updateTakeoffItem(saved)
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
  }, [resolveMeasurementDbId, activeUnit, updateTakeoffItem, selectedDrawing, setSummary, scheduleAnnotationBlobSave])

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
  const buildClipboardItemFor = useCallback((targetId) => {
    const item = takeoffItems.find(t => t.id === targetId)
    if (!item?.pointsJson || (item.itemType || 'Line') !== 'Line') return null
    if (!isValidLinearMeasurementForCopy(item)) return null
    try {
      const raw = JSON.parse(item.pointsJson)
      // Prefer this specific item's own occurrence id (relevant when copying
      // several items at once, each potentially selected via a different
      // occurrence) — fall back to the shared "current" occurrence ref for
      // the solo-select case, exactly as before.
      const ownOccurrenceId = annotationMapRef.current[targetId]?.annotationId
      const selectedOccurrenceId = ownOccurrenceId ?? selectedOccurrenceAnnotIdRef.current
      const selectedOccurrence = selectedOccurrenceId
        ? buildTakeoffOccurrencesFromItem(item).find(
          occ => String(occ.annotationName) === String(selectedOccurrenceId)
        )
        : null
      const copyRaw = selectedOccurrence?.geometry ?? stripOccurrenceContainer(raw)
      return buildLinearMeasurementClipboard(item, copyRaw, pdfScale)
    } catch {
      return null
    }
  }, [takeoffItems, pdfScale])

  const handleCopyMeasurement = useCallback(() => {
    const idsToUse = selectedAnnotIds.size > 1 ? [...selectedAnnotIds] : [resolveCopyTargetId()].filter(id => id != null)
    const items = idsToUse.map(buildClipboardItemFor).filter(Boolean)

    if (!items.length) {
      toast.error(idsToUse.length > 1 ? 'No copyable linear measurements in selection' : 'Draw or select a linear measurement to copy')
      return
    }
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
    if (idsToUse[0] != null) lastCopyTargetRef.current = idsToUse[0]
    if (items.length > 1) toast.success(`${items.length} measurements copied`)
  }, [selectedAnnotIds, resolveCopyTargetId, buildClipboardItemFor, setMeasurementClipboard, clearPasteAnchor, triggerPdfCommand])

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
  const canCopyMeasurement = selectedAnnotIds.size > 1 ? true : !!copyTargetId
  const canPasteMeasurement = !!measurementClipboard?.items?.length && (measurementClipboard.items[0].itemType || 'Line') === 'Line'

  // The canvas renderer prefers a color embedded *inside* pointsJson's
  // geometry over the takeoff item's own flat `color` column (see the
  // matching strokeColor/StrokeColor comment in autoSave, and the occurrence
  // merge in handleMeasurementGeometryChange below) — a color change that
  // only patches the flat column updates the grid (which reads `color`
  // directly) but leaves the PDF still showing the old color. Handles both
  // a flat single-geometry item and a multi-occurrence one (quantity > 1),
  // recoloring every occurrence so the whole measurement updates together.
  const embedColorInPointsJson = (pointsJsonString, color) => {
    if (!pointsJsonString) return pointsJsonString
    try {
      const raw = JSON.parse(pointsJsonString)
      if (Array.isArray(raw.occurrences) && raw.occurrences.length) {
        return JSON.stringify({
          ...raw,
          // The root object carries its own (redundant, but read by some
          // paths) strokeColor/StrokeColor alongside the per-occurrence
          // ones — keep both in sync so nothing is left stale.
          strokeColor: color,
          StrokeColor: color,
          occurrences: raw.occurrences.map(occ => {
            const geometry = occ?.geometry ?? occ?.rawAnnotation ?? occ
            if (!geometry || typeof geometry !== 'object') return occ
            return { ...occ, geometry: { ...geometry, strokeColor: color, StrokeColor: color } }
          }),
        })
      }
      return JSON.stringify({ ...raw, strokeColor: color, StrokeColor: color })
    } catch {
      return pointsJsonString
    }
  }

  // Quick member reassignment: instantly re-tags every selected measurement
  // (one, via a plain click, or several via ctrl/shift-click) with the
  // clicked member's mark/material/category/color — a fast fix for a
  // wrongly-assigned member without redrawing. Triggered from
  // MemberSchedulePanel's handleSelectMember when a selection is active.
  // Mirrors the existing optimistic-update + fire-and-forget PUT pattern
  // MemberSchedulePanel's own applyColorToMember already uses for its
  // batch-by-mark recolor.
  const handleAssignMemberToSelection = useCallback(async (member, ids) => {
    const rows = ids
      .map(id => (useAppStore.getState().takeoffItems ?? []).find(t => t.id === id))
      .filter(Boolean)
    if (!rows.length) return
    await Promise.allSettled(rows.map(async row => {
      const newColor = member.color || row.color
      const optimistic = {
        ...row,
        material: member.mark,
        mark: member.mark,
        category: member.memberType || row.category,
        color: newColor,
        pointsJson: embedColorInPointsJson(row.pointsJson, newColor),
      }
      updateTakeoffItem(optimistic)
      try {
        const saved = await takeoffService.update(optimistic)
        updateTakeoffItem(saved)
      } catch {
        // Roll back this row's optimistic change on failure so the grid/PDF
        // don't keep showing a reassignment that was never actually saved.
        updateTakeoffItem(row)
        toast.error(`Could not reassign ${row.mark || 'measurement'}`)
      }
    }))
  }, [updateTakeoffItem])

  const handleRowDelete = useCallback(async (id) => {
    const annot = annotationMapRef.current[id]
    const beforeDeleteItems = useAppStore.getState().takeoffItems ?? []
    const itemBeingDeleted = beforeDeleteItems.find(t => Number(t.id) === Number(id))
    const annotationIds = Array.from(new Set([
      ...(annot?.annotationIds ?? []),
      annot?.annotationId,
      ...extractTakeoffAnnotationIds(itemBeingDeleted?.pointsJson),
    ].filter(Boolean)))
    const linkedRootBeforeDelete = parseLinkedItemId(itemBeingDeleted?.notes)
    try {
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
    updateTakeoffItem,
  ])

  const handlePdfAreaContextMenu = useCallback((e) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const handleAnnotationSelect = useCallback((annotUuid, annotation = null, event = null) => {
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
        syncToolbarFromTakeoffItem(item)
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
    const nextIds = new Set(selectedAnnotIdsRef.current)
    let removed = false
    if (dbId != null) { if (nextIds.has(dbId)) { nextIds.delete(dbId); removed = true } else nextIds.add(dbId) }
    const nextViewerIds = new Set(selectedViewerAnnotIdsRef.current)
    if (viewerId) { if (nextViewerIds.has(viewerId)) nextViewerIds.delete(viewerId); else nextViewerIds.add(viewerId) }
    selectedAnnotIdsRef.current = nextIds
    selectedViewerAnnotIdsRef.current = nextViewerIds
    setSelectedAnnotIds(nextIds)
    setSelectedViewerAnnotIds(nextViewerIds)

    // Keep the scalar "primary" pointed at whichever item this click just
    // affected — this is what keeps resolveCopyTargetId/the style-persist
    // effect/context-menu Delete meaningful mid-multi-select.
    const primaryDbId = removed ? ([...nextIds].pop() ?? null) : dbId
    const primaryViewerId = removed ? ([...nextViewerIds].pop() ?? null) : viewerId
    selectedOccurrenceAnnotIdRef.current = primaryViewerId
    setSelectedViewerAnnotId(primaryViewerId)
    setSelectedAnnotId(primaryDbId)
    setStyleEditTargetId(primaryDbId)
    annotStyleBaselineRef.current = null
    if (primaryDbId) {
      lastCopyTargetRef.current = primaryDbId
      syncToolbarFromTakeoffItem(takeoffItems.find(t => t.id === primaryDbId))
    }
  }, [resolveMeasurementDbId, syncToolbarFromTakeoffItem, takeoffItems, triggerPdfCommand])

  const handleAnnotationContextMenu = useCallback((event, annotUuid, annotation = null) => {
    event.preventDefault()
    event.stopPropagation()
    // Right-clicking a shape that's already part of an active 2+ selection
    // must not collapse the group to just this one shape — a group
    // right-click menu should still act on (and Copy) the whole selection.
    const rawDbId = annotation?.dbId
    const dbId = Number.isFinite(Number(rawDbId)) ? Number(rawDbId) : resolveMeasurementDbId(annotation?.id ?? annotUuid ?? null)
    const isMultiMember = selectedAnnotIdsRef.current.size > 1 && dbId != null && selectedAnnotIdsRef.current.has(dbId)
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
        closeCtxMenu()
        clearPasteAnchor()
        triggerPdfCommand({ type: 'cancelPastePlacement' })
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
        handleRowDelete(selectedAnnotId).catch(() => {})
        return
      }

      if (hasMod && (key === 'z' || key === 'y')) {
        e.preventDefault()
        e.stopPropagation()
        triggerPdfCommand({ type: key === 'z' ? 'undo' : 'redo' })
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
  }, [handleCopyMeasurement, handlePasteMeasurement, selectedAnnotId, handleRowDelete, triggerPdfCommand, clearPasteAnchor, closeCtxMenu, showCalModal, resetDrawingInteraction, clearAllSelection])

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
    setActiveTool('calibrate')
    triggerPdfCommand('ensureMeasureMode')
  }, [setActiveTool, triggerPdfCommand])

  // "Reset Scale" button when already calibrated — wipe DB calibration, return to calibrate mode
  const handleResetCalibration = useCallback(async () => {
    if (!selectedDrawing) return
    try {
      const refreshed = await drawingService.resetCalibration(selectedDrawing.id)
      setSelectedDrawing(refreshed)
      setDrawings(prev => (Array.isArray(prev) ? prev : []).map(d => d.id === refreshed.id ? refreshed : normalizeDrawing(d)))
      triggerPdfCommand('refreshCalibration')
      setActiveTool('calibrate')
      triggerPdfCommand('ensureMeasureMode')
      toast('Scale reset — draw a reference line to re-calibrate', { duration: 4000, icon: '📐' })
    } catch {
      toast.error('Failed to reset calibration')
    }
  }, [selectedDrawing, triggerPdfCommand])

  const handleDrawingUploaded = async (drawing) => {
    const norm = normalizeDrawing(drawing)
    setSelectedDrawing(norm)
    setTakeoffItems([])
    setMemberScheduleItems([])
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

  const handleDrawingDeleted = (id) => {
    const rest = (Array.isArray(useAppStore.getState().drawings) ? useAppStore.getState().drawings : []).filter(d => d.id !== id)
    setDrawings(rest)
    if (selectedDrawing?.id === id) {
      setSelectedDrawing(rest[0] ? normalizeDrawing(rest[0]) : null)
      setTakeoffItems([])
      setMemberScheduleItems([])
      setSummaryLocal(null)
      annotationMapRef.current = {}
      persistedAnnotIdsRef.current = new Set()
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

  const handleExtractionSaved = useCallback(async (count) => {
    if (!selectedDrawing) return
    try {
      const [members, memberSum] = await Promise.all([
        memberScheduleService.getByDrawing(selectedDrawing.id),
        memberScheduleService.getSummary(selectedDrawing.id),
      ])
      setMemberScheduleItems(assignMemberColors(members))
      setMemberScheduleSummary(memberSum)
      setLeftPanelTab('members')
      setLeftPanelOpen(true)
      setLeftHovered(true)
      toast.success(`${count} member(s) saved — schedule updated from PDF extraction`, { duration: 3000, icon: '🔩' })
    } catch { /* ignore */ }
    setShowExtractModal(false)
  }, [selectedDrawing])

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
        canCopy={canCopyMeasurement}
        canPaste={canPasteMeasurement}
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
                    clearAllSelection()
                    annotationMapRef.current = {}
                    setSidebarOpen(false)
                  }}
                  onUploaded={handleDrawingUploaded}
                  onDeleted={handleDrawingDeleted}
                />
              ) : (
                <MemberSchedulePanel drawing={activeDrawing} onExport={handleExport} onSelectMeasurement={handleRowSelect} selectedAnnotIds={selectedAnnotIds} onAssignMemberToSelection={handleAssignMemberToSelection} />
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
                  clearAllSelection()
                  annotationMapRef.current = {}
                }}
                onUploaded={handleDrawingUploaded}
                onDeleted={handleDrawingDeleted}
              />
            ) : (
              <MemberSchedulePanel drawing={activeDrawing} onExport={handleExport} onSelectMeasurement={handleRowSelect} selectedAnnotIds={selectedAnnotIds} onAssignMemberToSelection={handleAssignMemberToSelection} />
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
                {selectedAnnotIds.size > 1 && (
                  <div style={{ padding: '7px 16px', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                    {selectedAnnotIds.size} selected
                  </div>
                )}
                {canCopyMeasurement && (
                  <button
                    onClick={() => { handleCopyMeasurement(); closeCtxMenu() }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 16px', background: 'transparent', border: 'none', color: '#e2e8f0', fontSize: 13, cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,35,60,0.15)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {selectedAnnotIds.size > 1 ? `Copy ${selectedAnnotIds.size} Measurements` : 'Copy Measurement'}
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
                      onClick={() => { handleRowDelete(selectedAnnotId); closeCtxMenu() }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 16px', background: 'transparent', border: 'none', color: '#f87171', fontSize: 13, cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,35,60,0.15)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <BottomDock
            height={bottomH}
            minHeight={180}
            maxHeight={bottomDockMaxHeight}
            open={showBottom}
            pinned={bottomPinned}
            hovered={bottomHovered}
            resizing={isDraggingBottom}
            count={takeoffItems.length}
            summary={takeoffItems.length > 0 ? `${takeoffItems.length} item${takeoffItems.length === 1 ? '' : 's'}` : null}
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
            <MeasurementTable
              drawing={activeDrawing}
              selectedId={selectedAnnotId}
              selectedIds={selectedAnnotIds}
              onRowSelect={handleRowSelect}
              onDelete={handleRowDelete}
              onAddClick={() => { setPendingMeas(null); setShowAddModal(true) }}
            />
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
          }}
        />
      )}

      {showAddModal && (
        <AddMeasurementModal
          drawing={selectedDrawing}
          measurement={pendingMeas}
          onAdded={handleItemAdded}
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
