import '../../syncfusion-license.js'
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  PdfViewerComponent,
  Toolbar,
  Magnification,
  Navigation,
  LinkAnnotation,
  BookmarkView,
  ThumbnailView,
  Print,
  TextSelection,
  TextSearch,
  Annotation,
  Inject,
} from '@syncfusion/ej2-react-pdfviewer'
import { useAppStore } from '../../store/useAppStore'
import {
  pixelsToReal, polygonArea, polylineLength, ptDist, pixelsAreaToReal, computePixelPerimeter,
  convertFromMm, toMm, formatMeasureLength, formatMeasureArea,
  parseMeasureLabel, convertMeasureValue, getUnitLabel,
} from '../../utils/calculations'
import { buildMeasureLabelPatch, toSyncfusionLabelSize, buildLinearDistanceStyle, buildLinearLabelDiagramStyle } from '../../utils/measureLabel'
import toast from 'react-hot-toast'

// Syncfusion pdfium WASM files live in /public/ej2-pdfviewer-lib (copied by the Vite plugin).
// Must be an absolute URL: the pdfium worker is created from a blob: URL, so importScripts
// inside it needs a fully-qualified origin to avoid blob-origin resolution issues.
// Not setting serviceUrl switches the viewer to client-side WASM rendering — no backend needed.
const SF_RESOURCE_URL = `${window.location.origin}/ej2-pdfviewer-lib`

const MEASURE_MODES = { line: 'Distance', calibrate: 'Distance', area: 'Area', perimeter: 'Perimeter' }
const CONTINUOUS_MEASURE_TOOLS = new Set(['line', 'calibrate', 'area', 'perimeter'])

// Map our unit key → Syncfusion DistanceMeasurementUnit string
function toSfUnit(unit) {
  const map = { Mm: 'Millimeter', Cm: 'Centimeter', Meter: 'Meter', Feet: 'Foot', Inch: 'Inch' }
  return map[unit] ?? 'Millimeter'
}

// Map Syncfusion unit string → our unit key
function fromSfUnit(sfUnit) {
  const map = { Millimeter: 'Mm', Centimeter: 'Cm', Meter: 'Meter', Foot: 'Feet', Inch: 'Inch' }
  return map[sfUnit] ?? 'Mm'
}

function isMeasureAnnotation(annot) {
  if (!annot) return false
  const shape = String(annot.shapeAnnotationType ?? annot.ShapeAnnotationType ?? '').toLowerCase()
  const it = String(annot.IT ?? annot.it ?? '')
  // Syncfusion distance/area/perimeter measures — check BEFORE type (often reports type "Text")
  if (['distance', 'area', 'perimeter'].includes(shape)) return true
  if (['LineDimension', 'PolyLineDimension', 'Area', 'Perimeter'].includes(it)) return true

  const type = String(annot.type ?? '').toLowerCase()
  if (type === 'text' || type === 'freetext') return false
  if (type === 'line' && (annot.start || annot.end || annot.Start || annot.End)) return true
  return false
}

function applyGlobalMeasureLabelSettings(vm, userPt, pdfScale, fontColor = '#111827') {
  const patch = buildMeasureLabelPatch(userPt, pdfScale, fontColor)
  try {
    // Keep false — Syncfusion native labels crash mid-draw (updateScaleRatioCollection).
    // Values are shown via our container-scoped HTML overlay instead.
    vm.enableShapeLabel = false
  } catch (_) {}
  ;['Distance', 'Area', 'Perimeter'].forEach(type => {
    try { vm.annotation.updateMeasurementSettings(type, patch) } catch (_) {}
  })
}

function parseAnnotCoord(val) {
  if (typeof val === 'object' && val !== null) {
    return { x: Number(val.x ?? val.X) || 0, y: Number(val.y ?? val.Y) || 0 }
  }
  const parts = String(val).split(',')
  return { x: parseFloat(parts[0]) || 0, y: parseFloat(parts[1]) || 0 }
}

/** Extract vertex geometry from any Syncfusion measure annotation shape. */
function extractAnnotationPoints(a) {
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
    pts = [parseAnnotCoord(start), parseAnnotCoord(end)]
  }

  const bounds = a?.Bounds ?? a?.bounds
  if (pts.length < 2 && bounds && typeof bounds === 'object') {
    const bx = Number(bounds.X ?? bounds.x ?? 0)
    const by = Number(bounds.Y ?? bounds.y ?? 0)
    const bw = Math.abs(Number(bounds.Width ?? bounds.width ?? 0))
    const bh = Math.abs(Number(bounds.Height ?? bounds.height ?? 0))
    if (bw >= 0.1 || bh >= 0.1) {
      pts = [{ x: bx, y: by }, { x: bx + bw, y: by + bh }]
    }
  }

  return pts
}

/** Resolve the live Syncfusion diagram object for an annotation id. */
function resolveLiveAnnotation(vm, annotationId) {
  if (!vm || !annotationId) return null
  if (vm.nameTable?.[annotationId]) return vm.nameTable[annotationId]
  return Object.values(vm.nameTable ?? {}).find(
    a => a?.annotName === annotationId || a?.id === annotationId,
  ) ?? null
}

/**
 * Write the grid-calculated label onto Syncfusion's distance/perimeter diagram text.
 * Syncfusion initDistanceLabel uses setConversion() when notes is empty → NaN without its
 * internal calibrate UI. We bypass that and set notes + text element content directly.
 */
function applyCalibratedLabelToDiagram(vm, annotationId, pageNumber, labelText, fontColor, diagramStyle) {
  if (!vm || !annotationId || !labelText) return false
  const live = resolveLiveAnnotation(vm, annotationId)
  if (!live?.wrapper?.children?.length) return false

  live.notes = labelText
  live.note = labelText
  live.labelContent = labelText

  const labelStyle = diagramStyle ?? {}
  const sfSize = labelStyle.fontSize
  const fill = labelStyle.labelFillColor ?? 'rgba(255,255,255,0.94)'
  const border = labelStyle.labelBorderColor ?? 'rgba(0,0,0,0.2)'
  const color = labelStyle.fontColor ?? fontColor

  let updated = false
  for (const child of live.wrapper.children) {
    if (!child?.textNodes) continue
    child.content = labelText
    if (child.childNodes?.[0]) child.childNodes[0].text = labelText
    if (sfSize) child.style.fontSize = sfSize
    if (color) child.style.color = color
    child.style.fill = fill
    child.style.strokeColor = border
    if (typeof child.refreshTextElement === 'function') child.refreshTextElement()
    child.isDirt = true
    updated = true
  }
  if (!updated) return false

  const pageIdx = live.pageIndex ?? Math.max(0, (pageNumber ?? 1) - 1)
  const mod = vm.annotation?.measureAnnotationModule
  try { mod?.modifyInCollection?.('notes', pageIdx, live, false) } catch (_) {}
  try { vm.annotation?.renderAnnotations?.(pageIdx, null, null, null, null, false) } catch (_) {}
  try { vm.renderDrawing?.() } catch (_) {}
  return true
}

/** Apply unified line weight + leaders + arrows to a live distance annotation. */
function applyLinearVisualStyleToDiagram(vm, annotationId, linearStyle) {
  if (!vm || !annotationId || !linearStyle) return false
  const live = resolveLiveAnnotation(vm, annotationId)
  if (!live?.wrapper) return false

  const nodePatch = {}
  if (linearStyle.thickness != null) nodePatch.thickness = linearStyle.thickness
  if (linearStyle.leaderLength != null) nodePatch.leaderHeight = linearStyle.leaderLength
  if (linearStyle.strokeColor) nodePatch.strokeColor = linearStyle.strokeColor

  if (Object.keys(nodePatch).length) {
    try { vm.nodePropertyChange(live, nodePatch) } catch (_) {}
  }

  const annMod = vm.annotation
  if (annMod?.getArrowType) {
    if (linearStyle.lineHeadStartStyle) {
      live.sourceDecoraterShapes = annMod.getArrowType(linearStyle.lineHeadStartStyle)
    }
    if (linearStyle.lineHeadEndStyle) {
      live.taregetDecoraterShapes = annMod.getArrowType(linearStyle.lineHeadEndStyle)
    }
  }

  if (linearStyle.thickness != null && live.wrapper.children?.length) {
    for (const child of live.wrapper.children) {
      const id = String(child.id ?? '')
      if (child.style && !child.textNodes) {
        child.style.strokeWidth = linearStyle.thickness
      }
      if (id.includes('srcDec') || id.includes('tarDec')) {
        child.width = 12 * linearStyle.thickness
        child.height = 12 * linearStyle.thickness
      }
    }
  }

  if (live.shapeAnnotationType === 'Distance' && live.vertexPoints?.length) {
    try { vm.drawing?.updateConnector?.(live, live.vertexPoints) } catch (_) {}
  }

  const pageIdx = live.pageIndex ?? 0
  const mod = vm.annotation?.measureAnnotationModule
  if (linearStyle.thickness != null) {
    try { mod?.modifyInCollection?.('thickness', pageIdx, live, false) } catch (_) {}
  }
  try { vm.annotation?.renderAnnotations?.(pageIdx, null, null, null, null, false) } catch (_) {}
  try { vm.renderDrawing?.() } catch (_) {}
  return true
}

/** Register per-annotation scale ratio so Syncfusion label math uses calibrated scale. */
function registerAnnotationScaleRatio(mod, annotationId, drawing, displayUnit) {
  if (!mod?.scaleRatioCollection || !drawing?.isCalibrated || !annotationId) return
  const unit = getUnitLabel(displayUnit)
  const destPerPx = convertFromMm(drawing.scaleRatio, displayUnit)
  const entry = {
    id: annotationId,
    annotName: annotationId,
    displayUnit: unit,
    unit: 'px',
    ratio: destPerPx,
    destValue: destPerPx,
    srcValue: 1,
    volumeDepth: drawing.scaleRatio,
    depthValue: drawing.scaleRatio,
    ratioString: `1 px = ${destPerPx} ${unit}`,
  }
  const idx = mod.scaleRatioCollection.findIndex(r => r.annotName === annotationId)
  if (idx >= 0) Object.assign(mod.scaleRatioCollection[idx], entry)
  else mod.scaleRatioCollection.push(entry)
}

function patchMeasureAnnotationLabel(annot, userPt, pdfScale, fontColor = '#111827', thicknessOverride, arrowStyle) {
  const isLine = String(annot.shapeAnnotationType ?? annot.ShapeAnnotationType ?? '').toLowerCase() === 'distance'
    || annot.IT === 'LineDimension' || annot.it === 'LineDimension'
  const stylePatch = isLine
    ? buildLinearDistanceStyle(userPt, pdfScale, fontColor, thicknessOverride, arrowStyle)
    : buildMeasureLabelPatch(userPt, pdfScale, fontColor)
  return { ...annot, ...stylePatch }
}

function Step({ n, text }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
      <span style={{ width:'18px', height:'18px', borderRadius:'50%', background:'#1e293b',
        border:'1px solid #334155', color:'#475569', fontSize:'10px', fontWeight:700,
        display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{n}</span>
      <span style={{ fontSize:'11px', color:'#334155' }}>{text}</span>
    </div>
  )
}

export default function PdfViewer({
  drawingUrl,
  drawing,
  activeTool,
  onMeasure,
  onAnnotationsBlob,   // called with base64 export blob after each Save Lines
  annotations = [],
  selectedAnnotationId,
  onAnnotationSelect,
  getProtectedAnnotIds,       // () => Set of DB-persisted annotation IDs (safe from Clear)
  onClearPending,             // () => Promise<boolean> — clear active pending measurement
  measureReleaseRef,          // ref — parent calls .current(id) to allow re-save after API failure
}) {
  const viewerRef   = useRef(null)
  const containerRef = useRef(null)
  const [pdfBase64, setPdfBase64]     = useState(null)
  const [loading,   setLoading]       = useState(false)
  const [errorMsg,  setErrorMsg]      = useState(null)
  const [viewerSize, setViewerSize]   = useState({ w: 0, h: 0 })
  const [docLoaded,  setDocLoaded]    = useState(false)
  const [countMarkers, setCountMarkers] = useState([])  // [{id, xPct, yPct, page, label}]
  const countMarkersRef = useRef([])
  const prevUrlRef  = useRef(null)
  // Pan-drag state — full tracking state for click-and-drag scrolling.
  const panStateRef = useRef({
    dragging:  false,
    prevX:     0,
    prevY:     0,
    startX:    0,
    startY:    0,
    hasMoved:  false,
    scrollEls: null,
  })

  // Track the full annotation object from the last annotationSelect event.
  // Used to call editAnnotation when the user changes color/thickness while an annotation is selected.
  const selectedAnnotDataRef = useRef(null)
  // Suppress handleAnnotationPropertiesChange re-saves while we are calling editAnnotation ourselves.
  const editingAnnotRef = useRef(false)

  const {
    pdfScale, pdfPage, setPdfPage, setPdfTotalPages, setPdfScale,
    pdfCommand, clearPdfCommand,
    measureColor, lineThickness, fillOpacity,
    lineStyle, arrowStyle, fontSize,
    measureLabelFontSize, activeUnit,
    setCountSession,
  } = useAppStore()

  // Keep countMarkers ref in sync and update the store's countSession badge
  useEffect(() => {
    countMarkersRef.current = countMarkers
    setCountSession(countMarkers.filter(m => m.page === pdfPage).length)
  }, [countMarkers, pdfPage, setCountSession])

  // Reset count markers when drawing changes
  useEffect(() => {
    setCountMarkers([])
    setCountSession(0)
  }, [drawingUrl, setCountSession])

  // ── Refs — must be declared before any useEffect that uses them ────────
  // Keep latest drawing + callbacks in refs so stable Syncfusion callbacks
  // always read fresh values without being recreated.
  const drawingRef          = useRef(drawing)
  const onMeasureRef        = useRef(onMeasure)
  const onAnnotationsBlobRef = useRef(onAnnotationsBlob)
  const getProtectedAnnotIdsRef = useRef(getProtectedAnnotIds)
  useEffect(() => { drawingRef.current           = drawing          }, [drawing])
  useEffect(() => { onMeasureRef.current         = onMeasure        }, [onMeasure])
  useEffect(() => { onAnnotationsBlobRef.current = onAnnotationsBlob }, [onAnnotationsBlob])
  useEffect(() => { getProtectedAnnotIdsRef.current = getProtectedAnnotIds }, [getProtectedAnnotIds])

  const importedAnnotIdsRef = useRef(new Set())
  const processedAnnotsRef = useRef(new Set())
  const pendingLabelByAnnotRef = useRef(new Map())
  const lastDrawnAnnotRef = useRef(null)
  const measureCompleteTimersRef = useRef(new Map())

  const importingAnnotsRef  = useRef(false)
  const importedDrawingRef  = useRef(null)
  const importCompletedRef  = useRef(false)
  const explicitGridSelectRef = useRef(false)

  useEffect(() => {
    importedAnnotIdsRef.current = new Set()
    processedAnnotsRef.current = new Set()
    pendingLabelByAnnotRef.current = new Map()
    importedDrawingRef.current = null
    importCompletedRef.current = false
    measureCompleteTimersRef.current.forEach(t => clearTimeout(t))
    measureCompleteTimersRef.current.clear()
  }, [drawing?.id])

  useEffect(() => {
    if (!measureReleaseRef) return
    measureReleaseRef.current = (annotationId) => {
      if (annotationId) processedAnnotsRef.current.delete(annotationId)
    }
    return () => { measureReleaseRef.current = null }
  }, [measureReleaseRef])

  // Pre-seed saved annotation IDs from DB (prevents duplicate rows on reload)
  useEffect(() => {
    if (!drawing?.id) return
    annotations.forEach(item => {
      if (!item.pointsJson) return
      try {
        const raw = JSON.parse(item.pointsJson)
        const id = raw.annotationId ?? raw.AnnotName ?? raw.uniqueKey ?? raw.name
        if (id) processedAnnotsRef.current.add(id)
      } catch (_) {}
    })
  }, [drawing?.id, annotations])

  // Sync diagram labels + linear visual style for saved line measurements
  useEffect(() => {
    if (!docLoaded || !annotations?.length) return
    requestAnimationFrame(() => {
      const vm = viewerRef.current
      if (!vm) return
      const { measureLabelFontSize: labelPt, lineThickness: thick, arrowStyle: arrows } = useAppStore.getState()
      annotations.forEach(item => {
        if (!item.pointsJson) return
        try {
          const raw = JSON.parse(item.pointsJson)
          const isLine = (item.itemType || 'Line') === 'Line'
          const isArea = item.itemType === 'Area'
          const text = isArea
            ? formatMeasureArea(item.area, item.unit ?? 'Mm')
            : formatMeasureLength(item.length, item.unit ?? 'Mm')
          if (!text) return
          const id = raw.annotationId ?? raw.AnnotName ?? raw.name ?? `db-${item.id}`
          const pageNumber = raw.pageNumber ?? raw.PageNumber
            ?? (parseInt(raw.page ?? raw.pageIndex ?? '0', 10) + 1)
          const color = raw.strokeColor ?? raw.StrokeColor ?? item.color ?? '#111827'
          if (isLine) {
            const storedThick = raw.Thickness ?? raw.thickness ?? thick
            const linearStyle = buildLinearDistanceStyle(labelPt, pdfScale, color, storedThick, arrows)
            linearStyle.strokeColor = color
            const diagramStyle = buildLinearLabelDiagramStyle(labelPt, pdfScale, color)
            applyCalibratedLabelToDiagram(vm, id, pageNumber, text, color, diagramStyle)
            applyLinearVisualStyleToDiagram(vm, id, linearStyle)
          } else {
            applyCalibratedLabelToDiagram(vm, id, pageNumber, text, color)
          }
        } catch (_) {}
      })
    })
  }, [docLoaded, annotations, measureLabelFontSize, pdfScale])

  const extractMeasurementValue = (a) => {
    const direct = a.measurementValue ?? a.MeasurementValue
    if (direct != null && Number(direct) > 0) return Number(direct)

    const cal = a.Calibrate ?? a.calibrate
    if (cal) {
      const dist = cal.Distance ?? cal.distance
      if (Array.isArray(dist) && dist.length > 0 && Number(dist[0]) > 0) return Number(dist[0])
      if (typeof dist === 'number' && dist > 0) return dist
    }

    const label = a.Note ?? a.note ?? a.labelContent ?? a.LabelContent ?? a.label ?? a.text
    if (label) {
      const m = String(label).match(/([\d.]+)/)
      if (m) return parseFloat(m[1])
    }
    return null
  }

  const extractSfMeasurement = (a, calibrationUnit) => {
    const labelText = String(
      a.Note ?? a.note ?? a.labelContent ?? a.LabelContent ?? a.label ?? a.text ?? ''
    ).trim()
    const fromLabel = parseMeasureLabel(labelText)
    if (fromLabel?.value > 0) return fromLabel

    const cal = a.Calibrate ?? a.calibrate
    if (cal) {
      const dist = cal.Distance ?? cal.distance
      let val = null
      if (Array.isArray(dist) && dist.length > 0) val = Number(dist[0])
      else if (typeof dist === 'number') val = dist
      if (val != null && val > 0) {
        return { value: val, unit: calibrationUnit ?? 'Mm', isArea: false }
      }
    }

    const mv = extractMeasurementValue(a)
    if (mv != null && mv > 0) {
      return { value: mv, unit: calibrationUnit ?? 'Mm', isArea: false }
    }
    return null
  }

  const buildPlainAnnot = (a) => {
    const pts = extractAnnotationPoints(a)
    const annotId = a.annotationId ?? a.AnnotName ?? a.name ?? a.id
    let start = a.start ?? a.Start
    let end = a.end ?? a.End
    const shapeType = String(a.shapeAnnotationType ?? a.ShapeAnnotationType ?? 'Distance').toLowerCase()
    const it = String(a.IT ?? a.it ?? 'LineDimension')
    const normalizedType = shapeType === 'distance' || it === 'LineDimension' ? 'Line'
      : shapeType === 'area' || it === 'PolyLineDimension' || it === 'Area' ? 'Area'
      : shapeType === 'perimeter' || it === 'Perimeter' ? 'Perimeter'
      : (a.type ?? 'Line')
    return {
      annotationId:        annotId,
      name:                annotId,
      AnnotName:           a.AnnotName ?? annotId,
      type:                normalizedType,
      IT:                  a.IT ?? a.it ?? 'LineDimension',
      shapeAnnotationType: a.shapeAnnotationType ?? a.ShapeAnnotationType ?? 'Distance',
      pageNumber:          a.pageNumber ?? a.PageNumber ?? (parseInt(a.page ?? '0', 10) + 1),
      page:                String(a.page != null ? parseInt(a.page, 10) : ((a.pageNumber ?? a.PageNumber ?? 1) - 1)),
      strokeColor:         a.strokeColor ?? a.StrokeColor ?? '#EF233C',
      fillColor:           a.fillColor ?? a.FillColor ?? 'rgba(239,35,60,0.15)',
      thickness:           a.thickness ?? a.Thickness ?? 2,
      opacity:             a.opacity ?? a.Opacity ?? 1,
      measurementValue:    extractMeasurementValue(a),
      Note:                a.Note ?? a.note,
      note:                a.note ?? a.Note,
      labelContent:        a.labelContent ?? a.LabelContent,
      LabelContent:        a.LabelContent ?? a.labelContent,
      label:               a.label ?? a.text,
      text:                a.text ?? a.label,
      Calibrate:           a.Calibrate ?? a.calibrate,
      calibrate:           a.calibrate ?? a.Calibrate,
      vertexPoints:        pts,
      ...(pts.length >= 2 ? {
        start: `${pts[0].x},${pts[0].y}`,
        end:   `${pts[pts.length - 1].x},${pts[pts.length - 1].y}`,
      } : {}),
      ...(start && end ? { start, end } : {}),
    }
  }

  const exportAndProcessUnsaved = useCallback((vm) => {
    if (!vm?.exportAnnotationsAsObject) return
    try {
      const result = vm.exportAnnotationsAsObject()
      const processExport = (raw) => {
        if (!raw) return
        let data = raw
        if (typeof data === 'string') {
          try { data = JSON.parse(data) } catch (_) { return }
        }
        const flat = []
        const push = (item) => {
          let a = item
          if (typeof a === 'string') { try { a = JSON.parse(a) } catch (_) { return } }
          if (a && typeof a === 'object' && !Array.isArray(a)) flat.push(a)
        }
        if (Array.isArray(data)) {
          data.forEach(push)
        } else {
          const pages = data?.pdfAnnotation ?? {}
          Object.values(pages).forEach(pageData => {
            ;['measureShapeAnnotation', 'shapeAnnotation', 'measureAnnotation'].forEach(key => {
              let list = pageData?.[key] ?? []
              if (typeof list === 'string') { try { list = JSON.parse(list) } catch (_) { list = [] } }
              if (Array.isArray(list)) list.forEach(push)
            })
          })
        }
        flat.forEach(a => processMeasureRef.current?.(buildPlainAnnot(a)))
      }
      if (result && typeof result.then === 'function') {
        result.then(processExport).catch(err => {
          console.error('[BuildTakeoff] exportAnnotationsAsObject rejected — a stored annotation likely has corrupted/null vertex data:', err)
        })
      } else if (result) {
        processExport(result)
      }
    } catch (err) {
      console.error('[BuildTakeoff] exportAndProcessUnsaved failed:', err)
    }
  }, [])

  const processMeasureRef = useRef(null)

  const getDisplayUnit = useCallback(() => {
    const d = drawingRef.current
    return useAppStore.getState().activeUnit ?? d?.calibrationUnit ?? 'Mm'
  }, [])

  // Syncfusion's updateScaleRatioCollection writes to sourceTextBox.value on mouseup.
  // sourceTextBox is created by createRatioUI(). Do NOT call createScaleRatioWindow() —
  // that opens an isModal dialog whose overlay blocks all PDF clicks and causes blur.
  const ensureMeasureScaleUi = useCallback((vm) => {
    const mod = vm?.annotation?.measureAnnotationModule
    if (!mod || mod.sourceTextBox) return
    try {
      if (mod.scaleRatioDialog) {
        try { mod.scaleRatioDialog.hide(); mod.scaleRatioDialog.destroy() } catch (_) {}
        mod.scaleRatioDialog = null
      }
      vm.element?.querySelectorAll('.e-dlg-overlay, .e-overlay').forEach(el => el.remove())

      const viewerId = vm.element?.id ?? 'sfPdfViewer'
      const hostId = `${viewerId}_bt_scale_host`
      let host = document.getElementById(hostId)
      if (!host) {
        host = document.createElement('div')
        host.id = hostId
        host.setAttribute('aria-hidden', 'true')
        host.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;'
        vm.element?.appendChild(host)
      }
      host.innerHTML = ''
      const ui = mod.createRatioUI()
      if (ui) host.appendChild(ui)
    } catch (_) {}
  }, [])

  const applyCalibrationToViewer = useCallback((vm) => {
    const d = drawingRef.current
    if (!vm) return
    ensureMeasureScaleUi(vm)
    if (!d?.isCalibrated || !d?.scaleRatio) return
    try {
      vm.enableShapeLabel = false
      const sfUnit = toSfUnit(d.calibrationUnit ?? 'Mm')
      const unitLabel = getUnitLabel(d.calibrationUnit ?? 'Mm')
      const destPerPx = convertFromMm(d.scaleRatio, d.calibrationUnit ?? 'Mm')
      const calPatch = {
        displayUnit: sfUnit,
        conversionUnit: sfUnit,
        depth: d.scaleRatio,
        scaleRatio: 1,
        ...buildMeasureLabelPatch(measureLabelFontSize, pdfScale, '#111827'),
      }
      vm.measurementSettings = { ...vm.measurementSettings, ...calPatch }
      vm.annotation.updateMeasurementSettings('Distance', calPatch)
      try { vm.annotation.updateMeasurementSettings() } catch (_) {}
      ;['Area', 'Perimeter'].forEach(type => {
        try {
          vm.annotation.updateMeasurementSettings(type, {
            displayUnit: sfUnit,
            conversionUnit: sfUnit,
            depth: d.scaleRatio,
            scaleRatio: 1,
          })
        } catch (_) {}
      })
      const mod = vm.annotation?.measureAnnotationModule
      if (mod?.sourceTextBox) mod.sourceTextBox.value = 1
      if (mod?.destTextBox) mod.destTextBox.value = destPerPx
      // Default ratio for new annotations — each line also gets its own entry on completion
      if (mod) {
        mod.measureRatioObject = {
          ratio: destPerPx,
          unit: 'px',
          displayUnit: unitLabel,
          destValue: destPerPx,
          srcValue: 1,
          volumeDepth: d.scaleRatio,
          depthValue: d.scaleRatio,
          ratioString: `1 px = ${destPerPx} ${unitLabel}`,
        }
      }
      if (mod && mod.scaleRatioCollection?.length === 0) {
        mod.scaleRatioCollection.push({
          id: 'buildtakeoff-calibration-default',
          annotName: 'buildtakeoff-calibration-default',
          displayUnit: unitLabel,
          unit: 'px',
          ratio: destPerPx,
          destValue: destPerPx,
          srcValue: 1,
          volumeDepth: d.scaleRatio,
          depthValue: d.scaleRatio,
          ratioString: `1 px = ${destPerPx} ${unitLabel}`,
        })
      }
    } catch (_) {}
  }, [ensureMeasureScaleUi, measureLabelFontSize, pdfScale])

  /** Bluebeam-style: after each measurement, deselect and re-enter draw mode for the active tool. */
  const ensureContinuousMeasureMode = useCallback(() => {
    const vm = viewerRef.current
    if (!vm) return
    const { activeTool: tool, pdfPage: page } = useAppStore.getState()
    const mode = MEASURE_MODES[tool]
    if (!mode) return

    selectedAnnotDataRef.current = null
    const pageIdx = Math.max(0, (page ?? 1) - 1)
    try { vm.clearSelection?.(pageIdx) } catch (_) {}
    try { vm.annotation?.clearSelection?.() } catch (_) {}
    try { vm.annotation.setAnnotationMode('None') } catch (_) {}
    setTimeout(() => {
      try { vm.annotation.setAnnotationMode(mode) } catch (_) {}
    }, 40)
  }, [])

  const applyMeasureLabelToViewer = useCallback((annot, labelText, _numericLength, pageNumber, displayUnit) => {
    const vm = viewerRef.current
    const d = drawingRef.current
    if (!vm || !labelText || !annot) return
    const annotationId = annot.annotationId ?? annot.AnnotName ?? annot.name
    if (!annotationId) return
    const mod = vm.annotation?.measureAnnotationModule
    if (mod && d?.isCalibrated) {
      registerAnnotationScaleRatio(mod, annotationId, d, displayUnit)
    }
    const { measureColor: color, lineThickness: thick, arrowStyle: arrows, measureLabelFontSize: labelPt, pdfScale: zoom } = useAppStore.getState()
    const fontColor = annot.strokeColor ?? annot.StrokeColor ?? color ?? '#111827'
    const linearStyle = buildLinearDistanceStyle(labelPt, zoom ?? pdfScale, fontColor, thick, arrows)
    linearStyle.strokeColor = fontColor
    const diagramStyle = buildLinearLabelDiagramStyle(labelPt, zoom ?? pdfScale, fontColor)
    editingAnnotRef.current = true
    const finish = () => {
      applyLinearVisualStyleToDiagram(vm, annotationId, linearStyle)
      setTimeout(() => { editingAnnotRef.current = false }, 120)
      ensureContinuousMeasureMode()
    }
    const apply = (attempt = 0) => {
      const ok = applyCalibratedLabelToDiagram(vm, annotationId, pageNumber, labelText, fontColor, diagramStyle)
      if (!ok && attempt < 8) {
        setTimeout(() => apply(attempt + 1), 80)
        return
      }
      finish()
    }
    apply()
  }, [ensureContinuousMeasureMode, pdfScale])

  const applyLabelToAnnot = useCallback((annot, labelText) => {
    const vm = viewerRef.current
    if (!vm || !annot) return
    const fontColor = annot.strokeColor ?? annot.StrokeColor ?? measureColor ?? '#111827'
    editingAnnotRef.current = true
    try {
      vm.annotation.editAnnotation(
        patchMeasureAnnotationLabel(annot, measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle),
      )
    } catch (_) {}
    setTimeout(() => { editingAnnotRef.current = false }, 300)
  }, [measureColor, measureLabelFontSize, pdfScale, lineThickness, arrowStyle])

  const syncAnnotationLabel = useCallback((annotationId, pageNumber, labelText) => {
    const vm = viewerRef.current
    if (!vm || !annotationId || !labelText) return
    pendingLabelByAnnotRef.current.set(annotationId, { pageNumber, labelText })
    setTimeout(() => {
      try {
        vm.annotation.selectAnnotation(annotationId, pageNumber ?? 1)
        setTimeout(() => {
          const current = selectedAnnotDataRef.current
          const base = current && (
            current.annotationId === annotationId
            || current.name === annotationId
            || current.AnnotName === annotationId
          ) ? current : { annotationId, name: annotationId, AnnotName: annotationId }
          applyLabelToAnnot(base, labelText)
        }, 100)
      } catch (_) {}
    }, 150)
  }, [applyLabelToAnnot])

  // ── Shared helper: extract measurement + call onMeasure ──────────────────
  const processMeasureAnnotation = useCallback((anno) => {
    let a = anno
    if (typeof a === 'string') { try { a = JSON.parse(a) } catch (_) { return } }
    if (!a || typeof a !== 'object') return

    if (!isMeasureAnnotation(a)) return

    const annotationId = a.annotationId ?? a.AnnotationId ?? a.AnnotName ?? a.name ?? a.id ?? null
    if (annotationId && processedAnnotsRef.current.has(annotationId)) return

    const d = drawingRef.current
    const displayUnit = getDisplayUnit()

    const IT = a.IT ?? a.it ?? ''
    const shapeType = (a.shapeAnnotationType ?? a.ShapeAnnotationType ?? a.type ?? '').toLowerCase()
    const isAreaAnnotation     = IT === 'PolyLineDimension' || shapeType === 'polygon' || IT === 'Area'
    const isPerimeterAnnotation = IT === 'Perimeter'

    const pts = extractAnnotationPoints(a)

    let length    = null
    let pixelLength = 0
    let area      = null
    let pixelArea = 0

    if (isAreaAnnotation && pts.length >= 3) {
      pixelArea   = polygonArea(pts)
      pixelLength = computePixelPerimeter(pts)
      if (d?.isCalibrated && d?.scaleRatio && pixelArea > 0) {
        area   = pixelsAreaToReal(pixelArea, d.scaleRatio, displayUnit)
        length = pixelsToReal(pixelLength, d.scaleRatio, displayUnit)
      }
    } else if (pts.length >= 2) {
      pixelLength = polylineLength(pts)
      if (d?.isCalibrated && d?.scaleRatio) {
        length = pixelsToReal(pixelLength, d.scaleRatio, displayUnit)
      }
    }

    if (length == null) {
      const sfVal = extractMeasurementValue(a)
      if (sfVal != null && sfVal > 0) length = sfVal
    }

    if ((length == null || length <= 0) && pixelLength >= 0.1 && d?.isCalibrated && d?.scaleRatio) {
      length = pixelsToReal(pixelLength, d.scaleRatio, displayUnit)
    }
    if ((area == null || area <= 0) && pixelArea >= 0.1 && d?.isCalibrated && d?.scaleRatio) {
      area = pixelsAreaToReal(pixelArea, d.scaleRatio, displayUnit)
    }

    const hasLineValue = pixelLength >= 0.1 || (length != null && length > 0)
    const hasAreaValue = pixelArea >= 0.1 || (area != null && area > 0)
    if (isAreaAnnotation) {
      if (!hasAreaValue) return
    } else if (!hasLineValue) {
      return
    }

    const pageNumber = a.pageNumber ?? a.PageNumber ?? (parseInt(a.page ?? '0', 10) + 1)

    if (annotationId) {
      processedAnnotsRef.current.add(annotationId)
      lastDrawnAnnotRef.current = annotationId
    }

    const numericLength = isAreaAnnotation ? area : length
    const labelText = isAreaAnnotation
      ? formatMeasureArea(area, displayUnit)
      : formatMeasureLength(length, displayUnit)

    if (labelText && annotationId && Number.isFinite(numericLength) && numericLength > 0) {
      applyMeasureLabelToViewer(a, labelText, numericLength, pageNumber, displayUnit)
    } else if (annotationId) {
      // Uncalibrated or zero-length — still return to ready-to-draw state
      setTimeout(ensureContinuousMeasureMode, 100)
    }

    onMeasureRef.current?.({
      length,
      area,
      pixelLength,
      pixelArea,
      unit: displayUnit,
      points: [],
      annotationId,
      pageNumber,
      rawAnnotation: a,
      measureType: isAreaAnnotation ? 'Area' : isPerimeterAnnotation ? 'Perimeter' : 'Line',
    })
  }, [getDisplayUnit, measureLabelFontSize, pdfScale, applyMeasureLabelToViewer, ensureContinuousMeasureMode])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { processMeasureRef.current = processMeasureAnnotation }, [processMeasureAnnotation])

  // Exit draw mode before export — Syncfusion only commits finished annotations in None mode
  // (same pattern as the manual Save button / captureAnnotations).
  const flushMeasurementExport = useCallback((vm) => {
    if (!vm) return
    try { vm.annotation.setAnnotationMode('None') } catch (_) {}
    setTimeout(() => {
      exportAndProcessUnsaved(vm)
      setTimeout(ensureContinuousMeasureMode, 80)
    }, 200)
  }, [exportAndProcessUnsaved, ensureContinuousMeasureMode])

  const scheduleMeasurementComplete = useCallback((plainAnnot) => {
    if (!plainAnnot) return
    const id = plainAnnot.annotationId ?? plainAnnot.name ?? plainAnnot.AnnotName
    if (!id) return

    const prev = measureCompleteTimersRef.current.get(id)
    if (prev) clearTimeout(prev)

    const resolveAnnot = () => {
      const live = selectedAnnotDataRef.current
      const liveId = live?.annotationId ?? live?.name ?? live?.AnnotName
      return (live && liveId === id) ? buildPlainAnnot(live) : plainAnnot
    }

    const save = () => {
      measureCompleteTimersRef.current.delete(id)
      processMeasureRef.current?.(resolveAnnot())
      exportAndProcessUnsaved(viewerRef.current)
      // Backup re-enter draw mode (label path also calls ensureContinuousMeasureMode)
      setTimeout(ensureContinuousMeasureMode, 450)
    }

    // Process after draw completes — geometry + Syncfusion calibrate object are ready
    measureCompleteTimersRef.current.set(id, setTimeout(save, 350))
  }, [exportAndProcessUnsaved, ensureContinuousMeasureMode])

  // ── ResizeObserver: give Syncfusion explicit pixel dimensions ──────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 10 && height > 10) {
        setViewerSize({ w: Math.floor(width), h: Math.floor(height) })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Re-import stored annotations ONCE per drawing load ─────────────────
  // CRITICAL: must never re-run when annotations/annotationData change after a line
  // is drawn — mid-session re-import resets Syncfusion scale state and crashes mouseup.
  useEffect(() => {
    if (!docLoaded || !drawing?.id || importCompletedRef.current) return

    const vm = viewerRef.current
    if (!vm) return

    const finishImport = () => {
      importCompletedRef.current = true
      importedDrawingRef.current = drawing.id
      importingAnnotsRef.current = false
      applyCalibrationToViewer(vm)
    }

    // Prefer pointsJson when takeoff rows exist — blob import can break scale UI state
    const usePointsJson = annotations.length > 0

    // Strategy A: stored AnnotationData blob (only when no takeoff rows to reconstruct)
    if (drawing.annotationData && !usePointsJson) {
      try {
        let annotObj = drawing.annotationData
        if (typeof annotObj === 'string') {
          try { annotObj = JSON.parse(annotObj) } catch (_) { annotObj = null }
        }
        if (!annotObj) return

        console.log('[BuildTakeoff] one-time import from AnnotationData blob')
        importingAnnotsRef.current = true
        if (typeof vm.importAnnotation === 'function') {
          vm.importAnnotation(
            typeof drawing.annotationData === 'string'
              ? drawing.annotationData
              : JSON.stringify(drawing.annotationData),
            'Json',
          )
        }
        const pages = annotObj?.pdfAnnotation ?? {}
        Object.values(pages).forEach(pageData => {
          ;['measureShapeAnnotation', 'shapeAnnotation', 'measureAnnotation'].forEach(key => {
            let list = pageData?.[key] ?? []
            if (typeof list === 'string') { try { list = JSON.parse(list) } catch (_) { list = [] } }
            if (!Array.isArray(list)) return
            list.forEach(a => {
              const id = a?.AnnotName ?? a?.annotationId ?? a?.uniqueKey ?? a?.name
              if (id) importedAnnotIdsRef.current.add(id)
            })
          })
        })
      } catch (err) {
        console.error('[BuildTakeoff] AnnotationData import failed:', err)
      }
      setTimeout(finishImport, 50)
      return
    }

    // Strategy B: reconstruct from per-item pointsJson
    if (!annotations.length) return

    const byPage = {}
    annotations.forEach(item => {
      if (!item.pointsJson) return
      try {
        const raw = JSON.parse(item.pointsJson)
        const pageIdx = String(parseInt(raw.page ?? raw.pageIndex ?? '0', 10))

        // Sanitize vertex points — a stored point array can contain a literal `null`
        // entry (e.g. captured mid-draw, before the second click landed). Passing that
        // straight into Syncfusion's renderer/exporter crashes EVERY subsequent render
        // cycle with "Cannot read properties of null (reading 'X')", which corrupts the
        // annotation event pipeline for the whole session (breaks new labels + grid sync).
        const rawPtsSrc = raw.vertexPoints ?? raw.VertexPoints ?? []
        const validPts = (Array.isArray(rawPtsSrc) ? rawPtsSrc : [])
          .filter(p => p && typeof p === 'object'
            && Number.isFinite(Number(p.x ?? p.X)) && Number.isFinite(Number(p.y ?? p.Y)))
          .map(p => ({ x: Number(p.x ?? p.X), y: Number(p.y ?? p.Y) }))

        let pts = validPts
        if (pts.length < 2 && raw.start && raw.end) {
          const parseCoord = (val) => {
            if (typeof val === 'object' && val !== null) return { x: Number(val.x ?? val.X) || 0, y: Number(val.y ?? val.Y) || 0 }
            const parts = String(val).split(',')
            return { x: parseFloat(parts[0]) || 0, y: parseFloat(parts[1]) || 0 }
          }
          pts = [parseCoord(raw.start), parseCoord(raw.end)]
        }

        const hasVertexPoints = pts.length >= 2
        if (!hasVertexPoints) return  // not enough valid geometry — skip this corrupted/degenerate record

        // Skip degenerate near-zero-length artifacts (e.g. a single click with no drag)
        const dxSkip = pts[pts.length - 1].x - pts[0].x
        const dySkip = pts[pts.length - 1].y - pts[0].y
        if (Math.sqrt(dxSkip * dxSkip + dySkip * dySkip) < 0.5) {
          console.log('[BuildTakeoff] skipping degenerate near-zero-length annotation:', raw.annotationId ?? raw.name)
          return
        }

        // Build bounds from the sanitized vertex points
        const boundsFromPts = {
          X: Math.min(pts[0].x, pts[pts.length - 1].x),
          Y: Math.min(pts[0].y, pts[pts.length - 1].y),
          Width: Math.max(Math.abs(pts[pts.length - 1].x - pts[0].x), 1),
          Height: Math.max(Math.abs(pts[pts.length - 1].y - pts[0].y), 1),
        }
        const hasCoordsStr = raw.start && raw.end

        // Syncfusion v33 renderMeasureShapeAnnotations requires capital-case fields
        let importable = {
          ...raw,
          // Capital fields required by the Syncfusion WASM import pipeline
          ShapeAnnotationType: raw.ShapeAnnotationType ?? raw.shapeAnnotationType ?? 'Distance',
          AnnotType:           raw.AnnotType ?? raw.shapeAnnotationType ?? 'shape_measure',
          AnnotName:           raw.AnnotName ?? raw.annotationId ?? raw.name ?? raw.id,
          Author:              raw.Author ?? raw.author ?? 'BuildTakeoff',
          Bounds:              raw.Bounds ?? (raw.bounds ?? boundsFromPts) ?? boundsFromPts,
          // Always rebuild from sanitized `pts` — never trust raw.VertexPoints/vertexPoints
          // directly, they're the fields most likely to carry a stored literal `null` point.
          VertexPoints:        pts.map(p => ({ X: p.x, Y: p.y })),
          vertexPoints:        pts.map(p => ({ x: p.x, y: p.y })),
          StrokeColor:         raw.StrokeColor ?? raw.strokeColor ?? '#3b82f6',
          FillColor:           raw.FillColor ?? raw.fillColor ?? 'rgba(59,130,246,0.12)',
          Opacity:             raw.Opacity ?? raw.opacity ?? 1,
          Thickness:           raw.Thickness ?? raw.thickness ?? 1,
          FontSize:            raw.FontSize ?? raw.fontSize ?? toSyncfusionLabelSize(measureLabelFontSize, pdfScale),
          fontSize:            raw.fontSize ?? raw.FontSize ?? toSyncfusionLabelSize(measureLabelFontSize, pdfScale),
          labelSettings:       raw.labelSettings ?? raw.LabelSettings ?? buildMeasureLabelPatch(measureLabelFontSize, pdfScale, raw.strokeColor ?? '#111827').labelSettings,
          enableShapeLabel:    false,
          labelContent:        '',
          LabelContent:        '',
          Note:                '',
          note:                '',
          label:               '',
          text:                '',
          Calibrate:           raw.Calibrate ?? raw.calibrate ?? {
            Ratio: '1 mm = 1 px', X: [], Distance: [], Area: [], Angle: [], Volume: [], TargetUnitConversion: 1,
          },
          IsPrint: true, State: '', Comments: [],
          // Lowercase aliases (kept for fallback paths)
          name: raw.name ?? raw.annotationId ?? raw.id,
          type: raw.type ?? 'Line',
          IT:   raw.IT ?? 'LineDimension',
          ...(hasCoordsStr ? { start: raw.start, end: raw.end } : {}),
          ...(hasVertexPoints && !hasCoordsStr ? {
            start: `${pts[0].x},${pts[0].y}`,
            end:   `${pts[pts.length - 1].x},${pts[pts.length - 1].y}`,
          } : {}),
        }

        if (!byPage[pageIdx]) byPage[pageIdx] = []
        byPage[pageIdx].push(importable)

        const id = raw.annotationId ?? raw.uniqueKey ?? raw.name
        if (id) importedAnnotIdsRef.current.add(id)
      } catch (_) {}
    })

    if (!Object.keys(byPage).length) {
      importCompletedRef.current = true
      applyCalibrationToViewer(vm)
      return
    }

    const pdfAnnotation = {}
    Object.entries(byPage).forEach(([pageIdx, annots]) => {
      pdfAnnotation[pageIdx] = {
        measureShapeAnnotation: annots,
        shapeAnnotation: [],
      }
    })

    console.log('[BuildTakeoff] one-time import', Object.values(byPage).flat().length, 'annotation(s) from pointsJson')
    importingAnnotsRef.current = true
    try {
      if (typeof vm.importAnnotation === 'function') {
        vm.importAnnotation(JSON.stringify({ pdfAnnotation }), 'Json')
      }
    } catch (err) {
      console.error('[BuildTakeoff] pointsJson import failed:', err)
    }
    setTimeout(finishImport, 50)
  }, [docLoaded, drawing?.id, drawing?.annotationData, annotations.length, applyCalibrationToViewer])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mouse-up fallback: Bluebeam-style auto-save when line draw completes ──
  useEffect(() => {
    const MEASURE_TOOLS = ['line', 'area', 'perimeter', 'calibrate']
    if (!MEASURE_TOOLS.includes(activeTool)) return
    const el = containerRef.current
    if (!el) return

    let mouseUpTimer = null
    const onMouseUp = () => {
      if (importingAnnotsRef.current || editingAnnotRef.current) return
      clearTimeout(mouseUpTimer)
      mouseUpTimer = setTimeout(() => exportAndProcessUnsaved(viewerRef.current), 400)
    }
    el.addEventListener('mouseup', onMouseUp, true)
    return () => {
      clearTimeout(mouseUpTimer)
      el.removeEventListener('mouseup', onMouseUp, true)
    }
  }, [activeTool, exportAndProcessUnsaved])

  // ── Ctrl+scroll wheel zoom ─────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const delta = e.deltaY < 0 ? 0.1 : -0.1
      setPdfScale(s => Math.min(5, Math.max(0.25, +(s + delta).toFixed(2))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setPdfScale])

  // ── Pan drag fallback — Syncfusion native Pan is primary; this handles edge cases ──
  useEffect(() => {
    const outer = containerRef.current
    if (!outer || activeTool !== 'pan') {
      outer?.classList.remove('bt-pan-active')
      outer?.style.removeProperty('cursor')
      return
    }

    const state = panStateRef.current
    outer.classList.add('bt-pan-active')
    outer.style.cursor = 'grab'

    const findScrollEls = () => {
      const els = []
      const vm = viewerRef.current
      const primary = vm?.viewerBase?.viewerContainer
        ?? document.getElementById('sfPdfViewer_viewerContainer')
      if (primary) els.push(primary)

      const viewer = document.getElementById('sfPdfViewer')
      if (viewer) {
        for (const el of viewer.querySelectorAll('div')) {
          if (els.includes(el)) continue
          const cs = window.getComputedStyle(el)
          const scrollableY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll')
            && el.scrollHeight > el.clientHeight + 1
          const scrollableX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflow === 'auto' || cs.overflow === 'scroll')
            && el.scrollWidth > el.clientWidth + 1
          if (scrollableY || scrollableX) els.push(el)
        }
      }
      return els
    }

    const applyScroll = (dx, dy) => {
      const els = state.scrollEls?.length ? state.scrollEls : findScrollEls()
      let moved = false
      for (const el of els) {
        const prevTop = el.scrollTop
        const prevLeft = el.scrollLeft
        el.scrollTop += dy
        el.scrollLeft += dx
        if (el.scrollTop !== prevTop || el.scrollLeft !== prevLeft) moved = true
      }
      if (!moved && els[0]) {
        els[0].dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: false,
          deltaX: dx, deltaY: dy,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          view: window,
        }))
      }
    }

    const onMouseDown = (e) => {
      if (e.button !== 0) return
      if (e.target.closest('button, input, select, a, textarea')) return
      state.scrollEls = findScrollEls()
      state.dragging = true
      state.hasMoved = false
      state.startX = e.clientX
      state.startY = e.clientY
      state.prevX = e.clientX
      state.prevY = e.clientY
      outer.style.cursor = 'grabbing'
    }

    const onMouseMove = (e) => {
      if (!state.dragging) return
      if (!state.hasMoved) {
        if (Math.abs(e.clientX - state.startX) < 3 && Math.abs(e.clientY - state.startY) < 3) return
        state.hasMoved = true
        state.prevX = e.clientX
        state.prevY = e.clientY
        return
      }
      const dx = state.prevX - e.clientX
      const dy = state.prevY - e.clientY
      state.prevX = e.clientX
      state.prevY = e.clientY
      if (dx !== 0 || dy !== 0) applyScroll(dx, dy)
    }

    const onMouseUp = () => {
      if (!state.dragging) return
      state.dragging = false
      state.scrollEls = null
      state.hasMoved = false
      outer.style.cursor = 'grab'
    }

    const viewerRoot = document.getElementById('sfPdfViewer')
    const targets = [outer, viewerRoot].filter(Boolean)
    for (const t of targets) t.addEventListener('mousedown', onMouseDown, { capture: true })
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      state.dragging = false
      state.scrollEls = null
      state.hasMoved = false
      outer.classList.remove('bt-pan-active')
      outer.style.removeProperty('cursor')
      for (const t of targets) t.removeEventListener('mousedown', onMouseDown, { capture: true })
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [activeTool, docLoaded])

  // ── Handle imperative viewer commands (fitPage, selectAnnotation, …) ───
  useEffect(() => {
    const vm = viewerRef.current
    if (!pdfCommand || !vm || !pdfBase64) return
    const type    = typeof pdfCommand === 'string' ? pdfCommand : pdfCommand.type
    const payload = typeof pdfCommand === 'object'  ? pdfCommand : {}
    try {
      if (type === 'fitPage') {
        vm.fitPage('FitPage')
      } else if (type === 'selectAnnotation' && payload.annotationId) {
        explicitGridSelectRef.current = true
        // Must exit Distance drawing mode before selecting so Syncfusion renders
        // the selection handle on the annotation (it stays invisible in drawing mode).
        try { vm.annotation.setAnnotationMode('None') } catch (_) {}
        // Navigate to the annotation's page first if needed
        if (payload.pageNumber && payload.pageNumber !== pdfPage) {
          try { vm.navigation.goToPage(payload.pageNumber) } catch (_) {}
        }
        setTimeout(() => {
          try { vm.annotation.selectAnnotation(payload.annotationId, payload.pageNumber ?? 1) } catch (_) {}
          // Restore draw mode if user is still in a measure tool (keep explicit selection)
          setTimeout(() => {
            const { activeTool: currentTool } = useAppStore.getState()
            const mode = MEASURE_MODES[currentTool] ?? MARKUP_MODES[currentTool]
            if (mode) { try { vm.annotation.setAnnotationMode(mode) } catch (_) {} }
          }, 150)
        }, 80)
      } else if (type === 'deleteAnnotation' && payload.annotationId) {
        processedAnnotsRef.current.delete(payload.annotationId)
        pendingLabelByAnnotRef.current.delete(payload.annotationId)
        if (lastDrawnAnnotRef.current === payload.annotationId) lastDrawnAnnotRef.current = null
        vm.annotation.selectAnnotation(payload.annotationId, payload.pageNumber ?? 1)
        // Small delay to let Syncfusion register the selection before deleting
        setTimeout(() => { try { vm.annotation.deleteAnnotation() } catch (_) {} }, 80)
      } else if (type === 'saveCount') {
        // Save all current-page count markers as one measurement entry
        const pageMarkers = countMarkersRef.current.filter(m => m.page === pdfPage)
        if (pageMarkers.length === 0) {
          toast('No count markers on this page — click the drawing to place markers first')
        } else {
          const { measureCategory: cat, measureColor: color } = useAppStore.getState()
          onMeasureRef.current?.({
            measureType: 'Count',
            count:       pageMarkers.length,
            unit:        drawingRef.current?.calibrationUnit ?? 'Mm',
            pageNumber:  pdfPage,
            annotationId: null,
            rawAnnotation: null,
            pixelLength:  0,
            pixelArea:    0,
            length:       null,
            area:         null,
          })
          setCountMarkers(prev => prev.filter(m => m.page !== pdfPage))
        }
      } else if (type === 'clearAnnotations') {
        measureCompleteTimersRef.current.forEach(t => clearTimeout(t))
        measureCompleteTimersRef.current.clear()

        try { vm.annotation.setAnnotationMode('None') } catch (_) {}
        selectedAnnotDataRef.current = null

        const restoreMode = () => {
          const { activeTool: t } = useAppStore.getState()
          const modeRemap = { line: 'Distance', calibrate: 'Distance', area: 'Area', perimeter: 'Perimeter' }
          const m = modeRemap[t]
          if (m) { try { vm.annotation.setAnnotationMode(m) } catch (_) {} }
        }

        const protectedIds = getProtectedAnnotIds?.() ?? new Set()

        const clearPdfAnnot = (id, pageNum) => {
          if (!id) return
          processedAnnotsRef.current.delete(id)
          pendingLabelByAnnotRef.current.delete(id)
          if (lastDrawnAnnotRef.current === id) lastDrawnAnnotRef.current = null
          setTimeout(() => {
            try { vm.annotation.selectAnnotation(id, pageNum) } catch (_) {}
            setTimeout(() => { try { vm.annotation.deleteAnnotation() } catch (_) {} }, 50)
          }, 80)
        }

        const runClear = async () => {
          const clearedPending = await onClearPending?.()
          if (clearedPending) {
            setTimeout(restoreMode, 200)
            return
          }

          setTimeout(() => {
            const doSelectiveDelete = (rawData) => {
              let data = rawData
              if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = null } }
              if (!data?.pdfAnnotation) { restoreMode(); return }

              const toDelete = []
              Object.entries(data.pdfAnnotation).forEach(([pageIdx, pageData]) => {
                const pageNum = parseInt(pageIdx, 10) + 1
                ;['measureShapeAnnotation', 'shapeAnnotation', 'measureAnnotation'].forEach(key => {
                  let list = pageData?.[key]
                  if (typeof list === 'string') { try { list = JSON.parse(list) } catch { list = [] } }
                  if (!Array.isArray(list)) return
                  list.forEach(anno => {
                    const id = anno?.AnnotName ?? anno?.annotationId ?? anno?.name ?? anno?.id
                    if (!id || protectedIds.has(id)) return
                    toDelete.push({ id, pageNum })
                  })
                })
              })

              const lastId = lastDrawnAnnotRef.current
              const target = (lastId && toDelete.find(t => t.id === lastId))
                ?? (toDelete.length ? toDelete[toDelete.length - 1] : null)

              if (target) {
                clearPdfAnnot(target.id, target.pageNum)
              } else {
                toast('Nothing to clear — draw a line first or select a measurement to remove')
              }

              setTimeout(restoreMode, target ? 200 : 50)
            }

            try {
              const result = vm.exportAnnotationsAsObject?.()
              if (result && typeof result.then === 'function') {
                result.then(doSelectiveDelete).catch(() => { restoreMode() })
              } else if (result) {
                doSelectiveDelete(result)
              } else {
                restoreMode()
              }
            } catch (_) { restoreMode() }
          }, 200)
        }

        runClear()
      } else if (type === 'captureAnnotations') {
        // Step 1: Exit Distance drawing mode NOW so Syncfusion commits any in-progress
        // annotation before we export. Must be synchronous (before the delay).
        try { vm.annotation.setAnnotationMode('None') } catch (_) {}

        // Step 2: Wait for Syncfusion to flush its annotation state, then export.
        // clearPdfCommand() runs immediately below; the timeout closure still holds vm.
        setTimeout(() => {
          try {
            if (typeof vm.exportAnnotationsAsObject !== 'function') {
              toast.error('exportAnnotationsAsObject not available on this viewer version')
              return
            }

            const result = vm.exportAnnotationsAsObject()

            const processExportData = (rawData) => {
              if (!rawData) { toast.error('No annotation data returned by viewer'); return }

              // ── Normalise: Syncfusion sometimes returns a JSON string instead of a
              // parsed object (the Promise resolves to a string, not an object).
              let data = rawData
              if (typeof data === 'string') {
                try { data = JSON.parse(data) } catch (_) {
                  toast.error('Could not parse viewer export — try drawing again')
                  return
                }
              }

              console.log('[BuildTakeoff] export (parsed):', JSON.stringify(data).substring(0, 800))

              const flatAnnotations = []

              // Helper: push any annotation-like object into flatAnnotations,
              // parsing JSON strings along the way.
              const pushAnno = (item) => {
                let a = item
                if (typeof a === 'string') { try { a = JSON.parse(a) } catch (_) { return } }
                if (a && typeof a === 'object' && !Array.isArray(a)) flatAnnotations.push(a)
              }

              if (Array.isArray(data)) {
                // Format A: the export IS the annotation array directly
                data.forEach(pushAnno)
              } else {
                // Format B: { pdfAnnotation: { "0": { shapeAnnotation: "[...]" } } }
                const pages = data?.pdfAnnotation ?? {}
                Object.values(pages).forEach(pageData => {
                  if (Array.isArray(pageData)) {
                    pageData.forEach(pushAnno)
                  } else if (pageData && typeof pageData === 'object') {
                    Object.values(pageData).forEach(typeList => {
                      // typeList may itself be a JSON string or an array
                      let list = typeList
                      if (typeof list === 'string') {
                        try { list = JSON.parse(list) } catch (_) { list = [] }
                      }
                      if (Array.isArray(list)) list.forEach(pushAnno)
                      else pushAnno(list)
                    })
                  }
                })
              }

              if (flatAnnotations.length === 0) {
                toast('Draw a complete line first (click point 1, then click point 2), then Save Lines')
                return
              }

              const before = processedAnnotsRef.current.size
              flatAnnotations.forEach(a => processMeasureAnnotation(a))
              const newlySaved = processedAnnotsRef.current.size - before

              if (newlySaved === 0) {
                toast('No new measurements — lines already saved or not yet complete')
              }

              // Save annotation blob for Drawing.AnnotationData (future use / export).
              // Store as raw JSON string — importAnnotationsFromObject accepts the
              // parsed object directly without needing a base64 round-trip.
              const saveBlobFn = onAnnotationsBlobRef.current
              if (saveBlobFn) {
                try {
                  const jsonStr = typeof rawData === 'string' ? rawData : JSON.stringify(rawData)
                  saveBlobFn(jsonStr)
                } catch (_) {}
              }
            }

            const doProcess = (result) => {
              if (result && typeof result.then === 'function') {
                result.then(processExportData).catch(err => {
                  toast.error('Export failed: ' + (err?.message ?? String(err)))
                })
              } else if (result !== undefined && result !== null) {
                processExportData(result)
              } else {
                toast.error('Viewer export returned no data. Draw a line first.')
              }
            }

            doProcess(result)
          } catch (err) {
            toast.error('Save error: ' + (err?.message ?? String(err)))
          } finally {
            // Restore Distance drawing mode if user is still in Measure or Calibrate tool
            const { activeTool: currentTool } = useAppStore.getState()
            const RESTORE_MAP = {
              line: 'Distance', calibrate: 'Distance',
              area: 'Area', perimeter: 'Perimeter',
              arrow: 'Arrow', rect: 'Square', circle: 'Circle',
              polygon: 'Polygon', text: 'FreeText', line_ann: 'Line',
            }
            const mode = RESTORE_MAP[currentTool]
            if (mode) { try { vm.annotation.setAnnotationMode(mode) } catch (_) {} }
          }
        }, 500)
      }
    } catch (_) { }
    clearPdfCommand()
  }, [pdfCommand, pdfBase64, clearPdfCommand, processMeasureAnnotation])

  // ── Load PDF as base64 whenever drawingUrl changes ─────────────────────
  useEffect(() => {
    if (!drawingUrl) {
      setPdfBase64(null)
      setErrorMsg(null)
      prevUrlRef.current = null
      return
    }
    if (drawingUrl === prevUrlRef.current) return
    prevUrlRef.current = drawingUrl

    setLoading(true)
    setErrorMsg(null)
    setPdfBase64(null)
    setDocLoaded(false)
    importedDrawingRef.current = null
    importCompletedRef.current = false

    fetch(drawingUrl)
      .then(res => {
        if (res.status === 404) throw Object.assign(new Error('Drawing file not found on server. Please re-upload.'), { code: 404 })
        if (res.status === 401) throw Object.assign(new Error('Authentication error — please log in again.'), { code: 401 })
        if (!res.ok)            throw new Error(`Server error (${res.status})`)
        return res.blob()
      })
      .then(blob => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload  = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      }))
      .then(dataUrl => {
        // Keep the full data URL — Syncfusion client-side (WASM) mode detects the
        // 'pdf;base64,' prefix, converts to Uint8Array, and feeds it to pdfium.
        // Stripping the prefix was only needed for the server-side Load endpoint.
        setPdfBase64(dataUrl)
      })
      .catch(err => {
        const msg = err.message || 'Failed to load PDF'
        setErrorMsg(msg)
        toast.error(msg)
      })
      .finally(() => setLoading(false))
  }, [drawingUrl])

  // ── Markup tool → Syncfusion annotation mode map ──────────────────────
  const MARKUP_MODES = {
    arrow:     'Arrow',
    rect:      'Square',
    circle:    'Circle',
    polygon:   'Polygon',
    text:      'FreeText',
    highlight: 'Highlight',
    line_ann:  'Line',
  }
  // ── Sync activeTool → Syncfusion annotation mode ───────────────────────
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm) return
    // Changing tool always leaves any selected annotation — clear our tracking ref
    selectedAnnotDataRef.current = null
    try {
      if (MEASURE_MODES[activeTool]) {
        vm.annotation.setAnnotationMode(MEASURE_MODES[activeTool])
        applyCalibrationToViewer(vm)
      } else if (MARKUP_MODES[activeTool]) {
        vm.annotation.setAnnotationMode(MARKUP_MODES[activeTool])
      } else if (activeTool === 'pan') {
        vm.annotation.setAnnotationMode('None')
        vm.interactionMode = 'Pan'
        try { vm.focusViewerContainer?.() } catch (_) {}
      } else {
        vm.annotation.setAnnotationMode('None')
        vm.interactionMode = 'TextSelection'
      }
    } catch (_) { /* viewer not yet mounted */ }
  }, [activeTool, applyCalibrationToViewer])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync zoom (pdfScale from store → Syncfusion zoomTo) ───────────────
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64) return
    try { vm.zoomTo(Math.round(pdfScale * 100)) } catch (_) { }
  }, [pdfScale, pdfBase64])

  // ── Sync page navigation ───────────────────────────────────────────────
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64) return
    try { vm.navigation.goToPage(pdfPage) } catch (_) { }
  }, [pdfPage, pdfBase64])

  // ── Sync color + thickness + opacity to Syncfusion ──────────────────────
  // Runs whenever any of these change so newly drawn annotations pick up the
  // current settings immediately without requiring a tool switch.
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64) return

    const hex  = measureColor ?? '#EF233C'
    const safeHex = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : '#EF233C'
    const r = parseInt(safeHex.slice(1, 3), 16)
    const g = parseInt(safeHex.slice(3, 5), 16)
    const b = parseInt(safeHex.slice(5, 7), 16)
    const thick   = lineThickness ?? 2
    const opacity = fillOpacity ?? 0.3
    const fillRgba  = `rgba(${r},${g},${b},${opacity})`
    const fillLight = `rgba(${r},${g},${b},${Math.min(opacity, 0.15)})`

    // Build dash array from lineStyle
    const dashMap = { solid: '', dashed: '5 3', dotted: '2 3' }
    const dashArray = dashMap[lineStyle ?? 'solid'] ?? ''

    try {
      applyGlobalMeasureLabelSettings(vm, measureLabelFontSize, pdfScale, safeHex)

      if (activeTool === 'calibrate') {
        vm.annotation.updateMeasurementSettings('Distance', {
          strokeColor: '#f59e0b', fillColor: 'rgba(245,158,11,0.12)', opacity: 1, thickness: thick,
          ...buildMeasureLabelPatch(measureLabelFontSize, pdfScale, '#b45309'),
        })
        return
      }

      // ── Measurement tools ────────────────────────────────
      if (activeTool === 'line') {
        vm.annotation.updateMeasurementSettings('Distance', {
          strokeColor: safeHex, fillColor: fillLight, opacity: 1,
          ...buildLinearDistanceStyle(measureLabelFontSize, pdfScale, safeHex, thick, arrowStyle),
        })
      } else if (activeTool === 'area') {
        try { vm.annotation.updateMeasurementSettings('Area', { strokeColor: safeHex, fillColor: fillRgba, opacity: 1, thickness: thick, ...buildMeasureLabelPatch(measureLabelFontSize, pdfScale, safeHex) }) } catch (_) {}
      } else if (activeTool === 'perimeter') {
        try { vm.annotation.updateMeasurementSettings('Perimeter', { strokeColor: safeHex, fillColor: fillLight, opacity: 1, thickness: thick, ...buildMeasureLabelPatch(measureLabelFontSize, pdfScale, safeHex) }) } catch (_) {}
      }

      // ── Shape / markup tools ─────────────────────────────
      const shapeSettings = {
        strokeColor: safeHex, fillColor: fillRgba, opacity: 1, thickness: thick,
        ...(dashArray ? { borderDashArray: dashArray } : {}),
      }
      if (['rect', 'circle', 'polygon', 'line_ann', 'arrow'].includes(activeTool)) {
        try { vm.annotation.updateAnnotationSettings(shapeSettings) } catch (_) {}
      }
      if (activeTool === 'text') {
        try {
          vm.annotation.updateAnnotationSettings({
            fontColor: safeHex,
            fontSize:  fontSize ?? 14,
            opacity:   1,
          })
        } catch (_) {}
      }

      // ── Update the just-drawn / currently-selected annotation in-place ──
      // Works for both: (a) explicit user click-select and (b) the annotation auto-tracked
      // by handleAnnotationAdd immediately after it is drawn (Bluebeam-style).
      if (selectedAnnotDataRef.current) {
        editingAnnotRef.current = true
        try {
          const current = selectedAnnotDataRef.current
          const updAnnot = {
            ...current,
            strokeColor: safeHex,
            thickness:   thick,
            fillColor:   fillRgba,
            borderDashArray: dashArray,
          }
          // Measurement labels must keep the large font — do NOT apply text-tool fontSize (14pt).
          if (isMeasureAnnotation(current)) {
            const isLine = String(current.shapeAnnotationType ?? '').toLowerCase() === 'distance'
              || current.IT === 'LineDimension' || current.it === 'LineDimension'
            if (isLine && activeTool === 'line') {
              Object.assign(updAnnot, buildLinearDistanceStyle(measureLabelFontSize, pdfScale, safeHex, thick, arrowStyle))
            } else {
              Object.assign(updAnnot, buildMeasureLabelPatch(measureLabelFontSize, pdfScale, safeHex))
            }
          } else if (activeTool === 'text') {
            updAnnot.fontColor = safeHex
            updAnnot.fontSize = fontSize ?? 14
          }
          vm.annotation.editAnnotation(updAnnot)
          selectedAnnotDataRef.current = updAnnot
          if (activeTool === 'line' && isMeasureAnnotation(current)) {
            const isLine = String(current.shapeAnnotationType ?? '').toLowerCase() === 'distance'
              || current.IT === 'LineDimension' || current.it === 'LineDimension'
            if (isLine) {
              const annotId = current.annotationId ?? current.name ?? current.AnnotName
              const linearStyle = buildLinearDistanceStyle(measureLabelFontSize, pdfScale, safeHex, thick, arrowStyle)
              linearStyle.strokeColor = safeHex
              applyLinearVisualStyleToDiagram(vm, annotId, linearStyle)
              const noteText = current.notes ?? current.note ?? current.labelContent
              if (noteText) {
                applyCalibratedLabelToDiagram(
                  vm, annotId, current.pageNumber ?? current.pageIndex + 1, noteText, safeHex,
                  buildLinearLabelDiagramStyle(measureLabelFontSize, pdfScale, safeHex),
                )
              }
            }
          }
        } catch (_) {}
        // Clear the suppression flag after Syncfusion finishes processing the edit event
        setTimeout(() => { editingAnnotRef.current = false }, 300)
      } else if (activeTool === 'line') {
        const targetId = lastDrawnAnnotRef.current
        if (targetId) {
          const linearStyle = buildLinearDistanceStyle(measureLabelFontSize, pdfScale, safeHex, thick, arrowStyle)
          linearStyle.strokeColor = safeHex
          applyLinearVisualStyleToDiagram(vm, targetId, linearStyle)
          const live = resolveLiveAnnotation(vm, targetId)
          const noteText = live?.notes ?? live?.note ?? live?.labelContent
          if (noteText) {
            applyCalibratedLabelToDiagram(
              vm, targetId, (live?.pageIndex ?? 0) + 1, noteText, safeHex,
              buildLinearLabelDiagramStyle(measureLabelFontSize, pdfScale, safeHex),
            )
          }
        }
        ensureContinuousMeasureMode()
      } else if (CONTINUOUS_MEASURE_TOOLS.has(activeTool)) {
        ensureContinuousMeasureMode()
      }

    } catch (_) {}
  }, [activeTool, pdfBase64, measureColor, lineThickness, fillOpacity, lineStyle, fontSize, measureLabelFontSize, pdfScale, arrowStyle, ensureContinuousMeasureMode])

  // ── Apply calibration scale to Syncfusion (display unit in grid is separate) ──
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64) return
    applyCalibrationToViewer(vm)
  }, [drawing?.isCalibrated, drawing?.scaleRatio, drawing?.calibrationUnit, pdfBase64, applyCalibrationToViewer])

  // ── Re-apply label size when user changes preset or zoom (Bluebeam-style) ──
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64 || !docLoaded) return
    applyGlobalMeasureLabelSettings(vm, measureLabelFontSize, pdfScale, measureColor ?? '#111827')
    if (activeTool === 'line') {
      try {
        vm.annotation.updateMeasurementSettings('Distance', {
          strokeColor: measureColor ?? '#EF233C',
          fillColor: `rgba(239,35,60,${Math.min(fillOpacity ?? 0.15, 0.15)})`,
          opacity: 1,
          ...buildLinearDistanceStyle(measureLabelFontSize, pdfScale, measureColor ?? '#111827', lineThickness, arrowStyle),
        })
      } catch (_) {}
    }
    if (selectedAnnotDataRef.current && isMeasureAnnotation(selectedAnnotDataRef.current)) {
      editingAnnotRef.current = true
      try {
        const current = selectedAnnotDataRef.current
        const fontColor = current.strokeColor ?? measureColor ?? '#111827'
        const isLine = String(current.shapeAnnotationType ?? '').toLowerCase() === 'distance'
          || current.IT === 'LineDimension' || current.it === 'LineDimension'
        const patched = patchMeasureAnnotationLabel(
          current, measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle,
        )
        vm.annotation.editAnnotation(patched)
        selectedAnnotDataRef.current = patched
        if (isLine && activeTool === 'line') {
          const annotId = current.annotationId ?? current.name ?? current.AnnotName
          const linearStyle = buildLinearDistanceStyle(measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle)
          linearStyle.strokeColor = fontColor
          applyLinearVisualStyleToDiagram(vm, annotId, linearStyle)
          const noteText = current.notes ?? current.note ?? current.labelContent
          if (noteText) {
            applyCalibratedLabelToDiagram(
              vm, annotId, current.pageNumber ?? (current.pageIndex ?? 0) + 1, noteText, fontColor,
              buildLinearLabelDiagramStyle(measureLabelFontSize, pdfScale, fontColor),
            )
          }
        }
      } catch (_) {}
      setTimeout(() => { editingAnnotRef.current = false }, 300)
    } else if (activeTool === 'line' && lastDrawnAnnotRef.current) {
      const fontColor = measureColor ?? '#111827'
      const linearStyle = buildLinearDistanceStyle(measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle)
      linearStyle.strokeColor = fontColor
      applyLinearVisualStyleToDiagram(vm, lastDrawnAnnotRef.current, linearStyle)
    }
  }, [measureLabelFontSize, pdfScale, pdfBase64, docLoaded, measureColor, lineThickness, arrowStyle, fillOpacity, activeTool])

  // ── Fired by Syncfusion when PDF fully loads ───────────────────────────
  const handleDocumentLoaded = useCallback((args) => {
    setPdfTotalPages(args.pageCount ?? 1)
    setPdfPage(1)
    setDocLoaded(true)
    const vm = viewerRef.current
    if (vm) {
      try { vm.enableShapeLabel = false } catch (_) {}
      applyGlobalMeasureLabelSettings(vm, measureLabelFontSize, pdfScale, measureColor ?? '#111827')
      applyCalibrationToViewer(vm)
    }
  }, [setPdfTotalPages, setPdfPage, measureColor, measureLabelFontSize, pdfScale, applyCalibrationToViewer])

  // ── Fired by Syncfusion on page change ────────────────────────────────
  const handlePageChange = useCallback((args) => {
    setPdfPage(args.currentPageNumber)
  }, [setPdfPage])

  // ── Fired by Syncfusion when an annotation is added ──────────────────────
  const handleAnnotationAdd = useCallback((args) => {
    // When we re-import stored annotations from DB, Syncfusion fires annotationAdd
    // for each one — suppress so we don't create duplicate DB rows.
    if (importingAnnotsRef.current) return

    const eventAnnotations = []
    const single     = args?.annotation
    const collection = args?.annotationCollection
    if (single)                          eventAnnotations.push(single)
    else if (Array.isArray(collection))  collection.forEach(a => eventAnnotations.push(a))
    if (!eventAnnotations.length) return

    // Safe log — args.annotation contains Syncfusion internal circular refs; don't JSON.stringify(args)
    console.log('[BuildTakeoff] annotationAdd fired, count:', eventAnnotations.length,
      'id:', eventAnnotations[0]?.annotationId ?? eventAnnotations[0]?.name ?? '?')

    // ── IMMEDIATE: process event annotations directly — no export/match needed ──
    // Build a PLAIN-DATA object from the event annotation — do NOT spread the full
    // Syncfusion annotation (it contains internal module refs / circular references
    // that cause JSON.stringify to throw a TypeError in autoSave's pointsJson step).
    eventAnnotations.forEach(a => {
      scheduleMeasurementComplete(buildPlainAnnot(a))
    })
    // Do not set selectedAnnotDataRef here — continuous draw keeps the tool active;
    // explicit selection uses handleAnnotationSelect (PDF click or grid row).
  }, [scheduleMeasurementComplete])

  const handleAnnotationPropertiesChange = useCallback((args) => {
    if (importingAnnotsRef.current || editingAnnotRef.current) return
    const a = args?.annotation
    if (!a) return
    scheduleMeasurementComplete(buildPlainAnnot(a))
  }, [scheduleMeasurementComplete])

  const handleAnnotationSelect = useCallback((args) => {
    const annotation = args?.annotation
    const id = annotation?.annotationId
    if (!id) return
    onAnnotationSelect?.(id)
    const { activeTool: tool } = useAppStore.getState()
    if (isMeasureAnnotation(annotation) && !importingAnnotsRef.current) {
      scheduleMeasurementComplete(buildPlainAnnot(annotation))
    }
    // During continuous takeoff, Syncfusion auto-selects the line just drawn — do not
    // track it or color/style changes would target the previous line instead of the next.
    if (!CONTINUOUS_MEASURE_TOOLS.has(tool) || explicitGridSelectRef.current) {
      selectedAnnotDataRef.current = annotation
      explicitGridSelectRef.current = false
    }
  }, [onAnnotationSelect, scheduleMeasurementComplete])

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      style={{ flex: 1, position: 'relative', overflow: 'hidden', height: '100%', width: '100%', background: '#525659' }}
    >
      {/* Hide all Syncfusion annotation UI — toolbar, freetext panel, comment panel.
          These DOM elements MUST remain in the DOM (just hidden) so Syncfusion's internal
          code can access their classList without throwing. */}
      <style>{`
        /* ── Annotation UI (must stay in DOM so Syncfusion's classList access doesn't throw) ── */
        #sfPdfViewer .e-pv-annotation-toolbar,
        #sfPdfViewer .e-pv-annotation-toolbar-container,
        #sfPdfViewer_annotation_toolbar,
        .e-pv-annotation-toolbar,
        .e-pv-free-text-annotation-popup,
        .e-pv-text-annotation-popup,
        .e-pv-annotation-popup,
        .e-pv-comment-panel { display: none !important; }

        /* ── Left sidebar toolbar (thumbnail / bookmark / text-search icons) ──────────
             Syncfusion renders this even when enableThumbnail and enableBookmark are
             false.  Hide it and collapse its width so the viewer content fills 100%.  */
        #sfPdfViewer_sideBarToolbar,
        #sfPdfViewer .e-pv-sidebar-toolbar,
        #sfPdfViewer .e-pv-sidebar-toolbar-splitter { display: none !important; width: 0 !important; }

        /* ── Sidebar content panel (should already be empty but hide just in case) ── */
        #sfPdfViewer_sideBarPanel,
        #sfPdfViewer .e-pv-sidebar-panel { display: none !important; width: 0 !important; }

        /* ── Expand the viewer content to fill the full width left by the sidebar ── */
        #sfPdfViewer_viewerContainer,
        #sfPdfViewer .e-pv-viewer-container { left: 0 !important; width: 100% !important; }

        /* Pan mode — grab cursor + let drag reach the scroll container */
        .bt-pan-active #sfPdfViewer,
        .bt-pan-active #sfPdfViewer_viewerContainer,
        .bt-pan-active #sfPdfViewer .e-pv-viewer-container { cursor: grab !important; }

        /* Remove stray modal overlays that block PDF interaction */
        #sfPdfViewer .e-dlg-overlay,
        #sfPdfViewer .e-overlay,
        .e-dlg-overlay.e-fade { display: none !important; pointer-events: none !important; }
        .bt-pan-active #sfPdfViewer_viewerContainer { touch-action: none; }
      `}</style>

      {/* Loading overlay */}
      {loading && (
        <div style={{ position:'absolute', inset:0, zIndex:20,
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          background:'#0a0f1e', gap:'12px' }}>
          <svg className="spin" width="28" height="28" viewBox="0 0 24 24"
            fill="none" stroke="#1d6fdb" strokeWidth="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
          <span style={{ fontSize:'13px', color:'#64748b' }}>Loading drawing…</span>
        </div>
      )}

      {/* Error overlay */}
      {errorMsg && !loading && (
        <div style={{ position:'absolute', inset:0, zIndex:10,
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          background:'#0a0f1e', gap:'16px', padding:'32px' }}>
          <div style={{ width:'48px', height:'48px', borderRadius:'12px',
            background:'rgba(239,68,68,.1)', border:'1px solid rgba(239,68,68,.2)',
            display:'flex', alignItems:'center', justifyContent:'center' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <div style={{ textAlign:'center' }}>
            <p style={{ fontSize:'14px', fontWeight:600, color:'#f1f5f9', marginBottom:'6px' }}>
              Could not load drawing
            </p>
            <p style={{ fontSize:'12px', color:'#64748b', maxWidth:'320px', lineHeight:1.6 }}>
              {errorMsg}
            </p>
          </div>
          <div style={{ padding:'10px 16px', borderRadius:'8px',
            background:'rgba(245,158,11,.08)', border:'1px solid rgba(245,158,11,.2)',
            fontSize:'11px', color:'#f59e0b', textAlign:'center', maxWidth:'340px', lineHeight:1.5 }}>
            Make sure the backend is running on <strong>port 5000</strong>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!drawingUrl && !loading && (
        <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column',
          alignItems:'center', justifyContent:'center', gap:'16px', background:'#0a0f1e' }}>
          <div style={{ width:'64px', height:'64px', borderRadius:'16px',
            background:'rgba(29,111,219,.08)', border:'1px solid rgba(29,111,219,.15)',
            display:'flex', alignItems:'center', justifyContent:'center' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1e3a5f" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          </div>
          <div style={{ textAlign:'center' }}>
            <p style={{ fontSize:'14px', fontWeight:600, color:'#334155', marginBottom:'4px' }}>
              No drawing selected
            </p>
            <p style={{ fontSize:'12px', color:'#1e3a5f' }}>
              Upload a PDF drawing or select one from the sidebar
            </p>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:'6px', alignItems:'center',
            background:'rgba(255,255,255,.02)', border:'1px solid #1e293b',
            borderRadius:'10px', padding:'14px 20px' }}>
            <Step n="1" text="Upload PDF from the left sidebar" />
            <Step n="2" text="Calibrate the drawing scale" />
            <Step n="3" text="Draw measurements with the Measure tool" />
            <Step n="4" text="Export your takeoff report" />
          </div>
        </div>
      )}

      {/* Uncalibrated banner — shown when drawing loaded, measure tool active, no calibration */}
      {pdfBase64 && !loading && activeTool === 'line' && !drawing?.isCalibrated && (
        <div style={{ position:'absolute', top:'12px', left:'50%', transform:'translateX(-50%)',
          zIndex:15, display:'flex', alignItems:'center', gap:'6px',
          background:'rgba(17,24,39,.92)', border:'1px solid rgba(245,158,11,.4)',
          color:'#fbbf24', fontSize:'11px', fontWeight:600,
          padding:'6px 14px', borderRadius:'20px', pointerEvents:'none', whiteSpace:'nowrap',
          backdropFilter:'blur(4px)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Scale not calibrated — lengths will not be accurate
        </div>
      )}

      {/* Calibrate-mode drawing hint */}
      {pdfBase64 && !loading && activeTool === 'calibrate' && (
        <div style={{ position:'absolute', top:'12px', left:'50%', transform:'translateX(-50%)',
          zIndex:15, display:'flex', alignItems:'center', gap:'6px',
          background:'rgba(17,24,39,.92)', border:'1px solid rgba(245,158,11,.4)',
          color:'#fbbf24', fontSize:'11px', fontWeight:600,
          padding:'6px 14px', borderRadius:'20px', pointerEvents:'none', whiteSpace:'nowrap',
          backdropFilter:'blur(4px)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="4"/>
            <path d="M3 12h3m12 0h3M12 3v3m0 12v3"/>
          </svg>
          Click start point → click end point on a known dimension
        </div>
      )}

      {/* Markup tool hints */}
      {pdfBase64 && !loading && ['rect','circle','arrow','polygon','text','line_ann'].includes(activeTool) && (
        <div style={{ position:'absolute', top:'12px', left:'50%', transform:'translateX(-50%)',
          zIndex:15, display:'flex', alignItems:'center', gap:'6px',
          background:'rgba(17,24,39,.92)', border:'1px solid rgba(139,92,246,.4)',
          color:'#a78bfa', fontSize:'11px', fontWeight:600,
          padding:'6px 14px', borderRadius:'20px', pointerEvents:'none', whiteSpace:'nowrap',
          backdropFilter:'blur(4px)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
          {activeTool === 'text'     ? 'Click on the drawing to add a text label'
           : activeTool === 'arrow'  ? 'Click and drag to draw an arrow'
           : activeTool === 'rect'   ? 'Click and drag to draw a rectangle'
           : activeTool === 'circle' ? 'Click and drag to draw a circle'
           : activeTool === 'polygon'? 'Click vertices → Double-click to close shape'
           : 'Click and drag to draw a line annotation'}
        </div>
      )}

      {/* Area-mode hint */}
      {pdfBase64 && !loading && activeTool === 'area' && (
        <div style={{ position:'absolute', top:'12px', left:'50%', transform:'translateX(-50%)',
          zIndex:15, display:'flex', alignItems:'center', gap:'6px',
          background:'rgba(17,24,39,.92)', border:'1px solid rgba(34,197,94,.4)',
          color:'#4ade80', fontSize:'11px', fontWeight:600,
          padding:'6px 14px', borderRadius:'20px', pointerEvents:'none', whiteSpace:'nowrap',
          backdropFilter:'blur(4px)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
          </svg>
          Click to place polygon vertices → Double-click to close area
        </div>
      )}

      {/* Perimeter-mode hint */}
      {pdfBase64 && !loading && activeTool === 'perimeter' && (
        <div style={{ position:'absolute', top:'12px', left:'50%', transform:'translateX(-50%)',
          zIndex:15, display:'flex', alignItems:'center', gap:'6px',
          background:'rgba(17,24,39,.92)', border:'1px solid rgba(139,92,246,.4)',
          color:'#a78bfa', fontSize:'11px', fontWeight:600,
          padding:'6px 14px', borderRadius:'20px', pointerEvents:'none', whiteSpace:'nowrap',
          backdropFilter:'blur(4px)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
          </svg>
          Click polygon vertices → Double-click to close perimeter
        </div>
      )}

      {/* ── Count tool overlay — transparent click target with numbered markers ── */}
      {pdfBase64 && !loading && activeTool === 'count' && (
        <div
          style={{ position: 'absolute', inset: 0, zIndex: 12, cursor: 'crosshair' }}
          onClick={(e) => {
            const rect = containerRef.current?.getBoundingClientRect()
            if (!rect) return
            const xPct = (e.clientX - rect.left)  / rect.width
            const yPct = (e.clientY - rect.top)   / rect.height
            const newMarker = { id: Date.now(), xPct, yPct, page: pdfPage }
            setCountMarkers(prev => [...prev, newMarker])
          }}
        >
          {/* Render numbered markers for current page */}
          {countMarkers
            .filter(m => m.page === pdfPage)
            .map((marker, idx) => (
              <div
                key={marker.id}
                style={{
                  position: 'absolute',
                  left: `${marker.xPct * 100}%`,
                  top:  `${marker.yPct * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  width: '22px', height: '22px',
                  borderRadius: '50%',
                  background: measureColor ?? '#f59e0b',
                  color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '10px', fontWeight: 800,
                  border: '2px solid rgba(255,255,255,0.85)',
                  boxShadow: '0 1px 6px rgba(0,0,0,0.5)',
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              >
                {idx + 1}
              </div>
            ))
          }
          {/* Count mode banner */}
          <div style={{
            position: 'absolute', bottom: '16px', left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(17,24,39,.92)', border: '1px solid rgba(245,158,11,.4)',
            color: '#f59e0b', fontSize: '11px', fontWeight: 600,
            padding: '5px 14px', borderRadius: '20px', whiteSpace: 'nowrap',
            backdropFilter: 'blur(4px)', pointerEvents: 'none',
          }}>
            Click to place count markers · {countMarkers.filter(m => m.page === pdfPage).length} placed · Save Count when done
          </div>
        </div>
      )}

      {/* Pan-mode hint banner */}
      {pdfBase64 && !loading && activeTool === 'pan' && (
        <div style={{
          position: 'absolute', top: '12px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 15, display: 'flex', alignItems: 'center', gap: '6px',
          background: 'rgba(17,24,39,.92)', border: '1px solid rgba(99,179,237,.4)',
          color: '#90cdf4', fontSize: '11px', fontWeight: 600,
          padding: '6px 14px', borderRadius: '20px', pointerEvents: 'none', whiteSpace: 'nowrap',
          backdropFilter: 'blur(4px)',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v0M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/>
            <path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8 2 2 0 1 1 4 0"/>
          </svg>
          Hold and drag to pan the drawing
        </div>
      )}

      {/* Syncfusion PDF Viewer — only mount once we know the container size. */}
      {pdfBase64 && !errorMsg && viewerSize.h > 0 && (
        <PdfViewerComponent
          id="sfPdfViewer"
          ref={viewerRef}
          documentPath={pdfBase64}
          resourceUrl={SF_RESOURCE_URL}
          style={{
            height: `${viewerSize.h}px`,
            width:  `${viewerSize.w}px`,
            display: 'block',
          }}

          /* ── Toolbar: hide Syncfusion's own toolbar — we use our custom Toolbar ──
               NOTE: do NOT set annotationToolbarItems:[] — empty array causes Syncfusion
               to crash with "Cannot read classList of undefined" on second annotation click,
               which prevents annotationAdd from firing. Hide via CSS instead (see <style> above). */
          toolbarSettings={{
            showTooltip: false,
            toolbarItems: [],
          }}

          /* ── Annotation types ────────────────────────────────────────────────
               IMPORTANT: enableFreeText MUST stay true even though we never use it.
               Syncfusion v33 always calls enableFreeTextAnnotationPropertiesTools()
               on every mouse-up to hide the freetext panel. If the panel DOM elements
               don't exist (because enableFreeText=false) it throws "Cannot read classList
               of undefined" which crashes the call stack BEFORE annotationAdd fires.
               We hide the freetext UI via CSS below so users never see it. */
          enableMeasureAnnotation={true}
          enableShapeLabel={false}
          enableFreeText={true}
          enableShapeAnnotation={true}
          enableTextMarkupAnnotation={false}
          enableStampAnnotations={false}
          enableStickyNotesAnnotation={false}
          enableHandwrittenSignature={false}
          enableCommentPanel={false}
          enableBookmark={false}
          enableThumbnail={false}
          enablePrint={false}
          enableDownload={false}

          /* ── Measurement units + initial appearance ──────────────────────── */
          distanceSettings={{
            displayUnit:    drawing?.calibrationUnit ? toSfUnit(drawing.calibrationUnit) : 'Millimeter',
            conversionUnit: drawing?.calibrationUnit ? toSfUnit(drawing.calibrationUnit) : 'Millimeter',
            ...(drawing?.isCalibrated && drawing?.scaleRatio ? {
              depth: drawing.scaleRatio,
              scaleRatio: 1,
            } : {}),
            strokeColor: measureColor ?? '#EF233C',
            fillColor:   `rgba(239,35,60,${fillOpacity ?? 0.15})`,
            opacity: 1,
            ...buildLinearDistanceStyle(
              measureLabelFontSize, pdfScale, measureColor ?? '#111827', lineThickness, arrowStyle,
            ),
          }}

          /* ── Annotation appearance ────────────────────────────────────────── */
          annotationSettings={{
            author: 'BuildTakeoff',
            isLock: false,
          }}

          /* ── Events ──────────────────────────────────────────────────────── */
          documentLoad={handleDocumentLoaded}
          pageChange={handlePageChange}
          annotationAdd={handleAnnotationAdd}
          annotationPropertiesChange={handleAnnotationPropertiesChange}
          annotationSelect={handleAnnotationSelect}
        >
          <Inject services={[
            Toolbar, Magnification, Navigation,
            LinkAnnotation, BookmarkView, ThumbnailView,
            Print, TextSelection, TextSearch,
            Annotation,
          ]} />
        </PdfViewerComponent>
      )}
    </div>
  )
}
