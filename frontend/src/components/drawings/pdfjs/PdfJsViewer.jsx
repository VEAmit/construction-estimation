import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'
import { useAppStore } from '../../../store/useAppStore'
import PdfJsPage, { clearDocumentBitmaps } from './PdfJsPage'
import { normalizeAnnotations } from './pdfGeometryAdapter'
import './pdfJsViewer.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = `${window.location.origin}/pdf.worker.min.mjs`

const RANGE_CHUNK_SIZE = 1024 * 1024
const PAGE_GAP = 12
// Tools where left-drag on empty canvas should pan instead of requiring the
// dedicated Pan tool. 'line'/'calibrate' (and any future draw tool) keep
// left-click reserved for drawing, so they're excluded and still pan via
// middle-click only. Clicks that land ON an annotation shape never reach this
// handler in the first place — AnnotationShape's own pointerdown already
// calls stopPropagation() before this bubbles up — so enabling this for
// 'select' can't hijack the existing click-to-select/drag-to-move behavior.
const PAN_TOOLS = new Set(['select', 'pan'])

function clampScale(value) {
  return Math.min(5, Math.max(0.2, Number(value) || 1))
}

async function loadPageMetrics(pdfDocument, onMetric, isCancelled) {
  const batchSize = 8
  for (let start = 1; start <= pdfDocument.numPages; start += batchSize) {
    if (isCancelled()) return
    const end = Math.min(pdfDocument.numPages, start + batchSize - 1)
    await Promise.all(Array.from({ length: end - start + 1 }, async (_, index) => {
      const pageNumber = start + index
      const page = await pdfDocument.getPage(pageNumber)
      if (isCancelled()) return
      const viewport = page.getViewport({ scale: 1 })
      onMetric(pageNumber, {
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
      })
    }))
  }
}

function commandAnnotationIds(command) {
  if (!command || typeof command !== 'object') return []
  return Array.from(new Set([
    command.annotationId,
    ...(command.annotationIds ?? []),
    ...(command.ids ?? []),
  ].filter(Boolean).map(String)))
}

export default function PdfJsViewer({
  drawingUrl,
  annotations = [],
  selectedAnnotationId,
  onMeasure,
  onAnnotationSelect,
  onAnnotationContextMenu,
  onClearSelection,
  onMeasurementGeometryChange,
  measureReleaseRef,
}) {
  const containerRef = useRef(null)
  const loadingTaskRef = useRef(null)
  const visibilityRef = useRef(new Map())
  const programmaticPageRef = useRef(null)
  const panRef = useRef(null)
  const initialFitAppliedRef = useRef(false)
  const zoomAnchorRef = useRef(null)
  const visibilityCommitRef = useRef(null)
  const previousToolRef = useRef(null)

  const {
    activeTool,
    pdfScale,
    pdfPage,
    pdfCommand,
    wheelZoomSensitivity,
    spaceHeld,
    setPdfScale,
    setPdfPage,
    setPdfTotalPages,
    clearPdfCommand,
    setSpaceHeld,
  } = useAppStore()

  const [pdfDocument, setPdfDocument] = useState(null)
  const [pageMetrics, setPageMetrics] = useState({})
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [pasteClipboard, setPasteClipboard] = useState(null)
  const [hiddenAnnotationIds, setHiddenAnnotationIds] = useState(() => new Set())
  const [optimisticGeometry, setOptimisticGeometry] = useState({})
  const [pendingAnnotations, setPendingAnnotations] = useState([])

  useEffect(() => {
    if (previousToolRef.current == null) {
      previousToolRef.current = activeTool
      return
    }
    if (previousToolRef.current === activeTool) return
    previousToolRef.current = activeTool
    setPasteClipboard(null)
  }, [activeTool])

  const updateMetric = useCallback((pageNumber, metric) => {
    setPageMetrics((current) => {
      const existing = current[pageNumber]
      if (existing
        && existing.width === metric.width
        && existing.height === metric.height
        && existing.rotation === metric.rotation) return current
      return { ...current, [pageNumber]: metric }
    })
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setContainerSize({ width, height })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ── Held-Space pan override ─────────────────────────────────────────────
  // Line/Calibrate draw on left-drag. Right after upload, Calibrate is
  // auto-armed to prompt setting the scale — a plain left-drag meant only to
  // reposition the view (e.g. to find a labelled dimension before drawing)
  // would otherwise be captured as the draw gesture and commit a stray line
  // plus the calibration popup. Holding Space lets that same drag pan
  // instead, whatever tool is active. Ignored while typing in an input so
  // Space still works normally there.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (e.target?.closest?.('button, input, select, a, textarea, [contenteditable="true"]')) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const onKeyUp = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      setSpaceHeld(false)
    }
    // Safety net: if the window/tab loses focus while Space is physically
    // still held (alt-tab, a dialog stealing focus, dragging outside the
    // window, DevTools grabbing focus, …), no keyup ever fires — force
    // release on any focus loss so a stuck key can't survive it.
    const onBlur = () => setSpaceHeld(false)
    const onVisibilityChange = () => { if (document.hidden) setSpaceHeld(false) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      setSpaceHeld(false)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [setSpaceHeld])

  useEffect(() => {
    if (!drawingUrl) return undefined

    let cancelled = false
    setLoading(true)
    setError(null)
    setPdfDocument(null)
    setPageMetrics({})
    setPasteClipboard(null)
    setHiddenAnnotationIds(new Set())
    setOptimisticGeometry({})
    setPendingAnnotations([])
    initialFitAppliedRef.current = false
    visibilityRef.current.clear()

    const loadingTask = pdfjsLib.getDocument({
      url: drawingUrl,
      disableRange: false,
      disableStream: false,
      disableAutoFetch: true,
      rangeChunkSize: RANGE_CHUNK_SIZE,
      verbosity: pdfjsLib.VerbosityLevel.ERRORS,
    })
    loadingTaskRef.current = loadingTask

    loadingTask.promise.then(async (documentProxy) => {
      if (cancelled) {
        await documentProxy.destroy()
        return
      }
      setPdfDocument(documentProxy)
      setPdfTotalPages(documentProxy.numPages)
      setPdfPage(1)
      setLoading(false)
      loadPageMetrics(documentProxy, updateMetric, () => cancelled).catch((metricError) => {
        if (!cancelled) console.warn('[PDF.js] Page metric scan was interrupted', metricError)
      })
    }).catch((loadError) => {
      if (cancelled) return
      console.error('[PDF.js] Failed to load document', loadError)
      setError(loadError?.message || 'Unable to load this PDF')
      setLoading(false)
    })

    return () => {
      cancelled = true
      loadingTaskRef.current = null
      loadingTask.destroy().catch(() => {})
      clearDocumentBitmaps(drawingUrl)
    }
  }, [drawingUrl, setPdfPage, setPdfTotalPages, updateMetric])

  const firstMetric = pageMetrics[1]

  const fitWidth = useCallback(() => {
    if (!firstMetric || !containerSize.width) return
    setPdfScale(clampScale(Math.max(1, containerSize.width - 32) / firstMetric.width))
  }, [containerSize.width, firstMetric, setPdfScale])

  const fitPage = useCallback(() => {
    if (!firstMetric || !containerSize.width || !containerSize.height) return
    const widthScale = Math.max(1, containerSize.width - 32) / firstMetric.width
    const heightScale = Math.max(1, containerSize.height - 24) / firstMetric.height
    setPdfScale(clampScale(Math.min(widthScale, heightScale)))
  }, [containerSize, firstMetric, setPdfScale])

  useEffect(() => {
    if (!firstMetric || !containerSize.width || initialFitAppliedRef.current) return
    initialFitAppliedRef.current = true
    fitWidth()
  }, [containerSize.width, firstMetric, fitWidth])

  useEffect(() => {
    if (!pdfCommand) return
    const type = typeof pdfCommand === 'string' ? pdfCommand : pdfCommand.type
    if (type === 'fitPage') fitPage()
    else if (type === 'fitWidth') fitWidth()
    else if (type === 'selectAnnotation') {
      const pageNumber = Number(pdfCommand.pageNumber)
      if (Number.isFinite(pageNumber) && pageNumber > 0) setPdfPage(pageNumber)
    }
    else if (type === 'pasteMeasurement') setPasteClipboard(pdfCommand.clipboard ?? null)
    else if (type === 'cancelPastePlacement') setPasteClipboard(null)
    else if (type === 'deleteAnnotation' || type === 'deleteAnnotations') {
      const ids = commandAnnotationIds(pdfCommand)
      setHiddenAnnotationIds(current => new Set([...current, ...ids]))
      onClearSelection?.()
    }
    clearPdfCommand()
  }, [clearPdfCommand, fitPage, fitWidth, onClearSelection, pdfCommand, setPdfPage])

  useEffect(() => {
    if (!measureReleaseRef) return undefined
    measureReleaseRef.current = (annotationId) => {
      setPendingAnnotations(current => current.filter(annotation => annotation.id !== String(annotationId)))
    }
    return () => { measureReleaseRef.current = null }
  }, [measureReleaseRef])

  useEffect(() => {
    const persistedIds = new Set(normalizeAnnotations(annotations, pageMetrics).map(annotation => annotation.id))
    setPendingAnnotations(current => current.filter(annotation => !persistedIds.has(annotation.id)))
  }, [annotations, pageMetrics])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !pdfDocument || programmaticPageRef.current === pdfPage) return
    const page = container.querySelector(`[data-page-number="${pdfPage}"]`)
    if (!page) return
    programmaticPageRef.current = pdfPage
    page.scrollIntoView({ block: 'start', behavior: 'smooth' })
    window.setTimeout(() => { programmaticPageRef.current = null }, 350)
  }, [pdfDocument, pdfPage])

  useEffect(() => {
    const anchor = zoomAnchorRef.current
    const container = containerRef.current
    if (!anchor || !container) return
    requestAnimationFrame(() => {
      const ratio = pdfScale / anchor.scale
      container.scrollLeft = (anchor.scrollLeft + anchor.x) * ratio - anchor.x
      container.scrollTop = (anchor.scrollTop + anchor.y) * ratio - anchor.y
      zoomAnchorRef.current = null
    })
  }, [pdfScale])

  const handleVisibility = useCallback((pageNumber, ratio) => {
    visibilityRef.current.set(pageNumber, ratio)
    if (programmaticPageRef.current != null) return
    // Fast-scrolling a long document fires an IntersectionObserver tick per
    // page per threshold crossing — many per second. Committing pdfPage
    // synchronously on every tick recomputes forceRender for every page on
    // every tick, thrashing PdfJsPage's render effect (start-then-immediately
    // -cancel pdfium jobs) well beyond what's needed to know which page the
    // user settled on — this is the main contributor to "scrolling fast
    // feels stuck." Coalesce into one commit shortly after ticks stop.
    if (visibilityCommitRef.current) clearTimeout(visibilityCommitRef.current)
    visibilityCommitRef.current = setTimeout(() => {
      visibilityCommitRef.current = null
      let visiblePage = null
      let visibleRatio = 0
      visibilityRef.current.forEach((candidateRatio, candidatePage) => {
        if (candidateRatio > visibleRatio) {
          visiblePage = candidatePage
          visibleRatio = candidateRatio
        }
      })
      if (visiblePage != null && visiblePage !== useAppStore.getState().pdfPage) setPdfPage(visiblePage)
    }, 120)
  }, [setPdfPage])

  useEffect(() => () => {
    if (visibilityCommitRef.current) clearTimeout(visibilityCommitRef.current)
  }, [])

  const normalizedAnnotations = useMemo(() => {
    const saved = normalizeAnnotations(annotations, pageMetrics)
      .filter(annotation => !hiddenAnnotationIds.has(annotation.id))
      .map(annotation => optimisticGeometry[annotation.id]
        ? { ...annotation, points: optimisticGeometry[annotation.id].points, raw: optimisticGeometry[annotation.id].raw }
        : annotation)
    return [...saved, ...pendingAnnotations.filter(annotation => !hiddenAnnotationIds.has(annotation.id))]
  }, [annotations, hiddenAnnotationIds, optimisticGeometry, pageMetrics, pendingAnnotations])

  const handleMeasure = useCallback(async (measurement, options) => {
    const raw = measurement?.rawAnnotation
    let pendingId = null
    if (raw) {
      const previewItem = {
        id: measurement.annotationId,
        itemType: measurement.measureType,
        mark: measurement.memberMark ?? measurement.drawingMark ?? '',
        length: measurement.length,
        unit: measurement.unit,
        color: raw.strokeColor ?? raw.StrokeColor,
        pointsJson: raw,
      }
      const normalized = normalizeAnnotations([previewItem], pageMetrics)
      if (normalized[0]) {
        pendingId = normalized[0].id
        setPendingAnnotations(current => [...current.filter(a => a.id !== normalized[0].id), normalized[0]])
      }
    }

    try {
      const result = await onMeasure?.(measurement, options)
      if (result === false && pendingId) {
        setPendingAnnotations(current => current.filter(annotation => annotation.id !== pendingId))
      }
      return result
    } catch (error) {
      if (pendingId) {
        setPendingAnnotations(current => current.filter(annotation => annotation.id !== pendingId))
      }
      throw error
    }
  }, [onMeasure, pageMetrics])

  const handleGeometryChange = useCallback((payload) => {
    const id = String(payload.annotationId)
    const normalized = normalizeAnnotations([{
      id: payload.dbId,
      itemType: 'Line',
      pointsJson: payload.rawAnnotation,
    }], pageMetrics)[0]
    if (normalized) {
      setOptimisticGeometry(current => ({
        ...current,
        [id]: { points: normalized.points, raw: payload.rawAnnotation },
      }))
    }
    onMeasurementGeometryChange?.(payload)
  }, [onMeasurementGeometryChange, pageMetrics])

  const pages = useMemo(() => pdfDocument
    ? Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1)
    : [], [pdfDocument])

  const handlePointerDown = useCallback((event) => {
    // Held-Space always pans, regardless of tool — see spaceHeld's store comment.
    const canPan = spaceHeld
      || (PAN_TOOLS.has(activeTool) ? event.button === 0 : event.button === 1)
    if (!canPan) return
    const container = containerRef.current
    if (!container) return
    event.preventDefault()
    container.setPointerCapture?.(event.pointerId)
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: container.scrollLeft,
      top: container.scrollTop,
    }
  }, [activeTool, spaceHeld])

  const handlePointerMove = useCallback((event) => {
    const pan = panRef.current
    const container = containerRef.current
    if (!pan || !container || pan.pointerId !== event.pointerId) return
    container.scrollLeft = pan.left - (event.clientX - pan.x)
    container.scrollTop = pan.top - (event.clientY - pan.y)
  }, [])

  const endPan = useCallback((event) => {
    if (panRef.current?.pointerId !== event.pointerId) return
    containerRef.current?.releasePointerCapture?.(event.pointerId)
    panRef.current = null
  }, [])

  const handleWheel = useCallback((event) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    zoomAnchorRef.current = {
      scale: pdfScale,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }
    const direction = event.deltaY < 0 ? 1 : -1
    const factor = 1 + direction * 0.1 * (wheelZoomSensitivity ?? 1)
    setPdfScale(clampScale(pdfScale * factor))
  }, [pdfScale, setPdfScale, wheelZoomSensitivity])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  return (
    <div
      ref={containerRef}
      className={`pdfjs-viewer ${activeTool === 'pan' || spaceHeld ? 'is-pan-mode' : ''} ${pasteClipboard ? 'is-paste-mode' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        if (pasteClipboard) setPasteClipboard(null)
        onClearSelection?.()
      }}
      tabIndex={0}
    >
      {loading && <div className="pdfjs-document-status">Preparing drawing...</div>}
      {error && <div className="pdfjs-document-error">{error}</div>}
      {pasteClipboard && (
        <div className="pdfjs-paste-hint">
          <span>Move preview and click to place copies. Esc or Done finishes.</span>
          <button type="button" className="pdfjs-paste-done" onClick={() => setPasteClipboard(null)}>
            Done
          </button>
        </div>
      )}
      {pdfDocument && (
        <div className="pdfjs-page-stack" style={{ gap: PAGE_GAP }}>
          {pages.map((pageNumber) => (
            <PdfJsPage
              key={pageNumber}
              pdfDocument={pdfDocument}
              documentKey={drawingUrl}
              pageNumber={pageNumber}
              scale={clampScale(pdfScale)}
              root={containerRef.current}
              initialSize={pageMetrics[pageNumber] ?? firstMetric}
              onMetric={updateMetric}
              onVisibility={handleVisibility}
              forceRender={Math.abs(pageNumber - pdfPage) <= 2}
              annotations={normalizedAnnotations.filter(annotation => annotation.pageNumber === pageNumber)}
              selectedAnnotationId={selectedAnnotationId}
              pasteClipboard={pasteClipboard}
              onMeasure={handleMeasure}
              onSelect={onAnnotationSelect}
              onContextMenu={onAnnotationContextMenu}
              onClearSelection={onClearSelection}
              onGeometryChange={handleGeometryChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}
