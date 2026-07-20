import { memo, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import PdfSvgOverlay from './PdfSvgOverlay'

const MAX_OUTPUT_SCALE = 2
const MAX_CACHE_ENTRIES = 18
const bitmapCache = new Map()

export function clearDocumentBitmaps(documentKey) {
  for (const key of bitmapCache.keys()) {
    if (key.startsWith(`${documentKey}|`)) bitmapCache.delete(key)
  }
}

function cacheKey(documentKey, pageNumber, scale, rotation) {
  return `${documentKey}|${pageNumber}|${rotation}|${scale.toFixed(3)}`
}

function rememberBitmap(key, canvas) {
  const copy = document.createElement('canvas')
  copy.width = canvas.width
  copy.height = canvas.height
  copy.getContext('2d', { alpha: false })?.drawImage(canvas, 0, 0)
  bitmapCache.delete(key)
  bitmapCache.set(key, copy)
  while (bitmapCache.size > MAX_CACHE_ENTRIES) bitmapCache.delete(bitmapCache.keys().next().value)
}

function nearestBitmap(documentKey, pageNumber, rotation, scale) {
  let best = null
  let distance = Infinity
  for (const [key, canvas] of bitmapCache) {
    const [doc, page, cacheRotation, cacheScale] = key.split('|')
    if (doc !== documentKey || Number(page) !== pageNumber || Number(cacheRotation) !== rotation) continue
    const candidateDistance = Math.abs(Number(cacheScale) - scale)
    if (candidateDistance < distance) {
      best = canvas
      distance = candidateDistance
    }
  }
  return best
}

function clearTextLayer(container) {
  container?.replaceChildren()
}

function PdfJsPage({
  pdfDocument,
  documentKey,
  pageNumber,
  scale,
  root,
  initialSize,
  onMetric,
  onVisibility,
  forceRender,
  annotations,
  selectedAnnotationId,
  pasteClipboard,
  onMeasure,
  onSelect,
  onContextMenu,
  onClearSelection,
  onGeometryChange,
}) {
  const hostRef = useRef(null)
  const canvasRef = useRef(null)
  const textLayerRef = useRef(null)
  const renderTaskRef = useRef(null)
  const textLayerTaskRef = useRef(null)
  const pageRef = useRef(null)
  const renderedOnceRef = useRef(false)
  const [shouldRender, setShouldRender] = useState(pageNumber === 1 || forceRender)
  const [isIntersecting, setIsIntersecting] = useState(false)
  const [renderedOnce, setRenderedOnce] = useState(false)
  const [renderError, setRenderError] = useState(null)

  const pageSize = initialSize ?? { width: 612, height: 792 }
  const width = Math.max(1, pageSize.width * scale)
  const height = Math.max(1, pageSize.height * scale)

  useEffect(() => {
    if (forceRender) setShouldRender(true)
  }, [forceRender])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !root) return undefined
    const observer = new IntersectionObserver(([entry]) => {
      onVisibility?.(pageNumber, entry.intersectionRatio)
      setIsIntersecting(entry.isIntersecting)
      if (entry.isIntersecting) setShouldRender(true)
    }, {
      root,
      rootMargin: '3000px 0px',
      threshold: [0, 0.01, 0.25, 0.5, 0.75, 1],
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [onVisibility, pageNumber, root])

  useEffect(() => {
    if (!pdfDocument || !shouldRender) return undefined
    // shouldRender is a one-way ratchet (stays true forever once a page has
    // ever been near the current page or on-screen) so its own render output
    // stays mounted for instant scroll-back. But re-running the actual pdfium
    // rasterize on every scale change for EVERY page that ratchet has ever
    // touched means zooming after scrolling through a long document fires a
    // simultaneous full-document re-render burst — the "stuck" jank during
    // zoom. Gate the expensive re-render itself on still being near the
    // current page or actually on-screen; a page that's neither just keeps
    // showing its last bitmap (CSS-stretched by the wrapper's new width/height)
    // until it's scrolled back into range, at which point this effect re-runs
    // (forceRender/isIntersecting are dependencies below) and rasterizes fresh
    // at whatever scale is current then.
    if (!forceRender && !isIntersecting) return undefined
    let cancelled = false
    let stagingCanvas = null

    const showCachedBitmap = (effectiveRotation) => {
      const cached = bitmapCache.get(cacheKey(documentKey, pageNumber, scale, effectiveRotation))
        ?? nearestBitmap(documentKey, pageNumber, effectiveRotation, scale)
      const canvas = canvasRef.current
      if (!cached || !canvas || renderedOnceRef.current) return
      canvas.width = cached.width
      canvas.height = cached.height
      canvas.getContext('2d', { alpha: false })?.drawImage(cached, 0, 0)
      renderedOnceRef.current = true
      setRenderedOnce(true)
    }

    const renderPage = async () => {
      setRenderError(null)
      renderTaskRef.current?.cancel?.()
      textLayerTaskRef.current?.cancel?.()

      const page = pageRef.current ?? await pdfDocument.getPage(pageNumber)
      if (cancelled) return
      pageRef.current = page
      const effectiveRotation = page.rotate ?? 0
      showCachedBitmap(effectiveRotation)
      const baseViewport = page.getViewport({ scale: 1 })
      onMetric?.(pageNumber, { width: baseViewport.width, height: baseViewport.height, rotation: baseViewport.rotation })
      const viewport = page.getViewport({ scale })
      const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE)

      stagingCanvas = document.createElement('canvas')
      stagingCanvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
      stagingCanvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
      const stagingContext = stagingCanvas.getContext('2d', { alpha: false })
      const renderTask = page.render({
        canvasContext: stagingContext,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
        background: '#ffffff',
      })
      renderTaskRef.current = renderTask
      await renderTask.promise
      if (cancelled) return

      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = stagingCanvas.width
        canvas.height = stagingCanvas.height
        canvas.getContext('2d', { alpha: false })?.drawImage(stagingCanvas, 0, 0)
        rememberBitmap(cacheKey(documentKey, pageNumber, scale, effectiveRotation), stagingCanvas)
        renderedOnceRef.current = true
        setRenderedOnce(true)
      }

      clearTextLayer(textLayerRef.current)
      if (textLayerRef.current && pdfjsLib.TextLayer && !cancelled) {
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container: textLayerRef.current,
          viewport,
        })
        textLayerTaskRef.current = textLayer
        textLayer.render().catch(error => {
          if (error?.name !== 'AbortException') console.warn(`[PDF.js] Text layer ${pageNumber}`, error)
        })
      }
    }

    renderPage().catch((error) => {
      if (cancelled || error?.name === 'RenderingCancelledException') return
      console.error(`[PDF.js] Failed to render page ${pageNumber}`, error)
      setRenderError(`Page ${pageNumber} could not be rendered`)
    })
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel?.()
      textLayerTaskRef.current?.cancel?.()
      stagingCanvas = null
    }
  }, [documentKey, onMetric, pageNumber, pdfDocument, scale, shouldRender, forceRender, isIntersecting])

  useEffect(() => () => {
    renderTaskRef.current?.cancel?.()
    textLayerTaskRef.current?.cancel?.()
    pageRef.current?.cleanup?.()
  }, [])

  return (
    <section ref={hostRef} className="pdfjs-page-shell" data-page-number={pageNumber}
      style={{ width, height }} aria-label={`PDF page ${pageNumber}`}>
      <canvas ref={canvasRef} className="pdfjs-page-canvas"
        style={{ width, height, opacity: renderedOnce ? 1 : 0 }} />
      <div ref={textLayerRef} className="textLayer pdfjs-text-layer" style={{ width, height }} />
      <PdfSvgOverlay
        pageNumber={pageNumber}
        pageSize={pageSize}
        viewerScale={scale}
        annotations={annotations}
        selectedAnnotationId={selectedAnnotationId}
        pasteClipboard={pasteClipboard}
        onMeasure={onMeasure}
        onSelect={onSelect}
        onAnnotationContextMenu={onContextMenu}
        onClearSelection={onClearSelection}
        onGeometryChange={onGeometryChange}
      />
      {!renderedOnce && !renderError && <div className="pdfjs-page-placeholder" aria-hidden="true" />}
      {renderError && <div className="pdfjs-page-error">{renderError}</div>}
    </section>
  )
}

export default memo(PdfJsPage)
