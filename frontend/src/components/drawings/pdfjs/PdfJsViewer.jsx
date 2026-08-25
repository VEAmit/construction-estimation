import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import 'pdfjs-dist/web/pdf_viewer.css'
import { useAppStore } from '../../../store/useAppStore'
import PdfJsPage, { clearDocumentBitmaps } from './PdfJsPage'
import { normalizeAnnotations } from './pdfGeometryAdapter'
import './pdfJsViewer.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = `${window.location.origin}/pdf.worker.min.mjs`

const RANGE_CHUNK_SIZE = 1024 * 1024
const PAGE_GAP = 12
const PAGE_STACK_PADDING_X = 16
const PAGE_STACK_PADDING_TOP = 8
const FALLBACK_PAGE_WIDTH = 612
const FALLBACK_PAGE_HEIGHT = 792
// How far beyond the visible viewport a page is still kept mounted (and thus
// rendering/pre-rendering), so scrolling into it feels instant rather than
// starting from a blank page. Scales with viewport size on large monitors,
// floored so it's still meaningful on small ones.
const OVERSCAN_MULTIPLIER = 1.5
const MIN_OVERSCAN_PX = 1500
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

function scaledPageLayout(pages, pageMetrics, firstMetric, scale) {
  const clampedScale = clampScale(scale)
  let top = PAGE_STACK_PADDING_TOP
  return pages.map((pageNumber) => {
    const metric = pageMetrics[pageNumber] ?? firstMetric
    const width = Math.max(1, (metric?.width ?? FALLBACK_PAGE_WIDTH) * clampedScale)
    const height = Math.max(1, (metric?.height ?? FALLBACK_PAGE_HEIGHT) * clampedScale)
    const entry = { pageNumber, top, width, height }
    top += height + PAGE_GAP
    return entry
  })
}

function closestPageAt(layout, documentY) {
  let closest = null
  let closestDistance = Number.POSITIVE_INFINITY
  for (const entry of layout) {
    const bottom = entry.top + entry.height
    if (documentY >= entry.top && documentY <= bottom) return entry
    const distance = documentY < entry.top ? entry.top - documentY : documentY - bottom
    if (distance < closestDistance) {
      closest = entry
      closestDistance = distance
    }
  }
  return closest
}

function capturePageZoomAnchor(container, pages, pageMetrics, firstMetric, scale, viewportX, viewportY) {
  const layout = scaledPageLayout(pages, pageMetrics, firstMetric, scale)
  if (!layout.length) return null

  const x = Number.isFinite(viewportX) ? viewportX : container.clientWidth / 2
  const y = Number.isFinite(viewportY) ? viewportY : container.clientHeight / 2
  const page = closestPageAt(layout, container.scrollTop + y)
  if (!page) return null

  const contentWidth = Math.max(
    container.clientWidth,
    Math.max(...layout.map(entry => entry.width)) + PAGE_STACK_PADDING_X * 2,
  )
  const pageLeft = (contentWidth - page.width) / 2

  return {
    pageNumber: page.pageNumber,
    xRatio: Math.min(1, Math.max(0, (container.scrollLeft + x - pageLeft) / page.width)),
    yRatio: Math.min(1, Math.max(0, (container.scrollTop + y - page.top) / page.height)),
    viewportX: x,
    viewportY: y,
  }
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
  selectedAnnotationIds,
  onMeasure,
  onAnnotationSelect,
  onAnnotationContextMenu,
  onClearSelection,
  onMeasurementGeometryChange,
  onMeasurementLabelSizeChange,
  sectionPlacementMode,
  sectionPlacements = [],
  sectionFocus,
  sectionFocuses = [],
  sectionMeasurementColors = [],
  sectionDraftColor,
  sectionEditMode,
  onSectionEditRequest,
  onSectionSelection,
  onSectionPlacement,
  onSectionPlacementContextMenu,
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
  const scrollTrackedPageRef = useRef(null)
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
  const previousPdfScaleRef = useRef(pdfScale)

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
    scrollTrackedPageRef.current = null

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
  // Fit must use whichever page is actually on screen, not always page 1 —
  // a multi-sheet set commonly mixes a portrait cover/index page with wide
  // landscape detail sheets, and fitting a landscape page's width using the
  // cover page's (narrower) dimensions leaves large empty margins on both
  // sides exactly like this. Falls back to page 1's metrics only until the
  // current page's own metrics have loaded.
  const currentPageMetric = pageMetrics[pdfPage] ?? firstMetric

  const fitWidth = useCallback(() => {
    if (!currentPageMetric || !containerSize.width) return
    setPdfScale(clampScale(Math.max(1, containerSize.width - 32) / currentPageMetric.width))
  }, [containerSize.width, currentPageMetric, setPdfScale])

  const fitPage = useCallback(() => {
    if (!currentPageMetric || !containerSize.width || !containerSize.height) return
    const widthScale = Math.max(1, containerSize.width - 32) / currentPageMetric.width
    const heightScale = Math.max(1, containerSize.height - 24) / currentPageMetric.height
    setPdfScale(clampScale(Math.min(widthScale, heightScale)))
  }, [containerSize, currentPageMetric, setPdfScale])

  useEffect(() => {
    if (!firstMetric || !containerSize.width || initialFitAppliedRef.current) return
    initialFitAppliedRef.current = true
    // Initial document fitting is navigation setup, not a user zoom. Keep a
    // newly opened PDF at the top of page 1; subsequent Fit/+/− operations
    // use the normal page-preserving zoom anchor below.
    const initialScale = clampScale(Math.max(1, containerSize.width - 32) / firstMetric.width)
    previousPdfScaleRef.current = initialScale
    setPdfScale(initialScale)
  }, [containerSize.width, firstMetric, setPdfScale])

  useEffect(() => {
    if (!pdfCommand) return
    const type = typeof pdfCommand === 'string' ? pdfCommand : pdfCommand.type
    if (type === 'fitPage') fitPage()
    else if (type === 'fitWidth') fitWidth()
    else if (type === 'selectAnnotation') {
      // Selecting a row jumps to its page AND ends any in-progress paste
      // session in one command — handleRowSelect fires this and
      // cancelPastePlacement in the same tick, and since both go through the
      // same synchronous pdfCommand slot, only the later one would otherwise
      // survive to be seen by this effect. Folding the reset in here means it
      // always takes effect regardless of call order.
      setPasteClipboard(null)
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
    else if (type === 'historyRestored') {
      // The store now contains the authoritative, server-restored snapshot.
      // Clear viewer-only tombstones and optimistic geometry so restored
      // deletions reappear and reverted moves/resizes render immediately.
      setHiddenAnnotationIds(new Set())
      setOptimisticGeometry({})
      setPendingAnnotations([])
      setPasteClipboard(null)
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

    // A current-page change reported by IntersectionObserver already reflects
    // where the user manually scrolled. Do not turn that state update back
    // into scrollIntoView: doing so creates a feedback loop that can snap a
    // long document to an earlier page. Explicit toolbar/grid/section page
    // changes still follow the existing programmatic navigation path below.
    if (scrollTrackedPageRef.current === pdfPage) {
      scrollTrackedPageRef.current = null
      return
    }
    const page = container.querySelector(`[data-page-number="${pdfPage}"]`)
    if (!page) return
    programmaticPageRef.current = pdfPage
    page.scrollIntoView({ block: 'start', behavior: 'smooth' })
    window.setTimeout(() => { programmaticPageRef.current = null }, 350)
  }, [pdfDocument, pdfPage])

  useEffect(() => {
    if (!pdfDocument || !sectionFocus) return
    const pageNumber = Number(sectionFocus.pageNumber)
    if (Number.isFinite(pageNumber) && pageNumber > 0 && pageNumber <= pdfDocument.numPages) {
      setPdfPage(pageNumber)
    }
  }, [pdfDocument, sectionFocus, setPdfPage])

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
      if (visiblePage != null && visiblePage !== useAppStore.getState().pdfPage) {
        scrollTrackedPageRef.current = visiblePage
        setPdfPage(visiblePage)
      }
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
    // The pending-annotation cleanup effect below only prunes stale entries once
    // its own state update has committed — for at least one render in between,
    // a just-saved measurement exists in both `saved` (from the store) and
    // `pendingAnnotations` (not yet cleaned up) with the identical id, which
    // React renders as duplicate keys ("children ... duplicated and/or
    // omitted"). Filter that overlap out here too, so the list is never
    // duplicated regardless of which render the cleanup effect lands on.
    const savedIds = new Set(saved.map(annotation => annotation.id))
    const pending = pendingAnnotations.filter(
      annotation => !hiddenAnnotationIds.has(annotation.id) && !savedIds.has(annotation.id),
    )
    return [...saved, ...pending]
  }, [annotations, hiddenAnnotationIds, optimisticGeometry, pageMetrics, pendingAnnotations])

  const handleMeasure = useCallback(async (measurement, options) => {
    const raw = measurement?.rawAnnotation
    let pendingId = null
    if (raw) {
      const previewItem = {
        id: measurement.annotationId,
        itemType: measurement.measureType,
        mark: measurement.memberMark || measurement.drawingMark || '',
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

  const handleLabelSizeChange = useCallback((payload) => {
    // DrawingsPage's handleMeasurementLabelSizeChange already applies this
    // optimistically to the store itself (not just a debounced save), so the
    // normal annotations → normalizedAnnotations pipeline picks it up on the
    // very next render — no separate local override needed here. That
    // matters because a toolbar S/M/L/XL click (a completely different code
    // path — it doesn't go through this component at all) also changes the
    // store directly; a local-only override here would never see that change
    // and would keep masking it with a stale wheel-set value indefinitely.
    onMeasurementLabelSizeChange?.(payload)
  }, [onMeasurementLabelSizeChange])

  const pages = useMemo(() => pdfDocument
    ? Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1)
    : [], [pdfDocument])

  // Cumulative layout (top offset + size) for every page at the current
  // scale — used only to decide which pages are near the viewport. Actual
  // on-screen positioning is still left to the flex column below; a page
  // that isn't mounted is replaced by a plainly-sized spacer of the same
  // height, so scroll position/height never jumps as pages mount/unmount.
  const pageLayout = useMemo(() => {
    return scaledPageLayout(pages, pageMetrics, firstMetric, pdfScale)
  }, [pages, pageMetrics, firstMetric, pdfScale])

  // Zooming changes the height of every page above the viewport. Preserving
  // only the document-wide scrollTop (or multiplying it by the zoom ratio)
  // therefore moves users into a neighbouring page in multi-page drawings.
  // Anchor the zoom to the page currently under the pointer/viewport and to
  // the same relative point inside that page. This covers toolbar buttons,
  // keyboard zoom and Ctrl+wheel without changing page navigation itself.
  useLayoutEffect(() => {
    const previousScale = previousPdfScaleRef.current
    if (Math.abs(Number(previousScale) - Number(pdfScale)) < 0.0001) return
    previousPdfScaleRef.current = pdfScale

    const container = containerRef.current
    if (!container || !pages.length) {
      zoomAnchorRef.current = null
      return
    }

    const anchor = zoomAnchorRef.current
      ?? capturePageZoomAnchor(container, pages, pageMetrics, firstMetric, previousScale)
    zoomAnchorRef.current = null
    if (!anchor) return

    const pageElement = container.querySelector(`[data-page-number="${anchor.pageNumber}"]`)
    if (!pageElement) return
    const containerRect = container.getBoundingClientRect()
    const pageRect = pageElement.getBoundingClientRect()
    const anchoredPageX = pageRect.left - containerRect.left + anchor.xRatio * pageRect.width
    const anchoredPageY = pageRect.top - containerRect.top + anchor.yRatio * pageRect.height
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth)

    container.scrollTop = Math.min(maxScrollTop, Math.max(0,
      container.scrollTop + anchoredPageY - anchor.viewportY))
    container.scrollLeft = Math.min(maxScrollLeft, Math.max(0,
      container.scrollLeft + anchoredPageX - anchor.viewportX))

    // Keep the toolbar page indicator aligned with the anchored page, and
    // flag this as scroll-derived so the navigation effect does not turn it
    // into a scrollIntoView jump back to the page top.
    scrollTrackedPageRef.current = anchor.pageNumber
    if (useAppStore.getState().pdfPage !== anchor.pageNumber) setPdfPage(anchor.pageNumber)
  }, [firstMetric, pageLayout, pageMetrics, pages, pdfScale, setPdfPage])

  // Virtualization: a document can run 40+ pages, and mounting every one of
  // them permanently (as before) means 40+ live components each with their
  // own canvas + IntersectionObserver. Fast scrolling then sweeps dozens of
  // them through the render-trigger margin within the same burst, all
  // competing for the main thread/GPU at once — that contention, not any
  // single page's cost, is what froze the whole app. Only pages within this
  // window actually mount; everything else is a lightweight spacer div that
  // costs nothing until scrolled near.
  const [scrollWindow, setScrollWindow] = useState({ top: 0, height: 0 })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    let rafId = null
    const measure = () => {
      rafId = null
      setScrollWindow({ top: container.scrollTop, height: container.clientHeight })
    }
    const onScroll = () => {
      if (rafId != null) return
      rafId = requestAnimationFrame(measure)
    }
    measure()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [])

  // Container resize (e.g. side panel opening) can't fire a scroll event but
  // still changes what's visible — piggyback on the size this viewer already
  // tracks to keep the window's height current.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    setScrollWindow(prev => ({ ...prev, height: container.clientHeight }))
  }, [containerSize.width, containerSize.height])

  const mountedPageSet = useMemo(() => {
    const overscan = Math.max(MIN_OVERSCAN_PX, scrollWindow.height * OVERSCAN_MULTIPLIER)
    const from = scrollWindow.top - overscan
    const to = scrollWindow.top + scrollWindow.height + overscan
    const set = new Set()
    for (const entry of pageLayout) {
      if (entry.top + entry.height >= from && entry.top <= to) set.add(entry.pageNumber)
    }
    // Keep the first page mounted regardless — it's the fit/metrics anchor
    // and the near-zero-cost fallback while the window above is still empty
    // (e.g. the very first layout pass before any scroll event has fired).
    if (pages.length) set.add(pages[0])
    return set
  }, [pageLayout, scrollWindow, pages])

  const handlePointerDown = useCallback((event) => {
    // A paste "stamp" session in progress means every left-click on the
    // canvas is meant to place a copy — never arm panning here in that case.
    // Without this guard, a plain left-click in Select tool (PAN_TOOLS
    // includes 'select') always fell through to setPointerCapture on this
    // container below, which retargets the pointerup/click that follows to
    // this div instead of wherever the pointer visually is — so the SVG
    // overlay's own onClick (the one that actually places the paste) never
    // received the click at all, and paste silently did nothing.
    // Middle-button drag is the permanent pan override, including while a
    // paste stamp is active. It is checked before the paste guard so button 1
    // pans without placing/cancelling the preview, while button 0 still flows
    // to the overlay and places the copy exactly as before.
    const middleButtonPan = event.button === 1
    if (pasteClipboard && !middleButtonPan) return
    // Held-Space always pans, regardless of tool — see spaceHeld's store comment.
    const canPan = middleButtonPan
      || spaceHeld
      || (PAN_TOOLS.has(activeTool) && event.button === 0)
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
  }, [activeTool, spaceHeld, pasteClipboard])

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
    zoomAnchorRef.current = capturePageZoomAnchor(
      container,
      pages,
      pageMetrics,
      firstMetric,
      pdfScale,
      event.clientX - rect.left,
      event.clientY - rect.top,
    )
    const direction = event.deltaY < 0 ? 1 : -1
    const factor = 1 + direction * 0.1 * (wheelZoomSensitivity ?? 1)
    const nextScale = clampScale(pdfScale * factor)
    if (Math.abs(nextScale - pdfScale) < 0.0001) {
      zoomAnchorRef.current = null
      return
    }
    setPdfScale(nextScale)
  }, [firstMetric, pageMetrics, pages, pdfScale, setPdfScale, wheelZoomSensitivity])

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
      onAuxClick={event => {
        // Prevent the browser's native middle-click auto-scroll/action after
        // completing a viewer pan. The pointer handlers above own button 1.
        if (event.button === 1) event.preventDefault()
      }}
      onClick={() => {
        // Safety net for Pan tool specifically: the page SVG is deliberately
        // pointer-events:none there (so panning isn't blocked by hit-testing
        // shapes), so no click ever reaches PdfSvgOverlay's own handleClick
        // at all in that mode — nothing was clearing selection on a plain
        // click while panning. In every other tool this just double-fires
        // alongside the SVG's own handleClick's onClearSelection (harmless,
        // idempotent). A genuine shape click still selects correctly: any
        // element actually clicked (a shape's own <g>) calls stopPropagation
        // before a click event ever reaches this far up, in every tool.
        // Keep an explicitly selected schedule member armed from the first
        // placement click through the second. This safety-net deselection is
        // only needed outside an active dimension command.
        if (!['line', 'calibrate'].includes(activeTool)) onClearSelection?.()
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        if (pasteClipboard) setPasteClipboard(null)
        onClearSelection?.()
      }}
      tabIndex={0}
    >
      {loading && <div className="pdfjs-document-status">Preparing drawing...</div>}
      {error && <div className="pdfjs-document-error">{error}</div>}
      {pdfDocument && (
        <div className="pdfjs-page-stack" style={{ gap: PAGE_GAP }}>
          {pageLayout.map(({ pageNumber, width, height }) => (
            mountedPageSet.has(pageNumber) ? (
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
                selectedAnnotationIds={selectedAnnotationIds}
                pasteClipboard={pasteClipboard}
                sectionPlacementMode={sectionPlacementMode}
                sectionPlacements={sectionPlacements}
                sectionFocus={sectionFocus}
                sectionFocuses={sectionFocuses}
                sectionMeasurementColors={sectionMeasurementColors}
                sectionDraftColor={sectionDraftColor}
                sectionEditMode={sectionEditMode}
                onSectionEditRequest={onSectionEditRequest}
                onMeasure={handleMeasure}
                onSectionSelection={onSectionSelection}
                onSectionPlacement={onSectionPlacement}
                onSectionPlacementContextMenu={onSectionPlacementContextMenu}
                onSelect={onAnnotationSelect}
                onContextMenu={onAnnotationContextMenu}
                onClearSelection={onClearSelection}
                onGeometryChange={handleGeometryChange}
                onLabelSizeChange={handleLabelSizeChange}
              />
            ) : (
              <div
                key={pageNumber}
                data-page-number={pageNumber}
                className="pdfjs-page-spacer"
                style={{ width, height }}
                aria-label={`PDF page ${pageNumber}`}
              />
            )
          ))}
        </div>
      )}
    </div>
  )
}
