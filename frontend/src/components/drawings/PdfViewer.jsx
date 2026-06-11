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
import { pixelsToReal, polygonArea, polylineLength, ptDist, pixelsAreaToReal, computePixelPerimeter } from '../../utils/calculations'
import toast from 'react-hot-toast'

// Syncfusion pdfium WASM files live in /public/ej2-pdfviewer-lib (copied by the Vite plugin).
// Must be an absolute URL: the pdfium worker is created from a blob: URL, so importScripts
// inside it needs a fully-qualified origin to avoid blob-origin resolution issues.
// Not setting serviceUrl switches the viewer to client-side WASM rendering — no backend needed.
const SF_RESOURCE_URL = `${window.location.origin}/ej2-pdfviewer-lib`

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
    startX:    0,   // initial mousedown position — used for drag threshold
    startY:    0,
    hasMoved:  false,
    scrollEl:  null, // the actual scrollable DOM element, cached on mousedown
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
  useEffect(() => { drawingRef.current           = drawing          }, [drawing])
  useEffect(() => { onMeasureRef.current         = onMeasure        }, [onMeasure])
  useEffect(() => { onAnnotationsBlobRef.current = onAnnotationsBlob }, [onAnnotationsBlob])

  // Track which annotation IDs we've already sent to onMeasure (session-only)
  const processedAnnotsRef = useRef(new Set())

  // Used to suppress re-saving when we re-import stored annotations from DB
  const importingAnnotsRef  = useRef(false)
  // Track which drawing ID we've already imported for (import once per drawing load)
  const importedDrawingRef  = useRef(null)

  // ── Shared helper: extract measurement + call onMeasure ──────────────────
  const processMeasureAnnotation = useCallback((anno) => {
    let a = anno
    if (typeof a === 'string') { try { a = JSON.parse(a) } catch (_) { return } }
    if (!a || typeof a !== 'object') return

    console.log('[BuildTakeoff] processMeasureAnnotation:', JSON.stringify(a).substring(0, 600))

    const annotationId = a.annotationId ?? a.AnnotationId ?? a.AnnotName ?? a.name ?? a.id ?? null
    if (annotationId && processedAnnotsRef.current.has(annotationId)) return

    const d = drawingRef.current

    // ── Detect annotation type ──────────────────────────────────────────────
    const IT = a.IT ?? a.it ?? ''
    const shapeType = (a.shapeAnnotationType ?? a.ShapeAnnotationType ?? a.type ?? '').toLowerCase()
    const isAreaAnnotation     = IT === 'PolyLineDimension' || shapeType === 'polygon' || IT === 'Area'
    const isPerimeterAnnotation = IT === 'Perimeter'

    // ── Extract vertex points (common to both area and line) ────────────────
    let rawPts = a.vertexPoints ?? a.VertexPoints ?? []
    if (typeof rawPts === 'string') { try { rawPts = JSON.parse(rawPts) } catch (_) { rawPts = [] } }
    if (!Array.isArray(rawPts)) rawPts = []
    const pts = rawPts.map(p => ({ x: p.x ?? p.X ?? 0, y: p.y ?? p.Y ?? 0 }))

    let length    = null
    let pixelLength = 0
    let area      = null
    let pixelArea = 0

    if (isAreaAnnotation && pts.length >= 3) {
      // ── Area annotation: Shoelace for area, perimeter as pixelLength ───────
      pixelArea   = polygonArea(pts)
      pixelLength = computePixelPerimeter(pts)  // use perimeter as the "pixel distance"
      if (d?.isCalibrated && d?.scaleRatio && pixelArea > 0) {
        area   = pixelsAreaToReal(pixelArea, d.scaleRatio, d.calibrationUnit)
        length = pixelsToReal(pixelLength, d.scaleRatio, d.calibrationUnit)  // perimeter length
      }
    } else {
      // ── Line / Distance annotation (existing logic) ─────────────────────────

      // Strategy 1: "start" / "end" strings from Syncfusion export
      if (a.start && a.end) {
        const parseCoord = (val) => {
          if (typeof val === 'object' && val !== null) return { x: val.x ?? val.X ?? 0, y: val.y ?? val.Y ?? 0 }
          const parts = String(val).split(',')
          return { x: parseFloat(parts[0]) || 0, y: parseFloat(parts[1]) || 0 }
        }
        const p1 = parseCoord(a.start)
        const p2 = parseCoord(a.end)
        const pdfDist = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2)
        if (pdfDist >= 1) {
          pixelLength = pdfDist
          if (d?.isCalibrated && d?.scaleRatio) {
            length = pixelsToReal(pdfDist, d.scaleRatio, d.calibrationUnit)
          }
        }
      }

      // Strategy 2: Syncfusion's pre-computed measurementValue
      if (length == null) {
        const sfVal = a.measurementValue ?? a.MeasurementValue
        if (sfVal != null && Number(sfVal) > 0) length = Number(sfVal)
      }

      // Strategy 3: vertex points distance
      if (length == null && pts.length >= 2) {
        const p0 = pts[0], pn = pts[pts.length - 1]
        const px = Math.sqrt((pn.x - p0.x) ** 2 + (pn.y - p0.y) ** 2)
        if (px >= 1) {
          pixelLength = px
          if (d?.isCalibrated && d?.scaleRatio) length = pixelsToReal(px, d.scaleRatio, d.calibrationUnit)
        }
      }
    }

    // Guard: need measurable pixel value
    if (pixelLength < 1 && pixelArea < 1) return
    // Guard: calibrated but no real value computed
    if (d?.isCalibrated && isAreaAnnotation && (!area || area <= 0)) return
    if (d?.isCalibrated && !isAreaAnnotation && (!length || length <= 0)) return

    if (annotationId) processedAnnotsRef.current.add(annotationId)

    onMeasureRef.current?.({
      length,
      area,
      pixelLength,
      pixelArea,
      unit:        d?.calibrationUnit ?? 'Mm',
      points:      [],
      annotationId,
      pageNumber:  a.pageNumber ?? a.PageNumber ?? (parseInt(a.page ?? '0') + 1),
      rawAnnotation: a,
      measureType: isAreaAnnotation ? 'Area' : isPerimeterAnnotation ? 'Perimeter' : 'Line',
    })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Re-import stored annotations from DB after Syncfusion document load ──
  //
  // Root cause of persistence failure: Syncfusion v33.2.x exports Distance
  // measurement annotations under the "shapeAnnotation" key (not "measureAnnotation"),
  // in the raw event format { type:"Line", IT:"LineDimension", start:"x,y", end:"x,y", name:"uuid" }.
  // importAnnotationsFromObject() accepts the same format — we just pass the stored
  // pointsJson annotations directly under shapeAnnotation without any reconstruction.
  useEffect(() => {
    if (!docLoaded || !drawing?.id) return
    if (importedDrawingRef.current === drawing.id) return

    const vm = viewerRef.current
    if (!vm) return

    // ── Strategy A: use stored AnnotationData blob (most reliable) ──────────
    // AnnotationData is the exact JSON string returned by exportAnnotationsAsObject.
    // Passing it to importAnnotation with format 'Json' routes through importAnnotationsAsJson
    // which recognises measureShapeAnnotation and calls the correct WASM-side import.
    if (drawing.annotationData) {
      importedDrawingRef.current = drawing.id

      const timer = setTimeout(() => {
        try {
          let annotObj = drawing.annotationData
          if (typeof annotObj === 'string') {
            try { annotObj = JSON.parse(annotObj) } catch (_) { annotObj = null }
          }
          if (!annotObj) return

          console.log('[BuildTakeoff] re-importing from AnnotationData blob')
          importingAnnotsRef.current = true
          // importAnnotation (singular) is the correct Syncfusion v33.2.x API.
          // Passing the raw JSON string with format 'Json' routes through importAnnotationsAsJson
          // which recognises the pdfAnnotation structure and calls the correct WASM import path.
          if (typeof vm.importAnnotation === 'function') {
            vm.importAnnotation(
              typeof drawing.annotationData === 'string'
                ? drawing.annotationData
                : JSON.stringify(drawing.annotationData),
              'Json'
            )
          }

          // Pre-populate processedAnnotsRef so "Save Lines" doesn't duplicate saved rows
          const pages = annotObj?.pdfAnnotation ?? {}
          Object.values(pages).forEach(pageData => {
            ;['measureShapeAnnotation', 'shapeAnnotation', 'measureAnnotation'].forEach(key => {
              let list = pageData?.[key] ?? []
              if (typeof list === 'string') { try { list = JSON.parse(list) } catch (_) { list = [] } }
              if (!Array.isArray(list)) return
              list.forEach(a => {
                const id = a?.AnnotName ?? a?.annotationId ?? a?.uniqueKey ?? a?.name
                if (id) processedAnnotsRef.current.add(id)
              })
            })
          })
        } catch (err) {
          console.error('[BuildTakeoff] AnnotationData import failed:', err)
        }
        setTimeout(() => { importingAnnotsRef.current = false }, 2000)
      }, 600)

      return () => clearTimeout(timer)
    }

    // ── Strategy B: reconstruct from per-item pointsJson (no blob saved yet) ─
    // Handles drawings that were measured without ever clicking "Save Lines",
    // and legacy DB items stored in Syncfusion event format (vertexPoints only).
    if (!annotations.length) return   // DB query still in flight — will re-fire

    const byPage = {}
    annotations.forEach(item => {
      if (!item.pointsJson) return
      try {
        const raw = JSON.parse(item.pointsJson)
        const pageIdx = String(parseInt(raw.page ?? raw.pageIndex ?? '0', 10))

        // Map event-format annotation to the capitalized format renderMeasureShapeAnnotations expects
        const pts = (raw.vertexPoints ?? raw.VertexPoints ?? [])
          .map(p => ({ x: p.x ?? p.X ?? 0, y: p.y ?? p.Y ?? 0 }))
        const hasVertexPoints = pts.length >= 2
        const hasCoordsStr = raw.start && raw.end

        const hasCoords = hasCoordsStr || hasVertexPoints
        if (!hasCoords) return

        // Build bounds from vertex points when not already provided
        const boundsFromPts = hasVertexPoints ? {
          X: Math.min(pts[0].x, pts[pts.length - 1].x),
          Y: Math.min(pts[0].y, pts[pts.length - 1].y),
          Width: Math.max(Math.abs(pts[pts.length - 1].x - pts[0].x), 1),
          Height: Math.max(Math.abs(pts[pts.length - 1].y - pts[0].y), 1),
        } : null

        // Syncfusion v33 renderMeasureShapeAnnotations requires capital-case fields
        let importable = {
          ...raw,
          // Capital fields required by the Syncfusion WASM import pipeline
          ShapeAnnotationType: raw.ShapeAnnotationType ?? raw.shapeAnnotationType ?? 'Distance',
          AnnotType:           raw.AnnotType ?? raw.shapeAnnotationType ?? 'shape_measure',
          AnnotName:           raw.AnnotName ?? raw.annotationId ?? raw.name ?? raw.id,
          Author:              raw.Author ?? raw.author ?? 'BuildTakeoff',
          Bounds:              raw.Bounds ?? (raw.bounds ?? boundsFromPts),
          VertexPoints:        raw.VertexPoints ?? pts.map(p => ({ X: p.x, Y: p.y })),
          StrokeColor:         raw.StrokeColor ?? raw.strokeColor ?? '#3b82f6',
          FillColor:           raw.FillColor ?? raw.fillColor ?? 'rgba(59,130,246,0.12)',
          Opacity:             raw.Opacity ?? raw.opacity ?? 1,
          Thickness:           raw.Thickness ?? raw.thickness ?? 1,
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
        if (id) processedAnnotsRef.current.add(id)
      } catch (_) {}
    })

    if (!Object.keys(byPage).length) return

    // Don't lock importedDrawingRef before the timer — if annotationData arrives
    // while we wait, we want the effect to re-fire and Strategy A to take over.
    const capturedDrawingId = drawing.id

    const timer = setTimeout(() => {
      // If annotationData arrived while we were waiting, abort — Strategy A will run
      if (drawingRef.current?.annotationData) return
      // Guard against duplicate executions
      if (importedDrawingRef.current === capturedDrawingId) return
      importedDrawingRef.current = capturedDrawingId

      // v33.2.x: measureShapeAnnotation is the key for Distance annotations.
      // Two keys are required (>1) to satisfy importAnnotation's object-path condition.
      const pdfAnnotation = {}
      Object.entries(byPage).forEach(([pageIdx, annots]) => {
        pdfAnnotation[pageIdx] = {
          measureShapeAnnotation: annots,  // correct key for Distance/measure annotations
          shapeAnnotation: [],             // needed: importAnnotation requires >1 key to use direct object path
        }
      })

      console.log('[BuildTakeoff] re-importing', Object.values(byPage).flat().length, 'annotation(s) from pointsJson')

      importingAnnotsRef.current = true
      try {
        if (typeof vm.importAnnotation === 'function') {
          vm.importAnnotation(JSON.stringify({ pdfAnnotation }), 'Json')
        }
      } catch (err) {
        console.error('[BuildTakeoff] pointsJson import failed:', err)
      }
      setTimeout(() => { importingAnnotsRef.current = false }, 2000)
    }, 600)

    return () => clearTimeout(timer)
  }, [docLoaded, drawing?.id, drawing?.annotationData, annotations])  // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Custom pan/drag — smooth Bluebeam-style click-and-drag scrolling ──────
  //
  // Scroll element discovery:
  //   Use window.getComputedStyle to find the first div inside #sfPdfViewer
  //   whose CSS overflow is auto/scroll.  This is version-agnostic and works
  //   regardless of the ID, class, or internal structure Syncfusion generates.
  //
  // Two scroll strategies (exclusive — no double-scroll):
  //   1. scrollTop += / scrollLeft +=  (synchronous, proportional to mouse delta)
  //   2. Synthetic WheelEvent  (fallback — only dispatched when Strategy 1 produces
  //      zero scroll movement, e.g. virtual-scroll implementations)
  //
  // Drag threshold (5 px):
  //   Prevents a plain click from triggering any scroll (eliminates the "image
  //   jumping up and down on click" caused by 1-2 px of natural mouse jitter).
  useEffect(() => {
    const outer = containerRef.current
    if (!outer) return

    if (activeTool !== 'pan') {
      outer.style.removeProperty('cursor')
      return
    }

    const state = panStateRef.current

    // Find Syncfusion's scroll container via computed overflow — works across all
    // Syncfusion versions regardless of internal ID / class naming conventions.
    const findScrollEl = () => {
      // Priority 1: Syncfusion exposes its scroll element as viewerBase.viewerContainer
      const vm = viewerRef.current
      const vbEl = vm?.viewerBase?.viewerContainer
      if (vbEl) return vbEl

      // Priority 2: walk divs inside the Syncfusion root, pick first with overflow scroll/auto
      const viewer = document.getElementById('sfPdfViewer')
      if (viewer) {
        for (const el of viewer.querySelectorAll('div')) {
          const cs = window.getComputedStyle(el)
          if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' ||
              cs.overflow  === 'auto' || cs.overflow  === 'scroll') {
            return el
          }
        }
      }
      return null
    }

    const THRESHOLD = 5  // px of total movement before any scroll fires

    const onMouseDown = (e) => {
      if (e.button !== 0) return
      if (e.target.closest('button, input, select, a, textarea')) return

      e.preventDefault()
      e.stopPropagation()   // block Syncfusion annotation/text-selection on this drag

      state.scrollEl = findScrollEl()
      state.dragging = true
      state.hasMoved = false
      state.startX   = e.clientX
      state.startY   = e.clientY
      state.prevX    = e.clientX
      state.prevY    = e.clientY
      outer.style.cursor = 'grabbing'
    }

    const onMouseMove = (e) => {
      if (!state.dragging) return

      // Hold off until mouse has moved ≥ THRESHOLD px from the original click position.
      // This absorbs 1-2 px of natural mouse jitter on click-release without any drag.
      if (!state.hasMoved) {
        if (Math.abs(e.clientX - state.startX) < THRESHOLD &&
            Math.abs(e.clientY - state.startY) < THRESHOLD) return
        state.hasMoved = true
        // Re-anchor prevX/Y so the first scroll delta is small and smooth
        state.prevX = e.clientX
        state.prevY = e.clientY
        return
      }

      const dx = state.prevX - e.clientX   // + = panned left  → content scrolls right
      const dy = state.prevY - e.clientY   // + = panned up    → content scrolls down
      state.prevX = e.clientX
      state.prevY = e.clientY
      if (dx === 0 && dy === 0) return

      const el = state.scrollEl
      if (!el) return

      // ── Strategy 1: direct DOM scroll (synchronous, 1:1 with mouse movement) ──
      const prevTop  = el.scrollTop
      const prevLeft = el.scrollLeft
      el.scrollTop  += dy
      el.scrollLeft += dx
      if (el.scrollTop !== prevTop || el.scrollLeft !== prevLeft) return  // ✓ worked

      // ── Strategy 2: synthetic WheelEvent ───────────────────────────────────────
      // Reached only when Strategy 1 had no effect (virtual-scroll mode).
      // Dispatch pixel-mode event so scroll amount matches mouse delta 1:1.
      el.dispatchEvent(new WheelEvent('wheel', {
        bubbles:    true,
        cancelable: false,
        deltaX:     dx,
        deltaY:     dy,
        deltaMode:  WheelEvent.DOM_DELTA_PIXEL,
        view:       window,
      }))
    }

    const onMouseUp = () => {
      if (!state.dragging) return
      state.dragging = false
      state.scrollEl = null
      state.hasMoved = false
      outer.style.cursor = 'grab'
    }

    outer.style.cursor = 'grab'
    // capture:true — fires before any Syncfusion child, immune to z-index stacking
    outer.addEventListener('mousedown', onMouseDown, { capture: true })
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup',   onMouseUp)

    return () => {
      state.dragging = false
      state.scrollEl = null
      state.hasMoved = false
      outer.style.removeProperty('cursor')
      outer.removeEventListener('mousedown', onMouseDown, { capture: true })
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup',   onMouseUp)
    }
  }, [activeTool])

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
        // Must exit Distance drawing mode before selecting so Syncfusion renders
        // the selection handle on the annotation (it stays invisible in drawing mode).
        try { vm.annotation.setAnnotationMode('None') } catch (_) {}
        // Navigate to the annotation's page first if needed
        if (payload.pageNumber && payload.pageNumber !== pdfPage) {
          try { vm.navigation.goToPage(payload.pageNumber) } catch (_) {}
        }
        setTimeout(() => {
          try { vm.annotation.selectAnnotation(payload.annotationId, payload.pageNumber ?? 1) } catch (_) {}
          // Restore Distance mode if user is still in Measure or Calibrate tool
          setTimeout(() => {
            const { activeTool: currentTool } = useAppStore.getState()
            const RESTORE_MAP = {
              line: 'Distance', calibrate: 'Distance',
              area: 'Area', perimeter: 'Perimeter',
              arrow: 'Arrow', rect: 'Square', circle: 'Circle',
              polygon: 'Polygon', text: 'FreeText', line_ann: 'Line',
            }
            const mode = RESTORE_MAP[currentTool]
            if (mode) { try { vm.annotation.setAnnotationMode(mode) } catch (_) {} }
          }, 150)
        }, 80)
      } else if (type === 'deleteAnnotation' && payload.annotationId) {
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
        // Cancel any in-progress rubber-band drawing
        try { vm.annotation.setAnnotationMode('None') } catch (_) {}
        // Clear our selection tracking so style changes don't update a stale annotation
        selectedAnnotDataRef.current = null

        // Helper: restore the drawing mode for the current active tool
        const restoreMode = () => {
          const { activeTool: t } = useAppStore.getState()
          const modeRemap = { line: 'Distance', calibrate: 'Distance', area: 'Area', perimeter: 'Perimeter' }
          const m = modeRemap[t]
          if (m) { try { vm.annotation.setAnnotationMode(m) } catch (_) {} }
        }

        // Small delay: let setAnnotationMode('None') settle before we export.
        // This ensures the in-progress rubber-band is fully cancelled first.
        setTimeout(() => {
          // Export to discover which annotations exist, then delete ONLY the ones
          // that are NOT in processedAnnotsRef (i.e. not yet saved to the database).
          // Saved annotations (those loaded from DB or auto-saved this session) remain visible.
          const doSelectiveDelete = (rawData) => {
            let data = rawData
            if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = null } }
            if (!data?.pdfAnnotation) { restoreMode(); return }

            const savedIds = processedAnnotsRef.current  // Set of DB-saved annotation IDs
            const toDelete = []

            Object.entries(data.pdfAnnotation).forEach(([pageIdx, pageData]) => {
              const pageNum = parseInt(pageIdx) + 1
              ;['measureShapeAnnotation', 'shapeAnnotation', 'measureAnnotation'].forEach(key => {
                let list = pageData?.[key]
                if (typeof list === 'string') { try { list = JSON.parse(list) } catch { list = [] } }
                if (!Array.isArray(list)) return
                list.forEach(anno => {
                  const id = anno?.AnnotName ?? anno?.annotationId ?? anno?.name
                  if (!id || savedIds.has(id)) return  // skip saved ones
                  toDelete.push({ id, pageNum })
                })
              })
            })

            // Pre-mark as processed so any pending 350ms annotationAdd timer doesn't
            // re-save the line to the DB after we've deleted it from the viewer.
            toDelete.forEach(({ id }) => processedAnnotsRef.current.add(id))

            toDelete.forEach(({ id, pageNum }, i) => {
              setTimeout(() => {
                try { vm.annotation.selectAnnotation(id, pageNum) } catch (_) {}
                setTimeout(() => { try { vm.annotation.deleteAnnotation() } catch (_) {} }, 50)
              }, i * 100)
            })

            // Always restore drawing mode after deletions complete (even if nothing deleted)
            const restoreDelay = toDelete.length > 0 ? toDelete.length * 100 + 150 : 50
            setTimeout(restoreMode, restoreDelay)
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
        }, 100)
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
    setDocLoaded(false)               // gates annotation import until new doc is fully loaded
    importedDrawingRef.current = null  // reset so the new drawing gets re-imported

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
  const MEASURE_MODES = { line: 'Distance', calibrate: 'Distance', area: 'Area', perimeter: 'Perimeter' }

  // ── Sync activeTool → Syncfusion annotation mode ───────────────────────
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm) return
    // Changing tool always leaves any selected annotation — clear our tracking ref
    selectedAnnotDataRef.current = null
    try {
      if (MEASURE_MODES[activeTool]) {
        vm.annotation.setAnnotationMode(MEASURE_MODES[activeTool])
      } else if (MARKUP_MODES[activeTool]) {
        vm.annotation.setAnnotationMode(MARKUP_MODES[activeTool])
      } else if (activeTool === 'pan') {
        vm.annotation.setAnnotationMode('None')
        vm.interactionMode = 'TextSelection'  // neutral mode — custom drag handles pan via capture events
      } else {
        vm.annotation.setAnnotationMode('None')
        vm.interactionMode = 'TextSelection'
      }
    } catch (_) { /* viewer not yet mounted */ }
  }, [activeTool])  // eslint-disable-line react-hooks/exhaustive-deps

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
      if (activeTool === 'calibrate') {
        vm.annotation.updateMeasurementSettings('Distance', {
          strokeColor: '#f59e0b', fillColor: 'rgba(245,158,11,0.12)', opacity: 1, thickness: thick,
          fontSize: 48, fontColor: '#b45309',
        })
        return
      }

      // ── Measurement tools ────────────────────────────────
      if (activeTool === 'line') {
        vm.annotation.updateMeasurementSettings('Distance', {
          strokeColor: safeHex, fillColor: fillLight, opacity: 1, thickness: thick,
          fontSize: 48, fontColor: safeHex,
        })
      } else if (activeTool === 'area') {
        try { vm.annotation.updateMeasurementSettings('Area', { strokeColor: safeHex, fillColor: fillRgba, opacity: 1, thickness: thick, fontSize: 48, fontColor: safeHex }) } catch (_) {}
      } else if (activeTool === 'perimeter') {
        try { vm.annotation.updateMeasurementSettings('Perimeter', { strokeColor: safeHex, fillColor: fillLight, opacity: 1, thickness: thick, fontSize: 48, fontColor: safeHex }) } catch (_) {}
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
          const updAnnot = {
            ...selectedAnnotDataRef.current,
            strokeColor: safeHex,
            thickness:   thick,
            fillColor:   fillRgba,
            borderDashArray: dashArray,
            // FreeText annotations use fontColor/fontSize — safe to pass for all types
            fontColor:   safeHex,
            fontSize:    fontSize ?? 14,
          }
          vm.annotation.editAnnotation(updAnnot)
          // Keep the ref in sync with the new property values
          selectedAnnotDataRef.current = updAnnot
        } catch (_) {}
        // Clear the suppression flag after Syncfusion finishes processing the edit event
        setTimeout(() => { editingAnnotRef.current = false }, 300)
        // Fall through to mode re-enter below so the NEW thickness also applies to
        // the next annotation the user draws (not just the one just updated).
      }

      // Re-enter the annotation mode so Syncfusion applies the new settings to
      // the next annotation drawn — fixes thickness/color not updating on change.
      const modeMap = {
        line: 'Distance', calibrate: 'Distance', area: 'Area', perimeter: 'Perimeter',
        arrow: 'Arrow', rect: 'Square', circle: 'Circle', polygon: 'Polygon',
        text: 'FreeText', line_ann: 'Line',
      }
      const modeKey = modeMap[activeTool]
      if (modeKey) {
        setTimeout(() => {
          try { vm.annotation.setAnnotationMode(modeKey) } catch (_) {}
          // Mode re-enter deselects — clear our annotation tracking ref
          selectedAnnotDataRef.current = null
        }, 20)
      }
    } catch (_) {}
  }, [activeTool, pdfBase64, measureColor, lineThickness, fillOpacity, lineStyle, fontSize])

  // ── Apply calibration scale when drawing is calibrated ────────────────
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !drawing?.isCalibrated || !drawing?.scaleRatio) return
    try {
      const sfUnit = toSfUnit(drawing.calibrationUnit)
      vm.annotation.updateMeasurementSettings('Distance', {
        displayUnit: sfUnit,
        conversionUnit: sfUnit,
        depth: drawing.scaleRatio,
      })
    } catch (_) { }
  }, [drawing?.isCalibrated, drawing?.scaleRatio, drawing?.calibrationUnit, pdfBase64])

  // ── Fired by Syncfusion when PDF fully loads ───────────────────────────
  const handleDocumentLoaded = useCallback((args) => {
    setPdfTotalPages(args.pageCount ?? 1)
    setPdfPage(1)
    setDocLoaded(true)  // annotation API is now safe to call
  }, [setPdfTotalPages, setPdfPage])

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
      const pts = (a.vertexPoints ?? a.VertexPoints ?? [])
        .map(p => ({ x: p.x ?? p.X ?? 0, y: p.y ?? p.Y ?? 0 }))
      const annotId = a.annotationId ?? a.name ?? a.id

      const plainAnnot = {
        annotationId:        annotId,
        name:                annotId,
        type:                a.type  ?? 'Line',
        IT:                  a.IT ?? a.it ?? 'LineDimension',
        shapeAnnotationType: a.shapeAnnotationType ?? 'Distance',
        pageNumber:          a.pageNumber ?? 1,
        page:                String((a.pageNumber ?? 1) - 1),
        strokeColor:         a.strokeColor  ?? '#EF233C',
        fillColor:           a.fillColor    ?? 'rgba(239,35,60,0.15)',
        thickness:           a.thickness    ?? 2,
        opacity:             a.opacity      ?? 1,
        measurementValue:    a.measurementValue ?? a.MeasurementValue,
        vertexPoints:        pts,
        ...(pts.length >= 2 ? {
          start: `${pts[0].x},${pts[0].y}`,
          end:   `${pts[pts.length - 1].x},${pts[pts.length - 1].y}`,
        } : {}),
      }
      processMeasureAnnotation(plainAnnot)
    })

    // Keep raw event annotation ref for editAnnotation (Syncfusion API requires it)
    if (eventAnnotations[0]) selectedAnnotDataRef.current = eventAnnotations[0]

    // ── DEFERRED 500ms: font-size update + annotation-blob persistence ──────────
    // editAnnotation must wait for Syncfusion to finalise the annotation render.
    // exportAnnotationsAsObject gives the canonical blob for future re-import.
    setTimeout(() => {
      const vm = viewerRef.current
      if (!vm) return

      // Bump the label font size on the just-drawn annotation.
      // CRITICAL: Syncfusion v33.2.x reads annotation.labelSettings.fontSize BEFORE
      // checking annotation.fontSize.  If labelSettings.fontSize is the default (14),
      // it overrides any top-level fontSize we pass, making the font-size check a no-op.
      // Fix: always mirror fontSize inside labelSettings so both paths use the large value.
      const eventAnnot = eventAnnotations[0]
      if (eventAnnot) {
        editingAnnotRef.current = true
        try {
          vm.annotation.editAnnotation({
            ...eventAnnot,
            fontSize:        48,
            fontColor:       '#111827',
            labelFillColor:  'rgba(255,255,255,0.88)',
            labelBorderColor: 'rgba(0,0,0,0.18)',
            labelSettings: {
              ...(eventAnnot.labelSettings ?? {}),
              fontSize:    48,
              fontColor:   '#111827',
              fillColor:   'rgba(255,255,255,0.88)',
              borderColor: 'rgba(0,0,0,0.18)',
            },
          })
        } catch (_) {}
        setTimeout(() => { editingAnnotRef.current = false }, 300)
      }

      // Save full annotation blob so annotations survive page refresh
      try {
        const exportResult = vm.exportAnnotationsAsObject?.()
        const saveBlobFn = onAnnotationsBlobRef.current
        if (!saveBlobFn) return
        const doSave = (rawExport) => {
          if (!rawExport) return
          try {
            const jsonStr = typeof rawExport === 'string' ? rawExport : JSON.stringify(rawExport)
            saveBlobFn(jsonStr)
          } catch (_) {}
        }
        if (exportResult && typeof exportResult.then === 'function') {
          exportResult.then(doSave).catch(() => {})
        } else if (exportResult) {
          doSave(exportResult)
        }
      } catch (_) {}
    }, 500)
  }, [processMeasureAnnotation])

  // ── Fired when annotation properties change (fires even when annotationAdd doesn't) ──
  const handleAnnotationPropertiesChange = useCallback((args) => {
    if (importingAnnotsRef.current) return
    if (editingAnnotRef.current) return
    const a = args?.annotation
    if (!a) return

    // Sanitize to plain data (same reason as handleAnnotationAdd — avoids circular refs)
    const pts = (a.vertexPoints ?? a.VertexPoints ?? [])
      .map(p => ({ x: p.x ?? p.X ?? 0, y: p.y ?? p.Y ?? 0 }))
    const annotId = a.annotationId ?? a.name ?? a.id
    processMeasureAnnotation({
      annotationId:        annotId,
      name:                annotId,
      type:                a.type  ?? 'Line',
      IT:                  a.IT ?? a.it ?? 'LineDimension',
      shapeAnnotationType: a.shapeAnnotationType ?? 'Distance',
      pageNumber:          a.pageNumber ?? 1,
      page:                String((a.pageNumber ?? 1) - 1),
      strokeColor:         a.strokeColor  ?? '#EF233C',
      fillColor:           a.fillColor    ?? 'rgba(239,35,60,0.15)',
      thickness:           a.thickness    ?? 2,
      opacity:             a.opacity      ?? 1,
      measurementValue:    a.measurementValue ?? a.MeasurementValue,
      vertexPoints:        pts,
      ...(pts.length >= 2 ? {
        start: `${pts[0].x},${pts[0].y}`,
        end:   `${pts[pts.length - 1].x},${pts[pts.length - 1].y}`,
      } : {}),
    })
  }, [processMeasureAnnotation])

  // ── Fired when an annotation is selected on the viewer ────────────────
  const handleAnnotationSelect = useCallback((args) => {
    const annotation = args?.annotation
    const id = annotation?.annotationId
    if (id) {
      onAnnotationSelect?.(id)
      // Store the full annotation object so the style sync effect can call editAnnotation
      selectedAnnotDataRef.current = annotation
    }
  }, [onAnnotationSelect])

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
            strokeColor: measureColor ?? '#EF233C',
            fillColor:   `rgba(239,35,60,${fillOpacity ?? 0.15})`,
            opacity: 1,
            thickness: lineThickness ?? 2,
            fontSize: 48,
            fontColor: '#111827',
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
