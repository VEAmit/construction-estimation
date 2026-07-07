import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { drawingService } from '../services/drawingService'
import { takeoffService } from '../services/takeoffService'
import { memberScheduleService } from '../services/memberScheduleService'
import { useAppStore } from '../store/useAppStore'
import { useBreakpoint } from '../utils/useBreakpoint'
import DrawingSidebar from '../components/drawings/DrawingSidebar'
import PdfViewer from '../components/drawings/PdfViewer'
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
import ExtractionModal from '../components/extraction/ExtractionModal'
import toast from 'react-hot-toast'

const _MS_PALETTE = ['#3B82F6','#22C55E','#F97316','#A855F7','#06B6D4','#EAB308','#EC4899','#EF4444','#14B8A6','#F59E0B','#6366F1','#84CC16']
const _MS_HEX = /^#[0-9A-Fa-f]{6}$/

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

export default function DrawingsPage() {
  const navigate = useNavigate()
  const { isMobile, isTablet, isDesktop } = useBreakpoint()

  const {
    selectedProject, setSelectedProject,
    drawings: storeDrawings, setDrawings, selectedDrawing, setSelectedDrawing,
    takeoffItems, addTakeoffItem, setTakeoffItems, updateTakeoffItem,
    setSummary, activeTool, setActiveTool, setActiveUnit, activeUnit, updateDrawingCalibration,
    memberScheduleItems, setMemberScheduleItems, setMemberScheduleSummary, updateMemberScheduleItem,
    triggerPdfCommand,
    _hydrated,
    measureColor, lineThickness, lineStyle, arrowStyle, measureCategory,
    measurementClipboard, setMeasurementClipboard, clearMeasurementClipboard,
    pasteAnchor, setPasteAnchor, clearPasteAnchor,
    pdfScale,
    removeTakeoffItem,
    setMeasureColor,
    setLineThickness,
  } = useAppStore()

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
  }, [readThicknessFromPointsJson, setMeasureColor, setLineThickness])

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
  const [showBottom,       setShowBottom]        = useState(true)
  const [bottomTab,        setBottomTab]         = useState('measurements')
  const [summary,          setSummaryLocal]      = useState(null)
  const [selectedAnnotId,  setSelectedAnnotId]   = useState(null)
  const [showExtractModal, setShowExtractModal]  = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y } | null — right-click context menu

  // Mobile panel drawer state
  const [sidebarOpen,  setSidebarOpen]  = useState(false)
  const [rightOpen,    setRightOpen]    = useState(false)

  // Desktop side panel open/hover state (independent of mobile)
  const [leftPanelOpen,  setLeftPanelOpen]  = useState(true)
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [leftHovered,    setLeftHovered]    = useState(false)
  const [rightHovered,   setRightHovered]   = useState(false)
  const leftHoverTimer  = useRef(null)
  const rightHoverTimer = useRef(null)

  const annotationMapRef = useRef({})
  const lastCopyTargetRef = useRef(null)
  const persistedAnnotIdsRef = useRef(new Set())
  const savingAnnotIdsRef = useRef(new Set())
  const measureReleaseRef = useRef(null)
  // Last auto-saved measurement — Clear removes it; mark reused on next draw after Clear
  const pendingMeasurementRef = useRef(null)
  const clearedMarkRef = useRef(null)
  const pendingCalibMeasureRef = useRef(null)
  const calibrateOnlyRef = useRef(false)

  const extractAnnotIdFromPointsJson = useCallback((pointsJson) => {
    if (!pointsJson) return null
    try {
      const stored = typeof pointsJson === 'string' ? JSON.parse(pointsJson) : pointsJson
      return stored.AnnotName ?? stored.annotationId ?? stored.uniqueKey ?? stored.name ?? null
    } catch {
      return null
    }
  }, [])

  const resolveMeasurementDbId = useCallback((annotId) => {
    const pending = pendingMeasurementRef.current
    if (!annotId) return pending?.dbId ?? null
    if (pending?.annotationId === annotId) return pending.dbId ?? null
    const fromMap = Object.entries(annotationMapRef.current).find(([, v]) => v.annotationId === annotId)
    if (fromMap) return Number(fromMap[0])
    const items = useAppStore.getState().takeoffItems ?? []
    const item = items.find(t => extractAnnotIdFromPointsJson(t.pointsJson) === annotId)
    return item?.id ?? null
  }, [extractAnnotIdFromPointsJson])

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
    const current = { color: measureColor, thickness: lineThickness, lineStyle, arrowStyle }

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

    if (!styleChanged) return
    annotStyleBaselineRef.current = current

    const item = takeoffItems.find(t => t.id === selectedAnnotId)
    if (!item) return

    const optimistic = { ...item, color: measureColor, category: measureCategory }
    updateTakeoffItem(optimistic)
    takeoffService.update(optimistic)
      .then(saved => updateTakeoffItem(saved))
      .catch(() => {})
  }, [measureColor, measureCategory, lineStyle, arrowStyle, selectedAnnotId, styleEditTargetId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Close mobile drawers on route change or desktop switch
  useEffect(() => {
    if (!isMobile) { setSidebarOpen(false); setRightOpen(false) }
  }, [isMobile])

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
        items.forEach(item => {
          if (!item.pointsJson) return
          try {
            const stored = JSON.parse(item.pointsJson)
            const annotId = stored.annotationId ?? stored.AnnotName ?? stored.uniqueKey ?? stored.name
            if (!annotId) return
            const page0 = stored.page != null
              ? parseInt(stored.page, 10)
              : (stored.pageIndex ?? 0)
            map[item.id] = { annotationId: annotId, pageNumber: page0 + 1 }
          } catch (_) {}
        })
        annotationMapRef.current = map
        persistedAnnotIdsRef.current = new Set(
          items.map(item => extractAnnotIdFromPointsJson(item.pointsJson)).filter(Boolean)
        )
      })
      .catch(() => toast.error('Failed to load drawing data'))
  }, [selectedDrawing?.id, extractAnnotIdFromPointsJson, updateTakeoffItem, triggerPdfCommand])

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
  }, [removeTakeoffItem, selectedAnnotId, selectedDrawing, setSummary, triggerPdfCommand])

  const scheduleAnnotationBlobSave = useCallback(() => {
    if (blobSaveTimerRef.current) clearTimeout(blobSaveTimerRef.current)
    blobSaveTimerRef.current = setTimeout(() => {
      triggerPdfCommand('saveAnnotationBlob')
    }, 1500)
  }, [triggerPdfCommand])

  useEffect(() => () => {
    if (blobSaveTimerRef.current) clearTimeout(blobSaveTimerRef.current)
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
    // Priority: explicitly-selected member -> payload mark from PdfViewer -> auto-detected mark.
    const memberMark = (
      linkedMember?.mark?.trim() ||
      linkedMember?.Mark?.trim() ||
      (measurement.memberMark || '').trim() ||
      (measurement.drawingMark || '').trim() ||
      ''
    )
    if (!drw?.id) {
      console.warn('[BT-Lifecycle] autoSave ABORTED — no drawing id in store')
      return false
    }

    if (isPaste && measurement.annotationId) {
      const items = useAppStore.getState().takeoffItems ?? []
      const dup = items.some(t => {
        if (!t.pointsJson) return false
        try {
          const raw = JSON.parse(t.pointsJson)
          const aid = raw.annotationId ?? raw.AnnotName ?? raw.name
          return aid === measurement.annotationId
        } catch {
          return false
        }
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
    const saveColor = pasteOverride?.color
      ?? resolveDrawColorForMemberMark(memberMark, color, itemsForColor, memberScheduleItems)
      ?? '#111827'
    const saveCategory = pasteOverride?.category ?? category ?? 'General'
    const saveMaterialOverride = pasteOverride?.material

    const annotKey = measurement.annotationId
      ?? `${measurement.pageNumber}-${measurement.pixelLength}-${measurement.length}`
    if (annotKey && savingAnnotIdsRef.current.has(annotKey)) {
      console.warn('[BT-Lifecycle] autoSave skipped — duplicate in flight:', annotKey)
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

    const desc = isCount
      ? `Count: ${measurement.count} × ${category}`
      : isArea
        ? formatAreaMeasureDescription(measurement.pixelArea, saveArea, unit, normDrw)
        : isPerim
          ? formatPolylineDescription(measurement.pixelLength, saveLength, unit, normDrw)
          : formatLineMeasureDescription(measurement.pixelLength, saveLength, unit, normDrw)

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
        const thick = pendingMeasurementRef.current?.pendingThickness
          ?? useAppStore.getState().lineThickness
          ?? raw.thickness
          ?? raw.Thickness
          ?? 2
        raw.thickness = Number(thick) > 0 ? Number(thick) : 2
        raw.Thickness = raw.thickness
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

    const memberType = linkedMember?.memberType?.trim() ?? ''
    const saveCategoryFinal = memberType || saveCategory
    const saveMaterial = saveMaterialOverride ?? memberMark
    const msiId = linkedMember?.id ?? measurement.memberScheduleId
    const saveNotes = msiId ? `msi:${msiId}` : ''

    try {
      const pointsJson = buildPointsJson()
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
        unitWeight:  null,
        totalWeight: null,
        color:       saveColor,
        category:    saveCategoryFinal,
        pointsJson,
      })
      let finalSaved = saved
      const latestThick = pendingMeasurementRef.current?.pendingThickness ?? useAppStore.getState().lineThickness
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
      console.log('[BT-Lifecycle] autoSave — database success, id:', finalSaved.id, 'mark:', finalSaved.mark, 'length:', finalSaved.length)
      setShowBottom(true)
      if (!linkedMember) {
        setBottomTab('measurements')
      }

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
        setStyleEditTargetId(null)
        annotStyleBaselineRef.current = null
      } else {
        // Continuous draw: do not keep the new row in "style edit" mode — toolbar color is for the next mark.
        setSelectedAnnotId(null)
        setStyleEditTargetId(null)
        annotStyleBaselineRef.current = null
      }
      if (measurement.annotationId) {
        annotationMapRef.current[finalSaved.id] = {
          annotationId: measurement.annotationId,
          pageNumber:   measurement.pageNumber ?? 1,
        }
        persistedAnnotIdsRef.current.add(measurement.annotationId)
      }
      pendingMeasurementRef.current = {
        dbId: finalSaved.id,
        annotationId: measurement.annotationId,
        mark: finalSaved.mark,
        pageNumber: measurement.pageNumber ?? 1,
        pendingThickness: pendingMeasurementRef.current?.pendingThickness ?? useAppStore.getState().lineThickness,
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
  }, [addTakeoffItem, scheduleAnnotationBlobSave, updateMemberScheduleItem])

  const handleMeasure = useCallback((measurement, opts = {}) => {
    const { activeTool: currentTool } = useAppStore.getState()
    console.log('[BT-Lifecycle] handleMeasure — tool:', currentTool, 'length:', measurement?.length, 'unit:', measurement?.unit, 'annotationId:', measurement?.annotationId)

    if (currentTool === 'calibrate') {
      const drw = getCalibratedDrawingFromStore()
      const isFirstTimeCal = !drw?.isCalibrated

      if (isFirstTimeCal) {
        // Bluebeam workflow: the line that triggered first-time calibration IS the first measurement.
        // Store it so handleCalibrationApply saves it after the scale is confirmed.
        // calibrateOnly = false → autoSave will be called; annotation stays on canvas.
        // Nullify length so autoSave recalculates it from pixelLength using the calibrated scale.
        console.log('[BT-Lifecycle] handleMeasure — first-time calibration, storing measurement for post-calibration save')
        calibrateOnlyRef.current = false
        pendingCalibMeasureRef.current = { ...measurement, length: null }
        pendingMeasurementRef.current = {
          annotationId: measurement.annotationId,
          dbId: null,
          mark: measurement.memberMark ?? measurement.drawingMark ?? null,
          pageNumber: measurement.pageNumber ?? 1,
          pendingThickness: useAppStore.getState().lineThickness,
          rawPointsJson: measurement.rawAnnotation ?? null,
        }
      } else {
        // Explicit re-calibration on an already-calibrated drawing: reference line is ONLY for
        // scale adjustment and must be deleted after calibration. Do not save as a measurement.
        console.log('[BT-Lifecycle] handleMeasure — re-calibration, calibrateOnly=true, no measurement save')
        calibrateOnlyRef.current = true
        pendingCalibMeasureRef.current = null
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
          mark: measurement.memberMark ?? measurement.drawingMark ?? null,
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
      setStyleEditTargetId(null)
      annotStyleBaselineRef.current = null
      pendingMeasurementRef.current = {
        annotationId: measurement.annotationId,
        dbId: null,
        mark: measurement.memberMark ?? measurement.drawingMark ?? null,
        pageNumber: measurement.pageNumber ?? 1,
        pendingThickness: useAppStore.getState().lineThickness,
        rawPointsJson: measurement.rawAnnotation ?? null,
      }
    }

    setLastMeasurement(measurement)
    autoSave(measurement, opts).then((ok) => {
      if (ok) {
        console.log('[BT-Lifecycle] handleMeasure — autoSave success, triggering label rehydrate')
        triggerPdfCommand('rehydrateMeasureLabels')
      } else {
        console.warn('[BT-Lifecycle] handleMeasure — autoSave did not complete')
      }
    })
  }, [autoSave, triggerPdfCommand])

  const handleSaveCalib = useCallback(() => {
    const px = lastMeasurement?.pixelLength
    if (!px || px <= 0) {
      toast.error('Draw a line along a labelled dimension on the plan first')
      return
    }
    calibrateOnlyRef.current = true
    pendingCalibMeasureRef.current = null
    setScaleSetupFirstMeasure(false)
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
        toast.success('Scale saved — your first measurement was added', { duration: 3500, icon: '✅' })
      } else if (measureToSave && !savedFirst) {
        toast.error('Scale saved but measurement could not be added — draw the line again')
      } else {
        toast.success('Scale saved — you can measure now', { duration: 3500, icon: '✅' })
      }
    } catch (err) {
      console.error('[BuildTakeoff] calibration apply failed:', err)
      toast.error('Could not save scale — try again')
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
    } catch {
      toast.error('Failed to apply quick scale')
    }
  }, [selectedDrawing, triggerPdfCommand, updateDrawingCalibration, setActiveUnit, updateTakeoffItem])

  const handleRowSelect = useCallback((dbId) => {
    setSelectedAnnotId(dbId)
    setStyleEditTargetId(dbId)
    annotStyleBaselineRef.current = null
    if (!dbId) return
    lastCopyTargetRef.current = dbId
    const item = takeoffItems.find(t => t.id === dbId)
    syncToolbarFromTakeoffItem(item)
    const annot = annotationMapRef.current[dbId]
    if (annot?.annotationId) triggerPdfCommand({ type: 'selectAnnotation', ...annot })
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

  const resolveCopyTargetId = useCallback(() => {
    const isValid = (item) => item && isValidLinearMeasurementForCopy(item)
    const candidates = [
      selectedAnnotId,
      styleEditTargetId,
      lastCopyTargetRef.current,
      pendingMeasurementRef.current?.dbId,
    ].filter(id => id != null)
    for (const id of candidates) {
      const item = takeoffItems.find(t => t.id === id)
      if (isValid(item)) return id
    }
    const lines = takeoffItems.filter(t => isValid(t))
    return lines.length ? lines[lines.length - 1].id : null
  }, [selectedAnnotId, styleEditTargetId, takeoffItems])

  const handleCopyMeasurement = useCallback(() => {
    const targetId = resolveCopyTargetId()
    let item = targetId ? takeoffItems.find(t => t.id === targetId) : null

    if (!item?.pointsJson) {
      const pendingRaw = pendingMeasurementRef.current?.rawPointsJson ?? lastMeasurement?.rawAnnotation
      const isLine = (lastMeasurement?.measureType ?? 'Line') === 'Line'
      if (pendingRaw && isLine) {
        const raw = typeof pendingRaw === 'string' ? JSON.parse(pendingRaw) : pendingRaw
        item = item ?? {
          id: pendingMeasurementRef.current?.dbId ?? targetId,
          itemType: 'Line',
          mark: pendingMeasurementRef.current?.mark ?? lastMeasurement?.memberMark ?? lastMeasurement?.drawingMark ?? 'Line',
          material: lastMeasurement?.memberMark ?? lastMeasurement?.drawingMark ?? '',
          color: measureColor,
          category: measureCategory ?? 'General',
          length: lastMeasurement?.length,
          unit: activeUnit,
          pointsJson: JSON.stringify(raw),
        }
      }
    }

    if (!item?.pointsJson || (item.itemType || 'Line') !== 'Line') {
      toast.error('Draw or select a linear measurement to copy')
      return
    }
    if (!isValidLinearMeasurementForCopy(item)) {
      toast.error('Line is too short to copy — select a longer measurement or delete tiny/degenerate lines')
      return
    }
    try {
      const raw = JSON.parse(item.pointsJson)
      const clipboard = buildLinearMeasurementClipboard(item, raw, pdfScale)
      setMeasurementClipboard(clipboard)
      clearPasteAnchor()
      if (item.id) lastCopyTargetRef.current = item.id
      toast.success(`Copied ${item.mark} — click destination on plan (Pan), then Ctrl+V`, { duration: 3500 })
    } catch {
      toast.error('Could not copy measurement')
    }
  }, [resolveCopyTargetId, takeoffItems, lastMeasurement, measureColor, measureCategory, activeUnit, pdfScale, setMeasurementClipboard, clearPasteAnchor])

  const handlePasteMeasurement = useCallback(() => {
    if (!measurementClipboard) {
      toast('Copy a line measurement first (Ctrl+C)')
      return
    }
    if (!selectedDrawing) return
    const anchor = useAppStore.getState().pasteAnchor
    if (!anchor) {
      toast('Click on the drawing (Pan tool) where you want to paste, then press Ctrl+V', { duration: 4500, icon: '📍' })
      return
    }
    pasteStyleOverrideRef.current = {
      color: measurementClipboard.color,
      category: measurementClipboard.category,
      material: measurementClipboard.material ?? measurementClipboard.mark ?? '',
    }
    triggerPdfCommand({ type: 'pasteAtPoint', clipboard: measurementClipboard, anchor })
  }, [measurementClipboard, selectedDrawing, triggerPdfCommand])

  const copyTargetId = resolveCopyTargetId()
  const hasPendingLineCopy = !!(
    (pendingMeasurementRef.current?.rawPointsJson ?? lastMeasurement?.rawAnnotation)
    && (lastMeasurement?.measureType ?? 'Line') === 'Line'
  )
  const canCopyMeasurement = !!copyTargetId || hasPendingLineCopy
  const canPasteMeasurement = !!measurementClipboard && (measurementClipboard.itemType || 'Line') === 'Line'

  const handleClearPending = useCallback(async () => {
    const pending = pendingMeasurementRef.current
    if (!pending) return false
    if (!persistedAnnotIdsRef.current.has(pending.annotationId)) {
      clearedMarkRef.current = pending.mark
    }
    return deletePendingMeasurement(pending)
  }, [deletePendingMeasurement])

  const handleRowDelete = useCallback(async (id) => {
    const annot = annotationMapRef.current[id]
    try {
      await takeoffService.delete(id)
      removeTakeoffItem(id)
      delete annotationMapRef.current[id]
      if (selectedAnnotId === id) setSelectedAnnotId(null)
      if (pendingMeasurementRef.current?.dbId === id) pendingMeasurementRef.current = null
      if (annot?.annotationId) {
        persistedAnnotIdsRef.current.delete(annot.annotationId)
        triggerPdfCommand({ type: 'deleteAnnotation', annotationId: annot.annotationId, pageNumber: annot.pageNumber ?? 1 })
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
  }, [selectedAnnotId, selectedDrawing, triggerPdfCommand, removeTakeoffItem, setSummary])

  const handlePdfAreaContextMenu = useCallback((e) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])

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
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C' || e.key === 'v' || e.key === 'V'))) return
      const isC = e.key === 'c' || e.key === 'C'
      if (isC) {
        e.preventDefault()
        e.stopPropagation()
        handleCopyMeasurement()
      } else if (canPasteMeasurement) {
        e.preventDefault()
        e.stopPropagation()
        handlePasteMeasurement()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [canPasteMeasurement, handleCopyMeasurement, handlePasteMeasurement])

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
    setActiveTool('calibrate')
    toast('New drawing uploaded — draw along a labelled dimension to set the scale first.', { duration: 5500, icon: '📐' })
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
      setBottomTab('members')
      setShowBottom(true)
      toast.success(`${count} member(s) saved — schedule updated from PDF extraction`, { duration: 3000, icon: '🔩' })
    } catch { /* ignore */ }
    setShowExtractModal(false)
  }, [selectedDrawing])

  const handleExport    = () => exportToExcel(takeoffItems, memberScheduleItems, selectedDrawing, selectedProject)
  const handleExportPdf = () => exportToPdf(takeoffItems, memberScheduleItems, selectedDrawing, selectedProject)

  const drawingUrl        = selectedDrawing ? drawingService.getFileUrl(selectedDrawing.id) : null
  const selectedAnnotItem = selectedAnnotId ? takeoffItems.find(t => t.id === selectedAnnotId) : null

  // Bottom panel height — resizable via drag
  const [bottomH, setBottomH] = useState(() => isMobile ? 200 : isTablet ? 240 : 280)
  const [isDraggingBottom, setIsDraggingBottom] = useState(false)

  // Desktop side panels: show when pinned OR hovered
  const effectiveLeftOpen  = leftPanelOpen  || leftHovered
  const effectiveRightOpen = rightPanelOpen || rightHovered

  // Toggle bottom panel tab: click active tab → collapse; click other tab → switch+expand
  const handleBottomTabClick = (tab) => {
    if (showBottom && bottomTab === tab) setShowBottom(false)
    else { setBottomTab(tab); setShowBottom(true) }
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
        <button onClick={() => setShowBottom(t => !t)} style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          padding: '4px 8px', borderRadius: '6px', fontSize: '11px', fontWeight: 600,
          border: `1px solid ${showBottom ? 'rgba(239,35,60,.35)' : 'rgba(255,255,255,.1)'}`,
          background: showBottom ? 'rgba(239,35,60,.12)' : 'transparent',
          color: showBottom ? '#EF233C' : '#64748b', cursor: 'pointer',
          transition: 'all .15s', flexShrink: 0, touchAction: 'manipulation',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="15" x2="21" y2="15"/>
          </svg>
          {!isMobile && (showBottom ? 'Hide' : 'Show')}
          {(takeoffItems.length > 0 || memberScheduleItems.length > 0) && (
            <span style={{ background: '#EF233C', color: '#fff', borderRadius: '10px', padding: '0 5px', fontSize: '9px' }}>
              {takeoffItems.length + memberScheduleItems.length}
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

        {/* Left: Drawing sidebar */}
        {isMobile ? (
          <div
            className="panel-drawer"
            style={{
              position: 'fixed', top: 0, bottom: 0, left: 0, zIndex: 200,
              transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
              display: 'flex', flexDirection: 'column',
              boxShadow: sidebarOpen ? '4px 0 30px rgba(0,0,0,.7)' : 'none',
            }}
          >
            <DrawingSidebar
              drawings={drawings}
              selectedDrawing={selectedDrawing}
              onSelect={(d) => {
                const norm = normalizeDrawing(d)
                setSelectedDrawing(norm)
                setSelectedAnnotId(null)
                annotationMapRef.current = {}
                if (!norm.isCalibrated) {
                  setActiveTool('line')
                  setTimeout(() => triggerPdfCommand('ensureMeasureMode'), 800)
                }
                setSidebarOpen(false)
              }}
              onUploaded={handleDrawingUploaded}
              onDeleted={handleDrawingDeleted}
            />
          </div>
        ) : (
          <div
            style={{ display: 'flex', alignItems: 'stretch', flexShrink: 0 }}
            onMouseEnter={() => { clearTimeout(leftHoverTimer.current); setLeftHovered(true) }}
            onMouseLeave={() => { leftHoverTimer.current = setTimeout(() => setLeftHovered(false), 300) }}
          >
            <div style={{
              width: effectiveLeftOpen ? '240px' : '0px',
              overflow: 'hidden', flexShrink: 0,
              transition: 'width 250ms cubic-bezier(0.4,0,0.2,1)',
              willChange: 'width',
            }}>
              <DrawingSidebar
                drawings={drawings}
                selectedDrawing={selectedDrawing}
                onSelect={(d) => {
                  const norm = normalizeDrawing(d)
                  setSelectedDrawing(norm)
                  setSelectedAnnotId(null)
                  annotationMapRef.current = {}
                  if (!norm.isCalibrated) {
                    setActiveTool('line')
                    setTimeout(() => triggerPdfCommand('ensureMeasureMode'), 800)
                  }
                }}
                onUploaded={handleDrawingUploaded}
                onDeleted={handleDrawingDeleted}
              />
            </div>
            <button
              onClick={() => { clearTimeout(leftHoverTimer.current); setLeftHovered(false); setLeftPanelOpen(o => !o) }}
              className="panel-toggle-tab panel-toggle-tab-left"
              title={leftPanelOpen ? 'Collapse Panel' : 'Expand Panel'}
            >
              <svg width="9" height="13" viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                {effectiveLeftOpen ? (
                  <>
                    <polyline points="9,1 5,7 9,13"/>
                    <polyline points="5,1 1,7 5,13"/>
                  </>
                ) : (
                  <>
                    <polyline points="3,1 7,7 3,13"/>
                    <polyline points="7,1 11,7 7,13"/>
                  </>
                )}
              </svg>
            </button>
          </div>
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
            <PdfViewer
              key={`${selectedProject?.id ?? 'p'}-${selectedDrawing?.id ?? 'd'}`}
              drawingUrl={drawingUrl}
              drawing={activeDrawing}
              activeTool={activeTool}
              onMeasure={handleMeasure}
              annotations={takeoffItems.filter(t => t.pointsJson)}
              selectedAnnotationId={selectedAnnotId}
              styleEditTargetId={styleEditTargetId}
              onAnnotationSelect={(annotUuid) => {
                let dbId = null
                const entries = Object.entries(annotationMapRef.current)
                const found = entries.find(([, v]) => v.annotationId === annotUuid)
                if (found) dbId = Number(found[0])
                if (dbId == null) {
                  const item = takeoffItems.find(t => {
                    if (!t.pointsJson) return false
                    try {
                      const s = JSON.parse(t.pointsJson)
                      const id = s.AnnotName ?? s.annotationId ?? s.name
                      return id === annotUuid
                    } catch { return false }
                  })
                  dbId = item?.id ?? null
                }
                setSelectedAnnotId(dbId)
                setStyleEditTargetId(dbId)
                if (dbId) lastCopyTargetRef.current = dbId
                annotStyleBaselineRef.current = null
                if (dbId) {
                  const item = takeoffItems.find(t => t.id === dbId)
                  syncToolbarFromTakeoffItem(item)
                }
              }}
              onMeasurementThicknessChange={handleMeasurementThicknessChange}
              resolveMeasurementDbId={resolveMeasurementDbId}
              getProtectedAnnotIds={() => persistedAnnotIdsRef.current}
              measureReleaseRef={measureReleaseRef}
              onClearPending={handleClearPending}
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
                onClick={e => e.stopPropagation()}
              >
                {canCopyMeasurement && (
                  <button
                    onClick={() => { handleCopyMeasurement(); closeCtxMenu() }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 16px', background: 'transparent', border: 'none', color: '#e2e8f0', fontSize: 13, cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,35,60,0.15)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    Copy Measurement
                  </button>
                )}
                {canPasteMeasurement && (
                  <button
                    onClick={() => { handlePasteMeasurement(); closeCtxMenu() }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 16px', background: 'transparent', border: 'none', color: '#e2e8f0', fontSize: 13, cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,35,60,0.15)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    Paste Measurement
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

          {/* Bottom data panel: tab strip + animated content */}
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column' }}>

            {/* Persistent tab strip — top border is also the drag-to-resize zone */}
            <div style={{
              display: 'flex', alignItems: 'center',
              background: '#0D1526',
              borderTop: '2px solid rgba(239,35,60,.2)',
              borderBottom: showBottom ? '1px solid rgba(255,255,255,.07)' : 'none',
              flexShrink: 0, overflowX: 'auto',
              position: 'relative',
            }}>
              {/* Invisible hit-zone over the top border — drag here to resize */}
              {showBottom && (
                <div
                  style={{
                    position: 'absolute', top: -4, left: 0, right: 0, height: '8px',
                    cursor: 'ns-resize', zIndex: 5, touchAction: 'none',
                  }}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const startY = e.clientY
                    const startH = bottomH
                    let lastY = startY
                    let rafId = null
                    setIsDraggingBottom(true)
                    const onMove = (ev) => {
                      lastY = ev.clientY
                      if (rafId !== null) return
                      rafId = requestAnimationFrame(() => {
                        rafId = null
                        const newH = Math.max(180, Math.min(Math.floor(window.innerHeight * 0.65), startH + (startY - lastY)))
                        setBottomH(newH)
                      })
                    }
                    const onUp = () => {
                      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
                      setIsDraggingBottom(false)
                      window.removeEventListener('pointermove', onMove)
                      window.removeEventListener('pointerup', onUp)
                    }
                    window.addEventListener('pointermove', onMove)
                    window.addEventListener('pointerup', onUp)
                  }}
                />
              )}
              <TabBtn
                active={bottomTab === 'measurements' && showBottom}
                onClick={() => handleBottomTabClick('measurements')}
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke={bottomTab === 'measurements' && showBottom ? '#EF233C' : '#64748b'} strokeWidth="2">
                  <line x1="5" y1="19" x2="19" y2="5"/>
                  <circle cx="5" cy="19" r="2" fill="currentColor"/>
                  <circle cx="19" cy="5" r="2" fill="currentColor"/>
                </svg>}
                label="Measurements"
                badge={takeoffItems.length}
              />
              <TabBtn
                active={bottomTab === 'members' && showBottom}
                onClick={() => handleBottomTabClick('members')}
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke={bottomTab === 'members' && showBottom ? '#EF233C' : '#64748b'} strokeWidth="2">
                  <path d="M3 9h18M3 15h18M3 9V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>
                </svg>}
                label="Member Schedule"
                badge={memberScheduleItems.length}
              />
              <div style={{ flex: 1 }} />
              {memberScheduleItems.length > 0 && bottomTab === 'measurements' && !isMobile && showBottom && (
                <div style={{ fontSize: '11px', color: '#475569', padding: '0 12px', whiteSpace: 'nowrap' }}>
                  {memberScheduleItems.length} members · {memberScheduleItems.reduce((s, m) => s + (m.totalWeight ?? 0), 0).toFixed(0)} kg
                </div>
              )}
              {/* Collapse/expand double-arrow */}
              <button
                onClick={() => setShowBottom(o => !o)}
                title={showBottom ? 'Collapse Panel' : 'Expand Panel'}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '0 12px', height: '100%', display: 'flex', alignItems: 'center',
                  color: 'rgba(239,35,60,0.5)', transition: 'color .15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = '#EF233C' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'rgba(239,35,60,0.5)' }}
              >
                <svg width="13" height="9" viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  {showBottom ? (
                    <>
                      <polyline points="1,2 6,5 11,2"/>
                      <polyline points="1,5 6,8 11,5"/>
                    </>
                  ) : (
                    <>
                      <polyline points="1,8 6,5 11,8"/>
                      <polyline points="1,5 6,2 11,5"/>
                    </>
                  )}
                </svg>
              </button>
            </div>

            {/* Animated content area */}
            <div style={{
              height: showBottom ? `${bottomH}px` : '0px',
              overflow: 'hidden',
              transition: isDraggingBottom ? 'none' : 'height 250ms cubic-bezier(0.4,0,0.2,1)',
              background: '#080B12',
            }}>
              <div style={{ height: `${bottomH}px`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {bottomTab === 'measurements' ? (
                  <MeasurementTable
                    drawing={activeDrawing}
                    selectedId={selectedAnnotId}
                    onRowSelect={handleRowSelect}
                    onDelete={handleRowDelete}
                    onAddClick={() => { setPendingMeas(null); setShowAddModal(true) }}
                  />
                ) : (
                  <MemberSchedulePanel
                    drawing={activeDrawing}
                    onExport={handleExport}
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right panel */}
        {isMobile ? (
          <div
            className="panel-drawer"
            style={{
              position: 'fixed', top: 0, bottom: 0, right: 0, zIndex: 200,
              transform: rightOpen ? 'translateX(0)' : 'translateX(100%)',
              display: 'flex', flexDirection: 'column',
              boxShadow: rightOpen ? '-4px 0 30px rgba(0,0,0,.7)' : 'none',
            }}
          >
            <RightPanel
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
          <div
            style={{ display: 'flex', alignItems: 'stretch', flexShrink: 0 }}
            onMouseEnter={() => { clearTimeout(rightHoverTimer.current); setRightHovered(true) }}
            onMouseLeave={() => { rightHoverTimer.current = setTimeout(() => setRightHovered(false), 300) }}
          >
            <button
              onClick={() => { clearTimeout(rightHoverTimer.current); setRightHovered(false); setRightPanelOpen(o => !o) }}
              className="panel-toggle-tab panel-toggle-tab-right"
              title={rightPanelOpen ? 'Collapse Panel' : 'Expand Panel'}
            >
              <svg width="9" height="13" viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                {effectiveRightOpen ? (
                  <>
                    <polyline points="3,1 7,7 3,13"/>
                    <polyline points="7,1 11,7 7,13"/>
                  </>
                ) : (
                  <>
                    <polyline points="9,1 5,7 9,13"/>
                    <polyline points="5,1 1,7 5,13"/>
                  </>
                )}
              </svg>
            </button>
            <div style={{
              width: effectiveRightOpen ? '228px' : '0px',
              overflow: 'hidden', flexShrink: 0,
              transition: 'width 250ms cubic-bezier(0.4,0,0.2,1)',
              willChange: 'width',
            }}>
              <RightPanel
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
          </div>
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
            // On cancel during first-measure calibration, remove the orphaned reference line
            // from the PDF so the drawing stays clean and the user can try again.
            if (scaleSetupFirstMeasure && lastMeasurement?.annotationId) {
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

function TabBtn({ active, onClick, icon, label, badge }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '8px 14px', fontSize: '12px',
      fontWeight: active ? 700 : 400,
      color: active ? '#EF233C' : '#64748b',
      background: 'transparent', border: 'none', cursor: 'pointer',
      borderBottom: active ? '2px solid #EF233C' : '2px solid transparent',
      marginBottom: '-1px', transition: 'all .15s', whiteSpace: 'nowrap',
      touchAction: 'manipulation',
    }}>
      {icon}
      {label}
      {badge > 0 && (
        <span style={{
          background: active ? '#EF233C' : 'rgba(255,255,255,.1)',
          color: '#fff', borderRadius: '10px', padding: '0 5px', fontSize: '10px',
        }}>
          {badge}
        </span>
      )}
    </button>
  )
}
