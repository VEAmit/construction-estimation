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
  formatMeasureLength, formatMeasureArea,
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
} from '../utils/measureCalibration'
import { calibrationSnapshot, traceCalibration, traceMeasurementDebug, mergeCalibrationState } from '../utils/calibrationTrace'
import { buildLinearMeasurementClipboard } from '../utils/measureLabel'
import ExtractionModal from '../components/extraction/ExtractionModal'
import toast from 'react-hot-toast'

export default function DrawingsPage() {
  const navigate = useNavigate()
  const { isMobile, isTablet, isDesktop } = useBreakpoint()

  const {
    selectedProject, setSelectedProject,
    drawings: storeDrawings, setDrawings, selectedDrawing, setSelectedDrawing,
    takeoffItems, addTakeoffItem, setTakeoffItems, updateTakeoffItem,
    setSummary, activeTool, setActiveTool, setActiveUnit, activeUnit, updateDrawingCalibration,
    memberScheduleItems, setMemberScheduleItems, setMemberScheduleSummary,
    triggerPdfCommand,
    _hydrated,
    measureColor, lineThickness, lineStyle, arrowStyle, measureCategory,
    measurementClipboard, setMeasurementClipboard,
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
    if (item.color) setMeasureColor(item.color)
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

  // Mobile panel drawer state
  const [sidebarOpen,  setSidebarOpen]  = useState(false)
  const [rightOpen,    setRightOpen]    = useState(false)

  const annotationMapRef = useRef({})
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
        setMemberScheduleItems(members)
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
    setActiveTool(toolId)
  }, [setActiveTool])

  const autoSave = useCallback(async (measurement, { calibratedDrawing } = {}) => {
    const { selectedDrawing: drw, takeoffItems: current, measureColor: color, measureCategory: category, activeUnit } = useAppStore.getState()
    if (!drw?.id) return false

    const normDrwGuard = calibratedDrawing ? normalizeDrawing(calibratedDrawing) : getCalibratedDrawingFromStore()
    const needsCalib = ['Line', 'Area', 'Perimeter'].includes(measurement.measureType)
    if (needsCalib && !normDrwGuard?.isCalibrated && !calibratedDrawing) return false

    const pasteOverride = pasteStyleOverrideRef.current
    if (pasteOverride) pasteStyleOverrideRef.current = null
    const saveColor = pasteOverride?.color ?? color ?? '#111827'
    const saveCategory = pasteOverride?.category ?? category ?? 'General'

    const annotKey = measurement.annotationId
      ?? `${measurement.pageNumber}-${measurement.pixelLength}-${measurement.length}`
    if (annotKey && savingAnnotIdsRef.current.has(annotKey)) return
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
    const saveLength = normDrw?.isCalibrated && normDrw.scaleRatio > 0
      ? (resolved.length ?? computeRealLengthFromDrawing(measurement.pixelLength, normDrw, unit) ?? measurement.length)
      : (measurement.length ?? resolved.length)
    const saveArea = normDrw?.isCalibrated && normDrw.scaleRatio > 0
      ? (resolved.area ?? measurement.area)
      : (measurement.area ?? resolved.area)

    const itemType   = isArea ? 'Area' : isPerim ? 'Perimeter' : isCount ? 'Count' : 'Line'

    // Mark prefix per type: A# area, P# perimeter, C# count, M# line
    const prefix     = isArea ? 'A' : isPerim ? 'P' : isCount ? 'C' : 'M'
    const sameType   = current.filter(t => (t.itemType || 'Line') === itemType)
    const reuseMark  = clearedMarkRef.current
    if (reuseMark) clearedMarkRef.current = null
    const nextMark   = reuseMark ?? `${prefix}${sameType.length + 1}`

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

    try {
      const pointsJson = buildPointsJson()
      const saved = await takeoffService.create({
        drawingId:   drw.id,
        itemType,
        mark:        nextMark,
        description: desc,
        quantity:    isCount ? measurement.count : 1,
        unit,
        material:    '',
        notes:       '',
        length:      isCount ? null : (saveLength ?? null),
        area:        isCount ? null : (saveArea ?? null),
        unitWeight:  null,
        totalWeight: null,
        color:       saveColor,
        category:    saveCategory,
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
      setShowBottom(true)
      setBottomTab('measurements')
      // Continuous draw: do not keep the new row in "style edit" mode — toolbar color is for the next mark.
      setSelectedAnnotId(null)
      setStyleEditTargetId(null)
      annotStyleBaselineRef.current = null
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
      takeoffService.getSummary(drw.id)
        .then(sum => { setSummaryLocal(sum); setSummary(sum) })
        .catch(() => {})
      scheduleAnnotationBlobSave()
      if (isCount) {
        toast.success(`${nextMark}: ${measurement.count} × ${category} saved`, { duration: 2500, icon: '🔢' })
      } else if (isArea && saveArea != null) {
        toast.success(`${nextMark}: ${saveArea.toFixed(2)} ${getAreaUnitLabel(unit)}`, { duration: 2500, icon: '📐' })
      } else if (saveLength != null) {
        toast.success(`${nextMark}: ${saveLength.toFixed(3)} ${getUnitLabel(unit)}`, { duration: 2500, icon: '📐' })
      } else {
        toast('Measurement saved — set scale using a labelled dimension on the plan', { duration: 3500, icon: '📐' })
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
  }, [addTakeoffItem, scheduleAnnotationBlobSave])

  const handleMeasure = useCallback((measurement) => {
    const { activeTool: currentTool } = useAppStore.getState()
    const normDrw = getCalibratedDrawingFromStore()
    const needsCalib = ['Line', 'Area', 'Perimeter'].includes(measurement.measureType)

    if (currentTool === 'calibrate') {
      calibrateOnlyRef.current = true
      pendingCalibMeasureRef.current = null
      setScaleSetupFirstMeasure(false)
      setLastMeasurement(measurement)
      setShowCalModal(true)
      return
    }

    if (needsCalib && !normDrw?.isCalibrated) {
      calibrateOnlyRef.current = false
      pendingCalibMeasureRef.current = measurement
      setScaleSetupFirstMeasure(true)
      setLastMeasurement(measurement)
      setShowCalModal(true)
      return
    }

    // New mark — toolbar thickness applies to this line, not a previously selected row.
    setSelectedAnnotId(null)
    setStyleEditTargetId(null)
    annotStyleBaselineRef.current = null
    pendingMeasurementRef.current = {
      annotationId: measurement.annotationId,
      dbId: null,
      pendingThickness: useAppStore.getState().lineThickness,
      rawPointsJson: null,
    }

    setLastMeasurement(measurement)
    autoSave(measurement)
  }, [autoSave])

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
        triggerPdfCommand('rehydrateMeasureLabels')
        if (lastMeasurement?.annotationId && calibrateOnly) {
          triggerPdfCommand({ type: 'deleteAnnotation', annotationId: lastMeasurement.annotationId, pageNumber: lastMeasurement.pageNumber ?? 1 })
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

  const handleCopyMeasurement = useCallback(() => {
    if (!selectedAnnotId) return
    const item = takeoffItems.find(t => t.id === selectedAnnotId)
    if (!item?.pointsJson || (item.itemType || 'Line') !== 'Line') {
      toast.error('Select a linear measurement to copy')
      return
    }
    try {
      const raw = JSON.parse(item.pointsJson)
      const clipboard = buildLinearMeasurementClipboard(item, raw, pdfScale)
      setMeasurementClipboard(clipboard)
      toast.success(`Copied ${item.mark}`, { duration: 2000 })
    } catch {
      toast.error('Could not copy measurement')
    }
  }, [selectedAnnotId, takeoffItems, pdfScale, setMeasurementClipboard])

  const handlePasteMeasurement = useCallback(() => {
    if (!measurementClipboard) {
      toast('Copy a line measurement first (Ctrl+C)')
      return
    }
    if (!selectedDrawing) return
    pasteStyleOverrideRef.current = {
      color: measurementClipboard.color,
      category: measurementClipboard.category,
    }
    triggerPdfCommand({ type: 'pasteMeasurement', clipboard: measurementClipboard })
  }, [measurementClipboard, selectedDrawing, triggerPdfCommand])

  const canCopyMeasurement = !!selectedAnnotId && takeoffItems.some(
    t => t.id === selectedAnnotId && t.pointsJson && (t.itemType || 'Line') === 'Line',
  )
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

  const handleCalibrateScaleClick = useCallback(() => {
    setActiveTool('line')
    toast('Use Linear: draw along a dimension labelled on the plan (e.g. 6000 mm), then enter that length', { duration: 5500, icon: '📐' })
  }, [setActiveTool])

  const handleDrawingUploaded = async (drawing) => {
    const norm = normalizeDrawing(drawing)
    setSelectedDrawing(norm)
    setTakeoffItems([])
    setMemberScheduleItems([])
    setSummaryLocal(null)
    annotationMapRef.current = {}
    persistedAnnotIdsRef.current = new Set()
    setActiveTool('line')
    toast('Ready to measure — draw along a labelled dimension on the plan first', { duration: 5500, icon: '📐' })
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
      setMemberScheduleItems(members)
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

  // Bottom panel height
  const bottomH = isMobile ? '200px' : isTablet ? '240px' : '280px'

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

        {/* Left: Drawing sidebar — drawer on mobile */}
        <div
          className="panel-drawer"
          style={{
            position: isMobile ? 'fixed' : 'relative',
            top: isMobile ? 0 : undefined,
            bottom: isMobile ? 0 : undefined,
            left: isMobile ? 0 : undefined,
            zIndex: isMobile ? 200 : undefined,
            transform: isMobile && !sidebarOpen ? 'translateX(-100%)' : 'translateX(0)',
            display: 'flex', flexDirection: 'column',
            boxShadow: isMobile && sidebarOpen ? '4px 0 30px rgba(0,0,0,.7)' : 'none',
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
              if (!norm.isCalibrated) setActiveTool('line')
              if (isMobile) setSidebarOpen(false)
            }}
            onUploaded={handleDrawingUploaded}
            onDeleted={handleDrawingDeleted}
          />
        </div>

        {/* Center: PDF viewer + bottom panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {/* PDF Viewer */}
          <div style={{ flex: showBottom ? '1 1 60%' : '1 1 100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
          </div>

          {/* Bottom data panel */}
          {showBottom && (
            <div style={{
              flex: `0 0 ${bottomH}`, borderTop: '2px solid rgba(239,35,60,.3)',
              background: '#080B12', display: 'flex', flexDirection: 'column',
              overflow: 'hidden', minHeight: 0,
            }}>
              {/* Tab bar */}
              <div style={{ display: 'flex', alignItems: 'center', background: '#0D1526', borderBottom: '1px solid rgba(255,255,255,.07)', flexShrink: 0, overflowX: 'auto' }}>
                <TabBtn
                  active={bottomTab === 'measurements'}
                  onClick={() => setBottomTab('measurements')}
                  icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                    stroke={bottomTab === 'measurements' ? '#EF233C' : '#64748b'} strokeWidth="2">
                    <line x1="5" y1="19" x2="19" y2="5"/>
                    <circle cx="5" cy="19" r="2" fill="currentColor"/>
                    <circle cx="19" cy="5" r="2" fill="currentColor"/>
                  </svg>}
                  label="Measurements"
                  badge={takeoffItems.length}
                />
                <TabBtn
                  active={bottomTab === 'members'}
                  onClick={() => setBottomTab('members')}
                  icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                    stroke={bottomTab === 'members' ? '#EF233C' : '#64748b'} strokeWidth="2">
                    <path d="M3 9h18M3 15h18M3 9V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>
                  </svg>}
                  label="Member Schedule"
                  badge={memberScheduleItems.length}
                />
                <div style={{ flex: 1 }} />
                {memberScheduleItems.length > 0 && bottomTab === 'measurements' && !isMobile && (
                  <div style={{ fontSize: '11px', color: '#475569', padding: '0 12px', whiteSpace: 'nowrap' }}>
                    {memberScheduleItems.length} members · {memberScheduleItems.reduce((s, m) => s + (m.totalWeight ?? 0), 0).toFixed(0)} kg
                  </div>
                )}
              </div>

              {/* Tab content */}
              <div style={{ flex: 1, overflow: 'hidden' }}>
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
          )}
        </div>

        {/* Right panel — drawer on mobile */}
        <div
          className="panel-drawer"
          style={{
            position: isMobile ? 'fixed' : 'relative',
            top: isMobile ? 0 : undefined,
            bottom: isMobile ? 0 : undefined,
            right: isMobile ? 0 : undefined,
            zIndex: isMobile ? 200 : undefined,
            transform: isMobile && !rightOpen ? 'translateX(100%)' : 'translateX(0)',
            display: 'flex', flexDirection: 'column',
            boxShadow: isMobile && rightOpen ? '-4px 0 30px rgba(0,0,0,.7)' : 'none',
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
          />
        </div>
      </div>

      {/* ── Modals ─────────────────────────────────────────────── */}
      {showCalModal && (
        <CalibrationModal
          key={`cal-${lastMeasurement?.annotationId ?? 'x'}`}
          defaultUnit={activeDrawing?.calibrationUnit ?? activeUnit ?? 'Mm'}
          isFirstMeasure={scaleSetupFirstMeasure}
          saving={calSaving}
          onApply={handleCalibrationApply}
          onClose={() => {
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
