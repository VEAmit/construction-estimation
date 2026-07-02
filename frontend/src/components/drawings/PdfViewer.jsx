import '../../syncfusion-license.js'
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
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
import { buildMeasureLabelPatch, toSyncfusionLabelSize, buildLinearDistanceStyle, buildLinearLabelDiagramStyle, cloneLinearAnnotationForPaste, inferArrowStyleFromAnnot, inferLinearLineModeFromAnnot, inferLabelSizeFromSfFontSize, computeLinearLabelGap, getLinearAnnotationMidpoint } from '../../utils/measureLabel'
import {
  getCalibratedDrawing,
  normalizeDrawing,
  extractPixelLengthFromAnnot,
  extractPixelAreaFromAnnot,
  resolveCalibratedMeasure,
  formatPdfMeasureLabel,
  computeRealLengthFromDrawing,
  extractDisplayedMeasureFromAnnot,
  getSyncfusionNativeUnit,
  resolveUncalibratedMeasureLength,
  lengthFromPdfPoints,
  applyUncalibratedMeasureRatioToViewer,
  registerUncalibratedScaleForAnnotation,
} from '../../utils/measureCalibration'
import { calibrationSnapshot, traceCalibration, traceMeasurementDebug } from '../../utils/calibrationTrace'
import { probeMediaBoxFromBuffer } from '../../utils/pdfPageProbe'
import { detectMarkNearMeasureLine, loadPdfTextItemsByPage } from '../../utils/drawingMarkDetect'
import { getEffectiveMeasureDrawColor, resolveDrawColorForMemberMark } from '../../utils/memberMarkColor'
import * as pdfjsLib from 'pdfjs-dist'
import toast from 'react-hot-toast'

pdfjsLib.GlobalWorkerOptions.workerSrc = `${window.location.origin}/pdf.worker.min.mjs`

// Syncfusion pdfium WASM files live in /public/ej2-pdfviewer-lib (copied by the Vite plugin).
// Must be an absolute URL: the pdfium worker is created from a blob: URL, so importScripts
// inside it needs a fully-qualified origin to avoid blob-origin resolution issues.
// Not setting serviceUrl switches the viewer to client-side WASM rendering — no backend needed.
const SF_RESOURCE_URL = `${window.location.origin}/ej2-pdfviewer-lib`

/** Syncfusion v33 — zoom/fit live on magnificationModule, not vm.fitPage / vm.zoomTo. */
function getMagnification(vm) {
  return vm?.magnificationModule ?? vm?.magnification ?? null
}

/**
 * Tell Syncfusion the viewer uses full container width.
 * CSS-only sidebar hide leaves ~48–200px in fit math → tiny PDF in the corner.
 * Call only after the first page has rendered (pdfium worker ready).
 */
function syncViewerLayout(vm, recalcPages = false, containerWidth = null) {
  if (!vm?.viewerBase?.viewerContainer) return
  try {
    const vb = vm.viewerBase
    const hostW = containerWidth ?? vm.element?.clientWidth ?? vb.viewerContainer.parentElement?.clientWidth ?? 0
    vb.toolbarHeight = 0
    const pane = vb.navigationPane
    if (pane) {
      if (pane.sideBarToolbar) {
        pane.sideBarToolbar.style.display = 'none'
        pane.sideBarToolbar.style.width = '0'
        pane.sideBarToolbar.style.minWidth = '0'
      }
      if (pane.sideBarToolbarSplitter) {
        pane.sideBarToolbarSplitter.style.display = 'none'
        pane.sideBarToolbarSplitter.style.width = '0'
      }
      if (pane.sideBarContentContainer) {
        pane.sideBarContentContainer.style.display = 'none'
        pane.sideBarContentContainer.style.width = '0'
      }
      // Never call updateViewerContainerOnClose() — it re-applies sidebar left offset
      // and shrinks viewer width, which breaks fit-to-width on large drawings.
    }
    const vc = vb.viewerContainer
    const fullW = hostW > 80 ? hostW : vc.clientWidth
    vc.style.top = '0px'
    vc.style.left = '0px'
    vc.style.marginTop = '0px'
    if (fullW > 0) vc.style.width = `${fullW}px`
    for (const suffix of ['_toolbarContainer', '_annotation_toolbar', '_formdesigner_toolbar']) {
      const tb = vb.getElement?.(suffix)
      if (tb) {
        tb.style.display = 'none'
        tb.style.height = '0'
        tb.style.minHeight = '0'
        tb.style.maxHeight = '0'
        tb.style.overflow = 'hidden'
      }
    }
    if (vb.pageContainer && fullW > 0) {
      vb.pageContainer.style.width = `${fullW}px`
    }
    if (recalcPages) vb.onWindowResize?.()
  } catch (_) { /* viewer mid-init */ }
}

function applyFitWidthToViewer(vm, setPdfScale, containerWidth = null, pageMeta = null) {
  const vb = vm?.viewerBase
  if (!vb?.viewerContainer) return
  const vc = vb.viewerContainer
  if (vc.clientWidth < 80 || vc.clientHeight < 80) return

  syncViewerLayout(vm, true, containerWidth)

  const mag = getMagnification(vm)
  if (!mag) return

  // Prefer pdf.js probed size — Syncfusion highestWidth can be wrong on some landscape sheets.
  const pageW = pageMeta?.width ?? vb.highestWidth ?? vb.getPageWidth?.(0)
  if (!pageW || pageW <= 0) return

  try {
    const fitW = containerWidth ?? vc.getBoundingClientRect().width ?? vc.clientWidth
    const scrollPad = mag.scrollWidth ?? 25
    const zoomW = (fitW - scrollPad) / pageW
    const pct = Math.max(10, Math.min(400, Math.floor(zoomW * 100)))
    mag.fitType = 'fitToWidth'
    mag.isAutoZoom = false
    mag.zoomTo?.(pct)

    const zf = mag.zoomFactor
    if (typeof zf === 'number' && zf > 0 && typeof setPdfScale === 'function') {
      setPdfScale(+(zf).toFixed(2))
    }

    alignPageInViewer(vm, pageW, mag.zoomFactor ?? pct / 100)

    const pageGap = vb.pageGap ?? 8
    if (vb.pageSize?.[0]) vb.pageSize[0].top = pageGap
    vc.scrollTop = 0
    vc.scrollLeft = 0
    vb.onWindowResize?.()
  } catch (_) {}
}

/** Center the page div and reset scroll — fixes top-left tiny render on wide media boxes. */
function alignPageInViewer(vm, pageWidthPts, zoomFactor) {
  if (!vm?.viewerBase || !pageWidthPts || !zoomFactor) return
  try {
    const vb = vm.viewerBase
    const vc = vb.viewerContainer
    const viewerId = vm.element?.id ?? 'sfPdfViewer'
    const pageDiv = document.getElementById(`${viewerId}_pageDiv_0`)
    const renderedW = pageWidthPts * zoomFactor
    const containerW = vc.clientWidth || vc.getBoundingClientRect().width
    if (pageDiv && containerW > 0) {
      const left = Math.max(0, (containerW - renderedW) / 2)
      pageDiv.style.left = `${left}px`
    }
    if (vb.pageContainer && containerW > 0) {
      vb.pageContainer.style.width = `${Math.max(containerW, renderedW)}px`
    }
    vc.scrollTop = 0
    vc.scrollLeft = 0
  } catch (_) {}
}

/** After fitToWidth retiles the page, finalize layout without changing zoom again. */
function finalizeViewerLayout(vm, containerWidth = null) {
  if (!vm?.viewerBase?.viewerContainer) return
  syncViewerLayout(vm, true, containerWidth)
  const vc = vm.viewerBase.viewerContainer
  vc.scrollTop = 0
  vc.scrollLeft = 0
}

function applyViewerZoomPct(vm, pct) {
  if (!vm || !Number.isFinite(pct)) return
  try {
    const mag = getMagnification(vm)
    if (mag) mag.fitType = null
    mag?.zoomTo?.(Math.round(pct))
  } catch (_) {}
}

// Guard: prevent two simultaneous recovery calls overlapping.
let _recoverInProgress = false

/**
 * Check whether a canvas is blank/unrendered by sampling 5 pixels.
 *
 * Syncfusion pre-fills every page canvas with OPAQUE WHITE before handing it
 * to pdfium. A canvas pdfium never painted therefore has ALL 5 sample pixels
 * identical (255,255,255,255). A rendered PDF page — even one with lots of
 * white space — will almost always have at least one non-white pixel among
 * those 5 positions (due to lines, text, borders, or anti-aliasing).
 *
 * Returns true  → canvas is uniformly blank (safe to trigger recovery).
 * Returns false → canvas has pixel variation (likely rendered; don't recover).
 * Returns false on any error (cross-origin, WebGL, etc.) → safer default.
 */
function isPageCanvasBlank(canvas) {
  if (!canvas || canvas.width < 4 || canvas.height < 4) return true
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return false
    const w = canvas.width, h = canvas.height
    // 5-point cross pattern covering corners + centre
    const pts = [
      [Math.floor(w * 0.2), Math.floor(h * 0.2)],
      [Math.floor(w * 0.8), Math.floor(h * 0.2)],
      [Math.floor(w * 0.5), Math.floor(h * 0.5)],
      [Math.floor(w * 0.2), Math.floor(h * 0.8)],
      [Math.floor(w * 0.8), Math.floor(h * 0.8)],
    ]
    const ref = ctx.getImageData(pts[0][0], pts[0][1], 1, 1).data
    for (let s = 1; s < pts.length; s++) {
      const px = ctx.getImageData(pts[s][0], pts[s][1], 1, 1).data
      if (px[0] !== ref[0] || px[1] !== ref[1] || px[2] !== ref[2] || px[3] !== ref[3]) {
        return false // Pixel variation detected → content present
      }
    }
    return true // All 5 samples identical → uniformly blank
  } catch (_) {
    return false // Error → assume rendered, avoid false recovery
  }
}

/**
 * Called after scroll/zoom settles and by the stale-page watchdog.
 * Finds visible pages whose pdfium canvas is still blank and forces a re-render.
 *
 * THREE failure modes this handles:
 *   A) Canvas missing entirely            → no canvas child in page div
 *   B) Canvas too small (placeholder)     → width < 40% of page div width
 *   C) Canvas correctly-sized but blank   → all 5 pixel samples are identical
 *      (this is the common case: Syncfusion pre-fills with white before pdfium
 *       renders, so transparent-pixel checks always return "not blank" → wrong)
 *
 * Recovery uses a 1% zoom micro-bump: zoomTo(N+1) → wait one frame → zoomTo(N).
 * This is the only reliable way to force Syncfusion/pdfium to invalidate page
 * caches and re-queue renders — calling zoomTo(N) when already at N% is a no-op.
 */
function recoverBlankVisiblePages(vm) {
  if (_recoverInProgress) return
  if (!vm?.viewerBase?.viewerContainer) return
  const vb = vm.viewerBase
  const vc = vb.viewerContainer
  const id = vm.element?.id ?? 'sfPdfViewer'
  const scrollTop  = vc.scrollTop
  const scrollLeft = vc.scrollLeft
  const vcH        = vc.clientHeight
  const pageCount  = vb.pageCount ?? 0
  if (pageCount === 0) return

  let anyBlank = false
  for (let i = 0; i < pageCount; i++) {
    const div = document.getElementById(`${id}_pageDiv_${i}`)
    if (!div) continue
    const divTop = div.offsetTop
    const divH   = div.offsetHeight || 1
    // Skip pages outside the visible viewport
    if (divTop >= scrollTop + vcH || divTop + divH <= scrollTop) continue

    const divW = div.offsetWidth
    // The page canvas — try Syncfusion's own ID first, then querySelectorAll
    // (annotation canvas is the SECOND canvas, page canvas is the FIRST)
    const allCanvases = div.querySelectorAll('canvas')
    const pageCvs = document.getElementById(`${id}_pageCanvas_${i}`)
      ?? (allCanvases.length > 0 ? allCanvases[0] : null)

    // Case A/B: canvas missing or far smaller than its container
    if (!pageCvs || (divW > 20 && pageCvs.width < divW * 0.4)) {
      console.log(`[SF-Render] page ${i} blank (case A/B): canvas=${pageCvs?.width ?? 'null'} divW=${divW}`)
      anyBlank = true; break
    }

    // Case C: canvas has correct size but content is uniformly blank
    if (isPageCanvasBlank(pageCvs)) {
      console.log(`[SF-Render] page ${i} blank (case C): uniform pixels at zoom=${getMagnification(vm)?.zoomFactor?.toFixed(2) ?? '?'}`)
      anyBlank = true; break
    }
  }

  if (!anyBlank) return

  _recoverInProgress = true
  console.log('[SF-Render] recovering — zoom micro-bump to force pdfium re-render')

  const mag = getMagnification(vm)
  const currentPct = Math.round((mag?.zoomFactor ?? 1) * 100)
  // +1% bump (visually imperceptible, ~1 frame) forces Syncfusion to invalidate
  // page caches and re-queue pdfium renders for all visible pages.
  const bumpPct = currentPct < 400 ? currentPct + 1 : currentPct - 1

  try {
    if (mag) mag.fitType = null
    mag?.zoomTo?.(bumpPct)
  } catch (_) {
    _recoverInProgress = false
    return
  }

  // Restore original zoom after one frame, then re-check scroll position.
  requestAnimationFrame(() => {
    try {
      if (mag) mag.fitType = null
      mag?.zoomTo?.(currentPct)
    } catch (_) {}
    // Allow pdfium ~150 ms to finish renders at the restored zoom before unlocking.
    setTimeout(() => {
      _recoverInProgress = false
      try {
        if (Math.abs(vc.scrollTop  - scrollTop)  > 4) vc.scrollTop  = scrollTop
        if (Math.abs(vc.scrollLeft - scrollLeft) > 4) vc.scrollLeft = scrollLeft
      } catch (_) {}
    }, 150)
  })
}

const MEASURE_MODES = { line: 'Distance', calibrate: 'Distance', area: 'Area', perimeter: 'Perimeter' }
const CONTINUOUS_MEASURE_TOOLS = new Set(['line', 'calibrate', 'area', 'perimeter'])

function cancelMeasureCompleteTimers(mapRef) {
  mapRef.current.forEach(t => clearTimeout(t))
  mapRef.current.clear()
}

/** Set from PdfViewer mount — schedules HTML label overlay with retries after hydrate/import. */
let scheduleMeasureLabelLayoutFn = null
/** Probed MediaBox — more accurate than Syncfusion pageWidth for coord mapping. */
let getPageMetaForCoords = () => null
/** Clear transient live-draw label (set from PdfViewer mount). */
let clearLiveDrawLabelFn = null

const MEASURE_LABEL_GAP_PX = 12

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

  const cal = a?.Calibrate ?? a?.calibrate
  const dist = cal?.Distance ?? cal?.distance
  if (pts.length < 2 && Array.isArray(dist) && dist.length >= 4) {
    const x1 = Number(dist[0]), y1 = Number(dist[1])
    const x2 = Number(dist[2]), y2 = Number(dist[3])
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      pts = [{ x: x1, y: y1 }, { x: x2, y: y2 }]
    }
  }

  return pts
}

function resolveDiagramSvg(vm, pageIndex) {
  const rootId = vm?.element?.id ?? 'sfPdfViewer'
  const hostIds = [
    `${rootId}_diagram_${pageIndex}`,
    `${rootId}_diagram_div_${pageIndex}`,
    `${rootId}_annotationCanvas_${pageIndex}`,
    `${rootId}_annotationCanvas_div_${pageIndex}`,
  ]
  for (const id of hostIds) {
    const host = document.getElementById(id)
    if (!host) continue
    const svg = host.tagName?.toLowerCase() === 'svg' ? host : host.querySelector?.('svg')
    if (svg) return svg
  }
  return resolvePdfPageElement(vm, pageIndex)?.querySelector?.('svg') ?? null
}

/** Measure lines render on the annotation canvas — prefer that SVG for paste/click mapping. */
function resolveMeasureDiagramSvg(vm, pageIndex) {
  const rootId = vm?.element?.id ?? 'sfPdfViewer'
  const hostIds = [
    `${rootId}_annotationCanvas_${pageIndex}`,
    `${rootId}_annotationCanvas_div_${pageIndex}`,
    `${rootId}_diagram_${pageIndex}`,
    `${rootId}_diagram_div_${pageIndex}`,
  ]
  for (const id of hostIds) {
    const host = document.getElementById(id)
    if (!host) continue
    const svg = host.tagName?.toLowerCase() === 'svg' ? host : host.querySelector?.('svg')
    if (svg) return svg
  }
  return resolvePdfPageElement(vm, pageIndex)?.querySelector?.('svg') ?? null
}

function svgDiagramPointToContainer(svg, x, y, container) {
  if (!svg?.createSVGPoint || !container) return null
  const pt = svg.createSVGPoint()
  pt.x = x
  pt.y = y
  const ctm = svg.getScreenCTM?.()
  if (!ctm) return null
  const screen = pt.matrixTransform(ctm)
  const cr = container.getBoundingClientRect()
  return { left: screen.x - cr.left, top: screen.y - cr.top }
}

/** Map a screen click to Syncfusion diagram SVG coordinates (same space as vertexPoints). */
function screenClientToDiagramPoint(clientX, clientY, pageIndex, vm) {
  const svg = resolveMeasureDiagramSvg(vm, pageIndex)
  if (!svg?.createSVGPoint) return null
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const ctm = svg.getScreenCTM?.()
  if (!ctm) return null
  try {
    const diagramPt = pt.matrixTransform(ctm.inverse())
    if (!Number.isFinite(diagramPt.x) || !Number.isFinite(diagramPt.y)) return null
    return { x: diagramPt.x, y: diagramPt.y }
  } catch {
    return null
  }
}

/** Map diagram SVG coordinates to container-relative pixels (for crosshair overlay). */
function diagramPointToContainerCoords(diagramX, diagramY, pageIndex, vm, containerEl) {
  const svg = resolveMeasureDiagramSvg(vm, pageIndex)
  if (!svg || !containerEl) return null
  return svgDiagramPointToContainer(svg, diagramX, diagramY, containerEl)
}

/** Map stored vertex points through the diagram SVG — same space Syncfusion uses to draw the line. */
function getPositionFromDiagramPoints(pts, pageIndex, vm, container, gapPx) {
  if (!pts?.length || pts.length < 2 || !container) return null
  const svg = resolveDiagramSvg(vm, pageIndex)
  if (!svg) return null
  const p0 = svgDiagramPointToContainer(svg, pts[0].x, pts[0].y, container)
  const p1 = svgDiagramPointToContainer(svg, pts[pts.length - 1].x, pts[pts.length - 1].y, container)
  const midX = (pts[0].x + pts[pts.length - 1].x) / 2
  const midY = (pts[0].y + pts[pts.length - 1].y) / 2
  const pm = svgDiagramPointToContainer(svg, midX, midY, container)
  if (!p0 || !p1 || !pm) return null
  return offsetAboveLineScreen(p0, p1, pm, gapPx)
}

function collectMeasureLinePoints(live, raw) {
  if (live?.vertexPoints?.length >= 2) {
    return live.vertexPoints
      .map(p => ({ x: Number(p.x ?? p.X), y: Number(p.y ?? p.Y) }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
  }
  return extractAnnotationPoints(raw ?? live)
}

/** Label anchor — midpoint via PDF coordinate mapping (zoom-aware, always tracks the drawn line). */
function getMeasureLabelScreenPosition(live, raw, pageIndex, vm, container) {
  if (!container) return null
  const pts = collectMeasureLinePoints(live, raw)
  if (pts.length < 2) return null
  return getPositionFromPdfPoints(pts, pageIndex, vm, container, MEASURE_LABEL_GAP_PX)
}

function isLabelPositionOnPage(left, top, pageIndex, vm, container) {
  const pageEl = resolvePdfPageElement(vm, pageIndex)
  if (!pageEl || !container) return false
  const pr = pageEl.getBoundingClientRect()
  const cr = container.getBoundingClientRect()
  const sx = left + cr.left
  const sy = top + cr.top
  return sx >= pr.left - 24 && sx <= pr.right + 24
    && sy >= pr.top - 48 && sy <= pr.bottom + 24
}

function resolveAnnotationPageIndex(source, raw) {
  const idx = source?.pageIndex ?? raw?.pageIndex
  if (idx != null && Number.isFinite(Number(idx))) return Math.max(0, Number(idx))
  const pageNumber = source?.pageNumber ?? source?.PageNumber ?? raw?.pageNumber ?? raw?.PageNumber
    ?? (parseInt(source?.page ?? raw?.page ?? '0', 10) + 1)
  return Math.max(0, pageNumber - 1)
}

function offsetAboveLineScreen(p0, p1, pm, gapPx) {
  if (!pm) return null
  return { left: pm.left, top: pm.top - gapPx, nx: 0, ny: -1 }
}

function getPositionFromPdfPoints(pts, pageIndex, vm, container, gapPx) {
  if (!pts?.length || pts.length < 2 || !container) return null
  const p0 = pdfPointToContainerCoords(pts[0].x, pts[0].y, pageIndex, vm, container)
  const p1 = pdfPointToContainerCoords(
    pts[pts.length - 1].x, pts[pts.length - 1].y, pageIndex, vm, container,
  )
  const midX = (pts[0].x + pts[pts.length - 1].x) / 2
  const midY = (pts[0].y + pts[pts.length - 1].y) / 2
  const pm = pdfPointToContainerCoords(midX, midY, pageIndex, vm, container)
  return offsetAboveLineScreen(p0, p1, pm, gapPx)
}

/** Nudge overlapping labels apart while keeping them above their line. */
function resolveMeasureLabelCollisions(layout, minGap = 18) {
  if (layout.length < 2) return layout
  const out = layout.map(e => ({ ...e }))
  out.sort((a, b) => a.top - b.top || a.left - b.left)
  for (let i = 1; i < out.length; i++) {
    for (let j = 0; j < i; j++) {
      if (Math.abs(out[i].left - out[j].left) < 72 && Math.abs(out[i].top - out[j].top) < minGap) {
        out[i].top = Math.min(out[i].top, out[j].top - minGap)
      }
    }
  }
  return out
}

function buildLinearLabelOverlayEntry({
  vm, container, item, raw, live, displayUnit, measureLabelFontSize, pdfScale, key,
  forcedText,
}) {
  let text = forcedText
    ?? (item ? resolveTakeoffLabelText(item, displayUnit) : resolveLinearLabelText(vm, key, null, displayUnit))
  if ((!text || text.includes('NaN')) && (live ?? raw)) {
    const pts = extractAnnotationPoints(live ?? raw)
    const len = lengthFromPdfPoints(polylineLength(pts), displayUnit)
    if (len != null) text = formatMeasureLength(len, displayUnit)
  }
  if (!text || text.includes('NaN')) return null
  if (!raw && !live) return null

  const source = live ?? raw
  const pageIndex = resolveAnnotationPageIndex(source, raw)
  const pos = getMeasureLabelScreenPosition(live, raw ?? live, pageIndex, vm, container)
  if (!pos) return null

  const color = resolveMeasurementColor({ item, raw, annot: live })

  return {
    key: key ?? raw?.AnnotName ?? raw?.annotationId ?? raw?.name ?? live?.annotationId ?? live?.name,
    left: pos.left,
    top: pos.top,
    nx: pos.nx,
    ny: pos.ny,
    text,
    color,
    fontSizePt: measureLabelFontSize,
  }
}

/** When true, skip re-applying stored thickness during hydrate (user just edited thickness). */
let skipTakeoffStyleHydrate = false

function setSkipTakeoffStyleHydrate(ms = 600) {
  skipTakeoffStyleHydrate = true
  setTimeout(() => { skipTakeoffStyleHydrate = false }, ms)
}

/** Resolve the live Syncfusion diagram object for an annotation id. */
function resolveLiveAnnotation(vm, annotationId) {
  if (!vm || !annotationId) return null
  if (vm.nameTable?.[annotationId]) return vm.nameTable[annotationId]
  const fromTable = Object.values(vm.nameTable ?? {}).find(
    a => a?.annotName === annotationId || a?.id === annotationId || a?.name === annotationId,
  )
  if (fromTable) return fromTable
  return (vm.annotations ?? []).find(
    a => a?.annotName === annotationId || a?.id === annotationId || a?.name === annotationId,
  ) ?? null
}

/** Match imported canvas line by geometry when persisted id differs from Syncfusion internal id. */
function resolveLiveAnnotationByPoints(vm, raw) {
  const pts = extractAnnotationPoints(raw)
  if (!vm || pts.length < 2) return null
  const tol = 3
  const p0 = pts[0]
  const p1 = pts[pts.length - 1]
  return (vm.annotations ?? []).find(a => {
    if (!isLinearMeasureAnnotation(a)) return false
    const livePts = extractAnnotationPoints(a)
    if (livePts.length < 2) return false
    const l0 = livePts[0]
    const l1 = livePts[livePts.length - 1]
    const sameDir = Math.abs(l0.x - p0.x) <= tol && Math.abs(l0.y - p0.y) <= tol
      && Math.abs(l1.x - p1.x) <= tol && Math.abs(l1.y - p1.y) <= tol
    const revDir = Math.abs(l0.x - p1.x) <= tol && Math.abs(l0.y - p1.y) <= tol
      && Math.abs(l1.x - p0.x) <= tol && Math.abs(l1.y - p0.y) <= tol
    return sameDir || revDir
  }) ?? null
}

function resolveLiveForTakeoffItem(vm, raw) {
  const id = raw.AnnotName ?? raw.annotationId ?? raw.name
  return (id ? resolveLiveAnnotation(vm, id) : null) ?? resolveLiveAnnotationByPoints(vm, raw)
}

function isLinearMeasureAnnotation(live) {
  if (!live) return false
  const shape = String(live.shapeAnnotationType ?? live.ShapeAnnotationType ?? '').toLowerCase()
  if (shape === 'distance' || shape === 'line' || shape === 'linewidtharrowhead') return true
  return live.measureType === 'Distance' || live.IT === 'LineDimension' || live.it === 'LineDimension'
}

/** Rebuild Syncfusion distance label text nodes when import did not create them. */
function ensureDistanceLabelChildren(vm, live, labelText, fontColor, measureLabelFontSize, pdfScale) {
  if (!vm || !live || !isLinearMeasureAnnotation(live)) return false
  if (!live.vertexPoints?.length && live.VertexPoints?.length) {
    live.vertexPoints = live.VertexPoints.map(p => ({
      x: Number(p.x ?? p.X) || 0,
      y: Number(p.y ?? p.Y) || 0,
    }))
  }
  if (!live.vertexPoints?.length) return false

  if (labelText) {
    live.notes = labelText
    live.note = labelText
    live.labelContent = labelText
  }
  live.shapeAnnotationType = 'Distance'
  live.measureType = live.measureType || 'Distance'
  if (live.leaderHeight == null || live.leaderHeight < 1) {
    const style = buildLinearDistanceStyle(
      measureLabelFontSize, pdfScale, fontColor,
      live.thickness ?? live.Thickness ?? 2,
      inferArrowStyleFromAnnot(live),
      inferLinearLineModeFromAnnot(live),
    )
    live.leaderHeight = style.leaderLength ?? style.syncLeaderHeight ?? 8
  }
  if (fontColor) {
    live.strokeColor = live.strokeColor ?? fontColor
    live.fontColor = live.fontColor ?? fontColor
  }

  const hasLabel = live.wrapper?.children?.some(isDistanceLabelDiagramChild)
  if (!hasLabel) {
    try { vm.drawing?.initLine?.(live) } catch (_) {}
  }
  return live.wrapper?.children?.some(isDistanceLabelDiagramChild) ?? false
}

function parseAnnotIdFromPointsJson(pointsJson) {
  if (!pointsJson) return null
  try {
    const raw = JSON.parse(pointsJson)
    // AnnotName is stable across import/export; annotationId can be transient (measure1, measure2, ...)
    return raw.AnnotName ?? raw.annotationId ?? raw.name ?? null
  } catch { return null }
}

/** Stable Syncfusion id — same order as pointsJson persistence. */
function resolveStableAnnotationId(a) {
  if (!a || typeof a !== 'object') return null
  return a.AnnotName ?? a.annotName ?? a.annotationId ?? a.AnnotationId ?? a.name ?? a.id ?? null
}

function annotationIdsMatch(a, b) {
  if (!a || !b) return false
  return a === b
}

/** Single source of truth for annotation stroke + label color. */
function resolveMeasurementColor({ item, raw, storeColor, annot, fallback = '#111827' }) {
  if (item?.color) return item.color
  const fromRaw = raw?.strokeColor ?? raw?.StrokeColor
  if (fromRaw) return fromRaw
  const fromAnnot = annot?.strokeColor ?? annot?.StrokeColor
  if (fromAnnot) return fromAnnot
  if (storeColor && /^#[0-9A-Fa-f]{6}$/.test(storeColor)) return storeColor
  return fallback
}

/** Resolve which line annotation should receive live toolbar style updates. */
function resolveLinearStyleTarget(vm, {
  selectedAnnotDataRef, lastDrawnAnnotRef, selectedAnnotationId, annotations,
}) {
  if (selectedAnnotDataRef?.current) {
    const a = selectedAnnotDataRef.current
    const id = a.annotationId ?? a.name ?? a.AnnotName
    if (id) return { annotId: id, item: null, annot: a }
  }
  if (selectedAnnotationId != null && annotations?.length) {
    const item = annotations.find(t => t.id === selectedAnnotationId)
    const id = parseAnnotIdFromPointsJson(item?.pointsJson)
    if (id) {
      const live = vm ? resolveLiveAnnotation(vm, id) : null
      return { annotId: id, item, annot: live }
    }
  }
  if (lastDrawnAnnotRef?.current) {
    return { annotId: lastDrawnAnnotRef.current, item: null, annot: null }
  }
  return null
}

function resolveLinearLabelText(vm, annotId, item, displayUnit) {
  const fromItem = item ? resolveTakeoffLabelText(item, displayUnit) : ''
  const live = vm ? resolveLiveAnnotation(vm, annotId) : null
  const fromLive = live?.notes ?? live?.note ?? live?.labelContent
  const liveStr = fromLive ? String(fromLive).trim() : ''
  // After reload Syncfusion may overwrite notes with NaN/empty during calibrate refresh — prefer DB.
  if (fromItem && (!liveStr || liveStr.includes('NaN') || liveStr === '0' || liveStr === '0.00')) {
    return fromItem
  }
  if (liveStr) return liveStr
  return fromItem || null
}

function isDistanceLabelDiagramChild(child) {
  if (!child) return false
  const id = String(child.id ?? '').toLowerCase()
  if (id.includes('srcdec') || id.includes('tardec') || id.includes('leader')) return false
  if (child.textNodes) return true
  if (typeof child.refreshTextElement === 'function') return true
  if (id.includes('text') || id.includes('label') || id.includes('note')) return true
  if (child.content != null && child.childNodes?.length) return true
  return false
}

/** True when Syncfusion already shows a readable value label on the line. */
function hasVisibleSyncfusionMeasureLabel(live, expectedText) {
  if (!live?.wrapper?.children?.length) return false
  for (const child of live.wrapper.children) {
    if (!isDistanceLabelDiagramChild(child)) continue
    const text = String(child.content ?? child.childNodes?.[0]?.text ?? '').trim()
    if (!text || text.includes('NaN') || text === '0' || text === '0.00') continue
    if (!expectedText || text === expectedText) return true
    return true
  }
  return false
}

function getMeasureLabelAnchorFromPoints(pts, itemType) {
  if (!pts?.length) return null
  if (itemType === 'Area' && pts.length >= 3) {
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    }
  }
  if (pts.length >= 2) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
  return { x: pts[0].x, y: pts[0].y }
}

function resolvePdfPageElement(vm, pageIndex) {
  const rootId = vm?.element?.id ?? 'sfPdfViewer'
  return document.getElementById(`${rootId}_pageDiv_${pageIndex}`)
    ?? document.getElementById(`${rootId}_pageCanvas_${pageIndex}`)
    ?? document.querySelector(`#${rootId} [id$="_pageDiv_${pageIndex}"]`)
}

function getPdfPageSize(vm, pageIndex) {
  const meta = getPageMetaForCoords()
  if (meta?.width > 0 && meta?.height > 0) {
    return { width: meta.width, height: meta.height }
  }
  const vb = vm?.viewerBase
  if (!vb) return null
  const w = Array.isArray(vb.pageWidth) ? vb.pageWidth[pageIndex] : vb.pageWidth
  const h = Array.isArray(vb.pageHeight) ? vb.pageHeight[pageIndex] : vb.pageHeight
  if (Number(w) > 0 && Number(h) > 0) return { width: Number(w), height: Number(h) }
  return null
}

/** Map PDF page coordinates to pixels inside the viewer container (scroll-safe). */
function pdfPointToContainerCoords(pdfX, pdfY, pageIndex, vm, containerEl) {
  const pageEl = resolvePdfPageElement(vm, pageIndex)
  if (!pageEl || !containerEl) return null
  const pageRect = pageEl.getBoundingClientRect()
  const containerRect = containerEl.getBoundingClientRect()
  const pageSize = getPdfPageSize(vm, pageIndex)
  if (pageSize) {
    return {
      left: pageRect.left - containerRect.left + pdfX * (pageRect.width / pageSize.width),
      top: pageRect.top - containerRect.top + pdfY * (pageRect.height / pageSize.height),
    }
  }
  return {
    left: pageRect.left - containerRect.left + pdfX,
    top: pageRect.top - containerRect.top + pdfY,
  }
}

/** Map a screen click to PDF page coordinates (inverse of pdfPointToContainerCoords). */
function containerClientToPdfPoint(clientX, clientY, pageIndex, vm) {
  const pageEl = resolvePdfPageElement(vm, pageIndex)
  if (!pageEl) return null
  const pageRect = pageEl.getBoundingClientRect()
  const pageSize = getPdfPageSize(vm, pageIndex)
  const relX = clientX - pageRect.left
  const relY = clientY - pageRect.top
  if (pageSize && pageRect.width > 0 && pageRect.height > 0) {
    return {
      x: relX * (pageSize.width / pageRect.width),
      y: relY * (pageSize.height / pageRect.height),
    }
  }
  return { x: relX, y: relY }
}

/** Map container-relative pixels to diagram SVG coordinates. */
/** Map container-relative pixels to PDF page coordinates (inverse of pdfPointToContainerCoords). */
function containerScreenToPdfPoint(containerLeft, containerTop, containerEl, pageIndex, vm) {
  if (!containerEl) return null
  const cr = containerEl.getBoundingClientRect()
  return containerClientToPdfPoint(cr.left + containerLeft, cr.top + containerTop, pageIndex, vm)
}

function containerScreenToDiagramPoint(containerLeft, containerTop, containerEl, pageIndex, vm) {
  if (!containerEl) return null
  const cr = containerEl.getBoundingClientRect()
  return screenClientToDiagramPoint(cr.left + containerLeft, cr.top + containerTop, pageIndex, vm)
}

/** Paste anchor from click — PDF page space (same as stored vertexPoints / label mapping). */
function resolvePasteAnchorFromClick(clientX, clientY, pageIndex, vm, containerEl) {
  const pdfPt = containerClientToPdfPoint(clientX, clientY, pageIndex, vm)
  if (pdfPt) return pdfPt
  if (containerEl) {
    const cr = containerEl.getBoundingClientRect()
    const diagramPt = containerScreenToDiagramPoint(
      clientX - cr.left, clientY - cr.top, containerEl, pageIndex, vm,
    )
    if (diagramPt) return diagramPt
  }
  return screenClientToDiagramPoint(clientX, clientY, pageIndex, vm)
}

/** Read the visible measure line endpoints from the rendered SVG (handles leader offset). */
function extractVisibleLineScreenEndpoints(wrapper, container) {
  if (!wrapper || !container) return null
  const cr = container.getBoundingClientRect()
  const svg = wrapper.ownerSVGElement
  const mkPt = svg?.createSVGPoint?.()
  if (!mkPt) return null

  const lines = []
  wrapper.querySelectorAll('line').forEach(el => {
    const id = String(el.id ?? '').toLowerCase()
    if (id.includes('leader') || id.includes('handle') || id.includes('selector')
      || id.includes('resize') || id.includes('endpoint')) return
    const ctm = el.getScreenCTM?.()
    if (!ctm) return
    const x1 = parseFloat(el.getAttribute('x1'))
    const y1 = parseFloat(el.getAttribute('y1'))
    const x2 = parseFloat(el.getAttribute('x2'))
    const y2 = parseFloat(el.getAttribute('y2'))
    if (![x1, y1, x2, y2].every(Number.isFinite)) return
    mkPt.x = x1
    mkPt.y = y1
    const s0 = mkPt.matrixTransform(ctm)
    mkPt.x = x2
    mkPt.y = y2
    const s1 = mkPt.matrixTransform(ctm)
    const len = Math.hypot(s1.x - s0.x, s1.y - s0.y)
    if (len < 2) return
    lines.push({
      p0: { left: s0.x - cr.left, top: s0.y - cr.top },
      p1: { left: s1.x - cr.left, top: s1.y - cr.top },
      len,
    })
  })

  if (!lines.length) return null
  lines.sort((a, b) => b.len - a.len)
  return lines[0]
}

/** Screen endpoints of a linear measure — prefers live DOM line over stored vertexPoints. */
function getLinearMeasureScreenEndpoints(sourceRaw, pageIndex, vm, containerEl) {
  if (!containerEl) return null
  const sourceId = sourceRaw?.annotationId ?? sourceRaw?.AnnotName ?? sourceRaw?.name
  const live = sourceId ? resolveLiveAnnotation(vm, sourceId) : resolveLiveForTakeoffItem(vm, sourceRaw)
  if (live?.wrapper) {
    const visual = extractVisibleLineScreenEndpoints(live.wrapper, containerEl)
    if (visual) return visual
  }

  const pts = extractAnnotationPoints(live ?? sourceRaw)
  if (pts.length < 2) return null

  const p0pdf = pdfPointToContainerCoords(pts[0].x, pts[0].y, pageIndex, vm, containerEl)
  const p1pdf = pdfPointToContainerCoords(
    pts[pts.length - 1].x, pts[pts.length - 1].y, pageIndex, vm, containerEl,
  )
  if (p0pdf && p1pdf) {
    return { p0: p0pdf, p1: p1pdf, len: Math.hypot(p1pdf.left - p0pdf.left, p1pdf.top - p0pdf.top) }
  }

  const svg = resolveMeasureDiagramSvg(vm, pageIndex)
  if (svg) {
    const p0 = svgDiagramPointToContainer(svg, pts[0].x, pts[0].y, containerEl)
    const p1 = svgDiagramPointToContainer(svg, pts[pts.length - 1].x, pts[pts.length - 1].y, containerEl)
    if (p0 && p1) {
      return { p0, p1, len: Math.hypot(p1.left - p0.left, p1.top - p0.top) }
    }
  }

  return null
}

/** Container-relative screen position for paste crosshair — always reproject at current zoom/scroll. */
function resolvePasteAnchorScreenPosition(anchor, pageIndex, vm, containerEl) {
  if (!anchor || !containerEl) return null
  if (Number.isFinite(anchor.x) && Number.isFinite(anchor.y) && vm) {
    const fromPdf = pdfPointToContainerCoords(anchor.x, anchor.y, pageIndex, vm, containerEl)
    if (fromPdf) return fromPdf
    const fromDiagram = diagramPointToContainerCoords(anchor.x, anchor.y, pageIndex, vm, containerEl)
    if (fromDiagram) return fromDiagram
  }
  if (Number.isFinite(anchor.screenLeft) && Number.isFinite(anchor.screenTop)) {
    return { left: anchor.screenLeft, top: anchor.screenTop }
  }
  return null
}

/** Nudge a live pasted line so its visible midpoint matches the click anchor on screen. */
function nudgeLiveLinearMeasureToScreenAnchor(vm, annotId, anchor, containerEl, pageIndex) {
  if (!vm || !annotId || !anchor || !containerEl) return false
  const live = resolveLiveAnnotation(vm, annotId)
  if (!live?.wrapper) return false

  const target = resolvePasteAnchorScreenPosition(anchor, pageIndex, vm, containerEl)
  if (!target) return false

  const visual = extractVisibleLineScreenEndpoints(live.wrapper, containerEl)
  if (!visual) return false

  const midLeft = (visual.p0.left + visual.p1.left) / 2
  const midTop = (visual.p0.top + visual.p1.top) / 2
  const errLeft = target.left - midLeft
  const errTop = target.top - midTop
  if (Math.abs(errLeft) < 0.5 && Math.abs(errTop) < 0.5) return true

  const newP0 = containerScreenToPdfPoint(
    visual.p0.left + errLeft, visual.p0.top + errTop, containerEl, pageIndex, vm,
  )
    ?? containerScreenToDiagramPoint(
      visual.p0.left + errLeft, visual.p0.top + errTop, containerEl, pageIndex, vm,
    )
  const newP1 = containerScreenToPdfPoint(
    visual.p1.left + errLeft, visual.p1.top + errTop, containerEl, pageIndex, vm,
  )
    ?? containerScreenToDiagramPoint(
      visual.p1.left + errLeft, visual.p1.top + errTop, containerEl, pageIndex, vm,
    )
  if (!newP0 || !newP1) return false

  const newPts = [{ x: newP0.x, y: newP0.y }, { x: newP1.x, y: newP1.y }]
  live.vertexPoints = newPts
  live.VertexPoints = newPts.map(p => ({ X: p.x, Y: p.y }))
  live.start = `${newPts[0].x},${newPts[0].y}`
  live.end = `${newPts[1].x},${newPts[1].y}`
  live.Start = live.start
  live.End = live.end

  const bounds = {
    X: Math.min(newPts[0].x, newPts[1].x),
    Y: Math.min(newPts[0].y, newPts[1].y),
    Width: Math.max(Math.abs(newPts[1].x - newPts[0].x), 1),
    Height: Math.max(Math.abs(newPts[1].y - newPts[0].y), 1),
  }
  live.bounds = bounds
  live.Bounds = bounds

  try { vm.drawing?.updateConnector?.(live, newPts) } catch (_) {}
  try { vm.annotation?.renderAnnotations?.(pageIndex, null, null, null, null, false) } catch (_) {}
  try { vm.renderDrawing?.() } catch (_) {}
  return true
}

/** Resolve paste source geometry — prefer live canvas points when the source line still exists. */
function resolvePasteSourcePoints(sourceRaw, pageIndex, vm) {
  const sourceId = sourceRaw?.annotationId ?? sourceRaw?.AnnotName ?? sourceRaw?.name
  const live = sourceId ? resolveLiveAnnotation(vm, sourceId) : null
  const livePts = live ? extractAnnotationPoints(live) : []
  if (livePts.length >= 2) return livePts
  return extractAnnotationPoints(sourceRaw)
}

/**
 * Compute pasted line vertex points so the line center sits on the crosshair.
 * Screen-space pipeline → PDF page coords (matches stored vertexPoints / Syncfusion render).
 */
function computePastedVertexPoints(sourceRaw, anchor, pageIndex, vm, containerEl) {
  if (!anchor || !containerEl || !vm) return null

  const screenEnds = getLinearMeasureScreenEndpoints(sourceRaw, pageIndex, vm, containerEl)
  const target = resolvePasteAnchorScreenPosition(anchor, pageIndex, vm, containerEl)
  if (!screenEnds || !target) return null

  const halfDx = (screenEnds.p1.left - screenEnds.p0.left) / 2
  const halfDy = (screenEnds.p1.top - screenEnds.p0.top) / 2
  const toPagePt = (left, top) => (
    containerScreenToPdfPoint(left, top, containerEl, pageIndex, vm)
    ?? containerScreenToDiagramPoint(left, top, containerEl, pageIndex, vm)
  )
  const newP0 = toPagePt(target.left - halfDx, target.top - halfDy)
  const newP1 = toPagePt(target.left + halfDx, target.top + halfDy)
  if (!newP0 || !newP1) return null
  return [
    { x: newP0.x, y: newP0.y },
    { x: newP1.x, y: newP1.y },
  ]
}

/**
 * Compute paste translation so the line midpoint lands on the anchor (crosshair).
 * Uses clipboard geometry only + the same measure-diagram SVG as click/crosshair mapping.
 */
function computeLinearPasteOffsetForAnchor(sourceRaw, anchor, pageIndex, vm, containerEl) {
  if (!containerEl || !anchor) return null

  const pastedPts = computePastedVertexPoints(sourceRaw, anchor, pageIndex, vm, containerEl)
  if (!pastedPts || pastedPts.length < 2) return null

  const pts = resolvePasteSourcePoints(sourceRaw, pageIndex, vm)
  return {
    offsetX: pastedPts[0].x - pts[0].x,
    offsetY: pastedPts[0].y - pts[0].y,
  }
}

/** Fallback paste offset — diagram midpoint aligned to anchor click. */
function computeLinearPasteOffsetDiagramFallback(sourceRaw, anchor, pageIndex, vm, containerEl) {
  return computeLinearPasteOffsetForAnchor(sourceRaw, anchor, pageIndex, vm, containerEl)
}

/** Build paste anchor from a click — diagram coords + container screen position for crosshair. */
function buildPasteAnchorFromClick(clientX, clientY, pageNumber, pageIndex, vm, containerEl) {
  if (!containerEl) return null
  const cr = containerEl.getBoundingClientRect()
  const pt = resolvePasteAnchorFromClick(clientX, clientY, pageIndex, vm, containerEl)
  if (!pt) return null
  return {
    x: pt.x,
    y: pt.y,
    pageNumber,
    screenLeft: clientX - cr.left,
    screenTop: clientY - cr.top,
  }
}

/** Convert screen pixels to PDF page coordinate units at the current zoom. */
function screenPixelsToPdfUnits(pixels, pageIndex, vm) {
  const pageEl = resolvePdfPageElement(vm, pageIndex)
  if (!pageEl) return Math.max(8, pixels)
  const pageRect = pageEl.getBoundingClientRect()
  const pageSize = getPdfPageSize(vm, pageIndex)
  if (pageSize && pageRect.width > 0 && pageRect.height > 0) {
    return pixels * (pageSize.width / pageRect.width)
  }
  return Math.max(8, pixels)
}

/** Hide perpendicular end-cap leaders and reposition the value label above the line. */
function hideLinearEndCaps(live, startHead = 'None', endHead = 'None') {
  if (!live?.wrapper?.children?.length) return
  for (const child of live.wrapper.children) {
    const id = String(child.id ?? '').toLowerCase()
    if (id.includes('leader')) {
      child.visible = false
      child.width = 0
      child.height = 0
      if (child.style) child.style.strokeWidth = 0
      continue
    }
    if (id.includes('srcdec') || id.includes('tardec')) {
      const hide = (id.includes('srcdec') && startHead === 'None')
        || (id.includes('tardec') && endHead === 'None')
      if (hide) {
        child.visible = false
        child.width = 0
        child.height = 0
        if (child.style) child.style.strokeWidth = 0
      }
    }
    if (id.includes('selector') || id.includes('endpoint') || id.includes('handle') || id.includes('resize')) {
      child.visible = false
      child.width = 0
      child.height = 0
    }
  }
}

/** Hide measurement value on the line — values live in the grid only after draw completes. */
function hideLineMeasureLabelOnViewer(vm, annotationId) {
  if (!vm || !annotationId) return
  const live = resolveLiveAnnotation(vm, annotationId)
  if (!live) return
  live.notes = ''
  live.note = ''
  live.labelContent = ''
  live.LabelContent = ''
  hideSyncfusionNativeMeasureLabelText(live)
  try {
    const pageIdx = live.pageIndex ?? Math.max(0, (live.pageNumber ?? 1) - 1)
    vm.annotation?.renderAnnotations?.(pageIdx, null, null, null, null, false)
  } catch (_) {}
  try { vm.renderDrawing?.() } catch (_) {}
  try { clearLiveDrawLabelFn?.() } catch (_) {}
}

/** Hide Syncfusion's native distance label text after the line is saved. */
function hideSyncfusionNativeMeasureLabelText(live) {
  if (!live?.wrapper?.children?.length) return
  for (const child of live.wrapper.children) {
    if (!isDistanceLabelDiagramChild(child)) continue
    child.visible = false
    if (child.style) child.style.opacity = 0
    const text = String(child.content ?? child.childNodes?.[0]?.text ?? '').trim()
    if (/nan/i.test(text)) {
      child.content = ''
      if (child.childNodes?.[0]) child.childNodes[0].text = ''
    }
    child.isDirt = true
  }
}

/** Hide Syncfusion SVG text nodes for measurement labels (NaN during draw, or any saved value).
 *  Custom React overlay handles all visible label rendering — Syncfusion text is always hidden. */
function suppressNativeMeasureLabelsOnPage(vm, pageIndex) {
  const svg = resolveDiagramSvg(vm, pageIndex)
  if (!svg) return
  svg.querySelectorAll('text, tspan').forEach(el => {
    const t = (el.textContent ?? '').trim()
    if (!t) return
    // Hide NaN (in-progress draw) and any measurement value text (mm, cm, m, ft, in, yd)
    if (/nan/i.test(t) || /\d/.test(t)) {
      el.style.visibility = 'hidden'
      el.style.opacity = '0'
      el.style.pointerEvents = 'none'
    }
  })
}

function applyBluebeamLinearChrome(live, linearStyle) {
  if (!live?.wrapper?.children?.length || !linearStyle) return

  const syncLeaderHeight = linearStyle.syncLeaderHeight ?? linearStyle.leaderLength ?? 8
  if (syncLeaderHeight > 0) {
    live.leaderHeight = syncLeaderHeight
    live.leaderLength = syncLeaderHeight
    live.LeaderLength = syncLeaderHeight
  }

  const startHead = linearStyle.lineHeadStartStyle ?? live.lineHeadStartStyle ?? 'None'
  const endHead = linearStyle.lineHeadEndStyle ?? live.lineHeadEndStyle ?? 'None'
  hideLinearEndCaps(live, startHead, endHead)
  hideSyncfusionNativeMeasureLabelText(live)
}

/** Push label text onto Syncfusion distance diagram children (with render refresh). */
function applyCalibratedLabelToDiagram(vm, annotationId, pageNumber, labelText, fontColor, diagramStyle) {
  if (!vm || !annotationId || !labelText) return false
  const live = resolveLiveAnnotation(vm, annotationId)
  if (!live) return false

  live.notes = labelText
  live.note = labelText
  live.labelContent = labelText

  const labelStyle = diagramStyle ?? {}
  const sfSize = labelStyle.fontSize
  const { measureLabelFontSize: labelPt, pdfScale: zoom } = useAppStore.getState()
  ensureDistanceLabelChildren(vm, live, labelText, fontColor ?? labelStyle.fontColor, labelPt, zoom ?? 1)

  if (!live.wrapper?.children?.length) return false
  const fill = labelStyle.labelFillColor ?? 'rgba(255,255,255,0.94)'
  const border = labelStyle.labelBorderColor ?? 'rgba(0,0,0,0.2)'
  const color = labelStyle.fontColor ?? fontColor

  let updated = false
  for (const child of live.wrapper.children) {
    if (!isDistanceLabelDiagramChild(child)) continue
    child.content = labelText
    if (child.childNodes?.[0]) child.childNodes[0].text = labelText
    if (sfSize) child.style.fontSize = sfSize
    if (color) child.style.color = color
    child.style.fill = fill
    child.style.strokeColor = border
    if (typeof child.refreshTextElement === 'function') child.refreshTextElement()
    child.isDirt = true
    // Keep Syncfusion diagram label invisible — custom React overlay handles all rendering
    child.visible = false
    if (child.style) child.style.opacity = 0
    updated = true
  }
  if (!updated) return false

  applyBluebeamLinearChrome(live, {
    labelGap: labelStyle.labelGap,
    fontSize: sfSize,
    syncLeaderHeight: labelStyle.syncLeaderHeight ?? labelStyle.leaderLength ?? 8,
    leaderLength: labelStyle.syncLeaderHeight ?? labelStyle.leaderLength ?? 8,
    lineHeadStartStyle: labelStyle.lineHeadStartStyle,
    lineHeadEndStyle: labelStyle.lineHeadEndStyle,
  })

  const pageIdx = live.pageIndex ?? Math.max(0, (pageNumber ?? 1) - 1)
  const mod = vm.annotation?.measureAnnotationModule
  try { mod?.modifyInCollection?.('notes', pageIdx, live, false) } catch (_) {}
  try { vm.annotation?.renderAnnotations?.(pageIdx, null, null, null, null, false) } catch (_) {}
  // Re-hide in case renderAnnotations restored visibility from internal Syncfusion state
  hideSyncfusionNativeMeasureLabelText(live)
  try { vm.renderDrawing?.() } catch (_) {}
  return true
}

/** Prime Syncfusion to (re)build distance label DOM, then retry label paint (reload-safe). */
function primeDistanceLabelDom(vm, annotationId, labelText, pageNumber) {
  const live = resolveLiveAnnotation(vm, annotationId)
  if (!live) return
  live.notes = labelText
  live.note = labelText
  live.labelContent = labelText
  try {
    vm.annotation.editAnnotation({
      ...live,
      annotationId,
      name: annotationId,
      AnnotName: annotationId,
      notes: labelText,
      note: labelText,
      labelContent: labelText,
      LabelContent: labelText,
    })
  } catch (_) {}
  const { measureLabelFontSize: labelPt, pdfScale: zoom } = useAppStore.getState()
  ensureDistanceLabelChildren(vm, live, labelText, live.strokeColor ?? '#111827', labelPt, zoom ?? pdfScale)
  if (isLinearMeasureAnnotation(live) && live.vertexPoints?.length) {
    try { vm.drawing?.updateConnector?.(live, live.vertexPoints) } catch (_) {}
  }
  const pageIdx = live.pageIndex ?? Math.max(0, (pageNumber ?? 1) - 1)
  try { vm.annotation?.renderAnnotations?.(pageIdx, null, null, null, null, false) } catch (_) {}
}

/** Label-only restore for reload — does not touch line color/end caps (already correct). */
function restoreSavedMeasureLabelOnly(vm, {
  annotationId, pageNumber, labelText, fontColor,
  measureLabelFontSize, pdfScale, drawing, displayUnit,
}) {
  if (!vm || !annotationId || !labelText) return false

  const mod = vm.annotation?.measureAnnotationModule
  if (mod && drawing?.isCalibrated) {
    registerAnnotationScaleRatio(mod, annotationId, drawing, displayUnit)
  }

  const diagramStyle = buildLinearLabelDiagramStyle(measureLabelFontSize, pdfScale, fontColor)
  const live = resolveLiveAnnotation(vm, annotationId)
  if (live) {
    live.notes = labelText
    live.note = labelText
    live.labelContent = labelText
    try {
      vm.annotation.editAnnotation({
        ...live,
        annotationId,
        name: annotationId,
        AnnotName: annotationId,
        notes: labelText,
        note: labelText,
        labelContent: labelText,
        LabelContent: labelText,
        fontColor,
        FontSize: diagramStyle.fontSize,
      })
    } catch (_) {}
    ensureDistanceLabelChildren(vm, live, labelText, fontColor, measureLabelFontSize, pdfScale)
    if (isLinearMeasureAnnotation(live) && live.vertexPoints?.length) {
      try { vm.drawing?.updateConnector?.(live, live.vertexPoints) } catch (_) {}
      const pageIdx = live.pageIndex ?? Math.max(0, (pageNumber ?? 1) - 1)
      try { vm.annotation?.renderAnnotations?.(pageIdx, null, null, null, null, false) } catch (_) {}
    }
  }

  return applyCalibratedLabelToDiagram(vm, annotationId, pageNumber, labelText, fontColor, diagramStyle)
}

/** Re-apply saved line style on reload — no on-PDF value label (grid only). */
function restoreSavedLineStyleOnly(vm, {
  annotationId, fontColor, measureLabelFontSize, pdfScale, lineThickness, arrowStyle, linearLineMode,
  drawing, displayUnit,
}) {
  if (!vm || !annotationId) return false
  const mod = vm.annotation?.measureAnnotationModule
  if (mod && drawing?.isCalibrated) {
    registerAnnotationScaleRatio(mod, annotationId, drawing, displayUnit)
  }
  const linearStyle = buildLinearDistanceStyle(
    measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle, linearLineMode,
  )
  linearStyle.strokeColor = fontColor
  applyLinearVisualStyleToDiagram(vm, annotationId, linearStyle)
  hideLineMeasureLabelOnViewer(vm, annotationId)
  return !!resolveLiveAnnotation(vm, annotationId)
}

/** Re-apply saved value labels for all takeoff rows (after import or toolbar style refresh). */
function hydrateTakeoffLabelsOnViewer(vm, items, pdfScale) {
  if (!vm || !items?.length) return
  for (const item of items) {
    if ((item.itemType || 'Line') !== 'Line' || !item.pointsJson) continue
    try {
      const raw = JSON.parse(item.pointsJson)
      const id = raw.AnnotName ?? raw.annotationId ?? raw.name ?? `db-${item.id}`
      hideLineMeasureLabelOnViewer(vm, id)
    } catch (_) {}
  }
  try { vm.renderDrawing?.() } catch (_) {}
}

function resolveTakeoffLabelText(item, displayUnit) {
  if (!item) return ''
  const unit = item.unit ?? displayUnit ?? 'Mm'
  const isArea = item.itemType === 'Area'
  if (isArea) {
    const t = formatMeasureArea(item.area, unit)
    if (t) return t
  } else {
    const len = item.length != null ? Number(item.length) : null
    const t = len != null && !Number.isNaN(len) ? formatMeasureLength(len, unit) : ''
    if (t) return t
  }
  const desc = String(item.description ?? '').trim()
  return desc || ''
}

/** Restore a saved measurement label on reload — mirrors live-draw applyMeasureLabelToViewer. */
function restoreSavedMeasureLabel(vm, {
  annotationId, pageNumber, labelText, fontColor,
  measureLabelFontSize, pdfScale, lineThickness, arrowStyle, linearLineMode,
  drawing, displayUnit, isLine = true,
}) {
  if (!vm || !annotationId || !labelText) return false

  const mod = vm.annotation?.measureAnnotationModule
  if (mod && drawing?.isCalibrated) {
    registerAnnotationScaleRatio(mod, annotationId, drawing, displayUnit)
  }

  const diagramStyle = buildLinearLabelDiagramStyle(measureLabelFontSize, pdfScale, fontColor)
  const live = resolveLiveAnnotation(vm, annotationId)
  if (live) {
    if (isLine) ensureDistanceLabelChildren(vm, live, labelText, fontColor, measureLabelFontSize, pdfScale)
  }
  if (isLine) {
    const linearStyle = buildLinearDistanceStyle(
      measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle, linearLineMode,
    )
    linearStyle.strokeColor = fontColor
    applyLinearVisualStyleToDiagram(vm, annotationId, linearStyle)
  }

  if (live) {
    live.notes = labelText
    live.note = labelText
    live.labelContent = labelText
    const patched = patchMeasureAnnotationLabel(
      live, measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle, linearLineMode,
    )
    try {
      vm.annotation.editAnnotation({
        ...live,
        annotationId,
        name: annotationId,
        AnnotName: annotationId,
        strokeColor: fontColor,
        StrokeColor: fontColor,
        notes: labelText,
        note: labelText,
        labelContent: labelText,
        LabelContent: labelText,
        ...patched,
      })
    } catch (_) {}
    try {
      const pageIdx = live.pageIndex ?? Math.max(0, (pageNumber ?? 1) - 1)
      mod?.modifyInCollection?.('notes', pageIdx, live, false)
    } catch (_) {}
  }

  if (applyCalibratedLabelToDiagram(vm, annotationId, pageNumber, labelText, fontColor, diagramStyle)) {
    return true
  }
  primeDistanceLabelDom(vm, annotationId, labelText, pageNumber)
  return applyCalibratedLabelToDiagram(vm, annotationId, pageNumber, labelText, fontColor, diagramStyle)
}

/** Apply saved labels + line styles once annotations exist on the viewer canvas. */
function hydrateTakeoffItemsOnViewer(vm, items, pdfScale, attempt = 0) {
  if (!vm || !items?.length) return
  if (skipTakeoffStyleHydrate && attempt === 0) return
  const {
    measureLabelFontSize: labelPt, lineThickness: thick, arrowStyle: arrows,
    linearLineMode: lineMode, activeUnit, selectedDrawing: drawing,
  } = useAppStore.getState()
  const displayUnit = activeUnit ?? drawing?.calibrationUnit ?? 'Mm'
  let anyMissing = false
  let anyLabelPending = false

  for (const item of items) {
    if (!item.pointsJson) continue
    try {
      const raw = JSON.parse(item.pointsJson)
      const isLine = (item.itemType || 'Line') === 'Line'
      const isArea = item.itemType === 'Area'
      const id = raw.AnnotName ?? raw.annotationId ?? raw.name ?? `db-${item.id}`
      if (!resolveLiveAnnotation(vm, id)) {
        anyMissing = true
        continue
      }
      const pageNumber = raw.pageNumber ?? raw.PageNumber
        ?? (parseInt(raw.page ?? raw.pageIndex ?? '0', 10) + 1)
      const color = resolveMeasurementColor({ item, raw })
      const itemLineMode = inferLinearLineModeFromAnnot(raw)
      const itemArrows = inferArrowStyleFromAnnot(raw)
      if (isLine && !isArea) {
        restoreSavedLineStyleOnly(vm, {
          annotationId: id,
          fontColor: color,
          measureLabelFontSize: labelPt,
          pdfScale,
          lineThickness: raw.Thickness ?? raw.thickness ?? thick,
          arrowStyle: itemArrows !== 'none' ? itemArrows : arrows,
          linearLineMode: itemLineMode === 'simple' ? 'simple' : (lineMode ?? 'simple'),
          drawing,
          displayUnit,
        })
        continue
      }
      const text = resolveTakeoffLabelText(item, displayUnit)
      if (!text) continue
      if (!text) continue
      const ok = attempt === 0
        ? restoreSavedMeasureLabel(vm, {
            annotationId: id,
            pageNumber,
            labelText: text,
            fontColor: color,
            measureLabelFontSize: labelPt,
            pdfScale,
            lineThickness: raw.Thickness ?? raw.thickness ?? thick,
            arrowStyle: itemArrows !== 'none' ? itemArrows : arrows,
            linearLineMode: itemLineMode === 'simple' ? 'simple' : (lineMode ?? 'simple'),
            drawing,
            displayUnit,
            isLine: false,
          })
        : restoreSavedMeasureLabelOnly(vm, {
            annotationId: id,
            pageNumber,
            labelText: text,
            fontColor: color,
            measureLabelFontSize: labelPt,
            pdfScale,
            drawing,
            displayUnit,
          })
      if (!ok) anyLabelPending = true
    } catch (_) {}
  }

  if ((anyMissing || anyLabelPending) && attempt < 12) {
    setTimeout(() => hydrateTakeoffItemsOnViewer(vm, items, pdfScale, attempt + 1), 100)
    return
  }
  hydrateTakeoffLabelsOnViewer(vm, items, pdfScale)
  try { vm.renderDrawing?.() } catch (_) {}
  try { scheduleMeasureLabelLayoutFn?.() } catch (_) {}
}

function buildImportableFromTakeoffItem(item, measureLabelFontSize, pdfScale) {
  if (!item?.pointsJson) return null
  try {
    const raw = JSON.parse(item.pointsJson)
    const fallbackId = `bt-${item.id ?? Date.now()}`
    const rawShape = String(raw.ShapeAnnotationType ?? raw.shapeAnnotationType ?? '').toLowerCase()
    const rawIT = String(raw.IT ?? raw.it ?? '').toLowerCase()
    const isAreaLike = item.itemType === 'Area'
      || rawIT === 'area'
      || rawIT === 'polylinedimension'
      || rawShape === 'polygon'
    const pageIndexRaw = raw.page != null ? parseInt(raw.page, 10)
      : (raw.pageIndex != null ? parseInt(raw.pageIndex, 10)
        : (Number(raw.pageNumber ?? raw.PageNumber ?? 1) - 1))
    if (!Number.isFinite(pageIndexRaw)) return null
    const pageIdx = String(Math.max(0, pageIndexRaw))

    const rawPtsSrc = raw.vertexPoints ?? raw.VertexPoints ?? []
    const validPts = (Array.isArray(rawPtsSrc) ? rawPtsSrc : [])
      .filter(p => p && typeof p === 'object'
        && Number.isFinite(Number(p.x ?? p.X)) && Number.isFinite(Number(p.y ?? p.Y)))
      .map(p => ({ x: Number(p.x ?? p.X), y: Number(p.y ?? p.Y) }))

    let pts = validPts
    if (pts.length < 2 && raw.start && raw.end) {
      pts = [parseAnnotCoord(raw.start), parseAnnotCoord(raw.end)]
    }

    if (pts.length < 2) return null

    const dxSkip = pts[pts.length - 1].x - pts[0].x
    const dySkip = pts[pts.length - 1].y - pts[0].y
    if (Math.sqrt(dxSkip * dxSkip + dySkip * dySkip) < 0.5) return null

    const boundsFromPts = {
      X: Math.min(pts[0].x, pts[pts.length - 1].x),
      Y: Math.min(pts[0].y, pts[pts.length - 1].y),
      Width: Math.max(Math.abs(pts[pts.length - 1].x - pts[0].x), 1),
      Height: Math.max(Math.abs(pts[pts.length - 1].y - pts[0].y), 1),
    }
    const color = resolveMeasurementColor({ item, raw })
    const hasCoordsStr = raw.start && raw.end
    const labelText = resolveTakeoffLabelText(item, item.unit ?? 'Mm')
    const itemArrows = inferArrowStyleFromAnnot(raw)
    const itemLineMode = inferLinearLineModeFromAnnot(raw)
    const linearStyle = !isAreaLike
      ? buildLinearDistanceStyle(
        measureLabelFontSize, pdfScale, color,
        raw.Thickness ?? raw.thickness ?? 2,
        itemArrows, itemLineMode,
      )
      : null

    const isLinearMeasure = !isAreaLike && (
      rawIT === 'linedimension'
      || rawShape === 'distance'
      || rawShape === 'line'
      || (item.itemType || 'Line') === 'Line'
    )
    const linearShapeType = (rawShape === 'distance' || rawIT === 'linedimension')
      ? 'Distance'
      : 'Line'

    const importable = {
      ShapeAnnotationType: isAreaLike ? 'Polygon' : (isLinearMeasure ? linearShapeType : 'Line'),
      shapeAnnotationType: isAreaLike ? 'Polygon' : (isLinearMeasure ? linearShapeType : 'Line'),
      AnnotType: raw.AnnotType ?? 'shape_measure',
      AnnotName: raw.AnnotName ?? raw.annotationId ?? raw.name ?? raw.id ?? fallbackId,
      Author: raw.Author ?? 'BuildTakeoff',
      Bounds: boundsFromPts,
      VertexPoints: pts.map(p => ({ X: p.x, Y: p.y })),
      vertexPoints: pts.map(p => ({ x: p.x, y: p.y })),
      StrokeColor: color,
      strokeColor: color,
      FillColor: raw.FillColor ?? raw.fillColor ?? 'rgba(239,35,60,0.12)',
      Opacity: raw.Opacity ?? raw.opacity ?? 1,
      Thickness: raw.Thickness ?? raw.thickness ?? 2,
      FontSize: raw.FontSize ?? raw.fontSize ?? toSyncfusionLabelSize(measureLabelFontSize, pdfScale),
      fontSize: raw.fontSize ?? raw.FontSize ?? toSyncfusionLabelSize(measureLabelFontSize, pdfScale),
      FontColor: color,
      fontColor: color,
      Subject: raw.Subject ?? 'Distance calculation',
      LeaderLength: raw.LeaderLength ?? raw.leaderLength ?? linearStyle?.leaderLength ?? linearStyle?.syncLeaderHeight ?? 8,
      LeaderLineExtension: raw.LeaderLineExtension ?? raw.leaderLineExtension ?? linearStyle?.leaderLineExtension ?? 0,
      LineHeadStart: raw.LineHeadStart ?? raw.lineHeadStartStyle ?? linearStyle?.lineHeadStartStyle ?? 'None',
      LineHeadEnd: raw.LineHeadEnd ?? raw.lineHeadEndStyle ?? linearStyle?.lineHeadEndStyle ?? 'None',
      labelSettings: raw.labelSettings ?? raw.LabelSettings
        ?? buildMeasureLabelPatch(measureLabelFontSize, pdfScale, color).labelSettings,
      EnableShapeLabel: false,
      enableShapeLabel: false,
      // Caption MUST be true so Syncfusion rebuilds the measurement value label
      // node on import — matches what live-draw sets (measure-annotation getAnnotationData).
      // Without it the label DOM child is never created and reload shows no value.
      Caption: true,
      caption: true,
      CaptionPosition: raw.CaptionPosition ?? raw.captionPosition ?? 'Top',
      captionPosition: raw.captionPosition ?? raw.CaptionPosition ?? 'Top',
      notes: labelText || raw.notes || raw.note || '',
      note: labelText || raw.note || raw.notes || '',
      Note: labelText || raw.Note || raw.note || '',
      labelContent: labelText || raw.labelContent || '',
      LabelContent: labelText || raw.LabelContent || '',
      label: labelText || raw.label || '',
      text: labelText || raw.text || '',
      Calibrate: (() => {
        const cal = raw.Calibrate ?? raw.calibrate ?? {}
        return {
          Ratio: typeof cal.Ratio === 'string' ? cal.Ratio : '1 mm = 1 px',
          X: Array.isArray(cal.X) ? cal.X : [],
          Distance: Array.isArray(cal.Distance) ? cal.Distance : [],
          Area: Array.isArray(cal.Area) ? cal.Area : [],
          Angle: Array.isArray(cal.Angle) ? cal.Angle : [],
          Volume: Array.isArray(cal.Volume) ? cal.Volume : [],
          TargetUnitConversion: typeof cal.TargetUnitConversion === 'number' ? cal.TargetUnitConversion : 1,
        }
      })(),
      // Syncfusion calls .toString() on BorderDashArray and .split() on RotateAngle — must be present
      BorderDashArray: raw.BorderDashArray ?? raw.borderDashArray ?? '0',
      RotateAngle: raw.RotateAngle ?? raw.rotateAngle ?? 'Angle0',
      BorderStyle: raw.BorderStyle ?? raw.borderStyle ?? '',
      IsPrint: true, State: '', StateModel: '', Comments: [],
      name: raw.name ?? raw.annotationId ?? raw.id ?? fallbackId,
      type: raw.type ?? (isAreaLike ? 'Polygon' : 'Line'),
      IT: raw.IT ?? (isAreaLike ? 'Area' : 'LineDimension'),
      Indent: raw.Indent ?? (isAreaLike ? 'PolygonDimension' : 'LineDimension'),
      page: pageIdx,
      pageIndex: parseInt(pageIdx, 10),
      pageNumber: parseInt(pageIdx, 10) + 1,
      ...(hasCoordsStr ? { start: raw.start, end: raw.end } : {
        start: `${pts[0].x},${pts[0].y}`,
        end: `${pts[pts.length - 1].x},${pts[pts.length - 1].y}`,
      }),
    }
    return { pageIdx, importable }
  } catch {
    return null
  }
}

/** Syncfusion requires Calibrate.X/Distance entries with Unit — empty arrays crash on .unit access. */
function defaultCalibrateUnitEntry(displayUnit = 'mm') {
  const u = String(displayUnit || 'mm').toLowerCase()
  return {
    ConversionFactor: u === 'mm' ? 0.013888889 : 1,
    Denominator: 100,
    FormatDenominator: false,
    FractionalType: 'D',
    Unit: u,
  }
}

function normalizeCalibrateArray(arr, fallbackEntry) {
  if (!Array.isArray(arr) || !arr.length) return [{ ...fallbackEntry }]
  return arr.map(item => ({
    ConversionFactor: item?.ConversionFactor ?? item?.conversionFactor ?? fallbackEntry.ConversionFactor,
    Denominator: item?.Denominator ?? item?.denominator ?? 100,
    FormatDenominator: item?.FormatDenominator ?? item?.formatDenominator ?? false,
    FractionalType: item?.FractionalType ?? item?.fractionalType ?? 'D',
    Unit: item?.Unit ?? item?.unit ?? fallbackEntry.Unit,
  }))
}

function resolveCalibrateRatioForRender(cal, drawing, displayUnit) {
  if (typeof cal?.Ratio === 'string' && cal.Ratio.includes('=')) return cal.Ratio
  if (drawing?.isCalibrated && drawing.scaleRatio > 0) {
    const u = getUnitLabel(displayUnit)
    const destPerPx = convertFromMm(drawing.scaleRatio, displayUnit)
    if (destPerPx != null && Number.isFinite(destPerPx)) {
      return `1 px = ${destPerPx} ${u}`
    }
  }
  const u = String(getUnitLabel(displayUnit) || 'mm').toLowerCase()
  return `1 ${u} = 1 px`
}

/** Syncfusion viewer modifiedDate — must match stickyNotesAnnotationModule.getDateAndTime (M/d/yyyy h:mm:ss a). */
function syncfusionViewerModifiedDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return syncfusionViewerModifiedDate(new Date())
  const M = d.getMonth() + 1
  const day = d.getDate()
  const y = d.getFullYear()
  let h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${M}/${day}/${y} ${h}:${m}:${s} ${ampm}`
}

function getSyncfusionViewerModifiedDate(vm, value) {
  try {
    const mod = vm?.annotation?.stickyNotesAnnotationModule
    if (mod && typeof mod.getDateAndTime === 'function') {
      return mod.getDateAndTime(value ?? new Date())
    }
  } catch (_) {}
  return syncfusionViewerModifiedDate(value)
}

function isValidSyncfusionViewerModifiedDate(val) {
  if (typeof val !== 'string' || !val.trim()) return false
  if (/^D:\d/.test(val)) return false
  return /\d{1,2}\/\d{1,2}\/\d{4}/.test(val)
}

function ensureLiveMeasureDates(live, vm = null) {
  if (!live) return
  const viewerDate = getSyncfusionViewerModifiedDate(vm)
  const md = live.modifiedDate ?? live.ModifiedDate
  if (!isValidSyncfusionViewerModifiedDate(md)) {
    live.modifiedDate = viewerDate
    live.ModifiedDate = viewerDate
  } else {
    live.modifiedDate = md
    live.ModifiedDate = md
  }
  const cd = live.creationDate ?? live.CreationDate
  if (!isValidSyncfusionViewerModifiedDate(cd)) {
    live.creationDate = live.modifiedDate
    live.CreationDate = live.modifiedDate
  }
  if (live.review && typeof live.review === 'object') {
    if (!isValidSyncfusionViewerModifiedDate(live.review.modifiedDate)) {
      live.review.modifiedDate = live.modifiedDate
    }
  }
  if (Array.isArray(live.comments)) {
    for (const c of live.comments) {
      if (c && typeof c === 'object' && !isValidSyncfusionViewerModifiedDate(c.modifiedDate)) {
        c.modifiedDate = live.modifiedDate
      }
      if (c?.review && !isValidSyncfusionViewerModifiedDate(c.review.modifiedDate)) {
        c.review.modifiedDate = live.modifiedDate
      }
    }
  }
}

/** Push date fields into Syncfusion measure collection (live node alone is not enough for saveMeasureShapeAnnotations). */
function syncLiveMeasureDatesToCollection(vm, live, pageIndex) {
  const mod = vm?.annotation?.measureAnnotationModule
  if (!mod || !live) return
  ensureLiveMeasureDates(live, vm)
  const pageIdx = pageIndex ?? live.pageIndex ?? 0
  for (const key of ['modifiedDate', 'creationDate', 'rotateAngle']) {
    try { mod.modifyInCollection?.(key, pageIdx, live, false) } catch (_) {}
  }
}

/** Fix pasted measure dates in Syncfusion session storage (saveMeasureShapeAnnotations reads this). */
function patchMeasureShapeSessionStorage(vm) {
  const base = vm?.pdfViewerBase
  const docId = base?.documentId
  if (!docId) return
  const storageKey = `${docId}_annotations_shape_measure`
  let raw = null
  try {
    raw = base.annotationStorage?.[storageKey]
      ?? base.sessionStorageManager?.getItem?.(storageKey)
  } catch (_) {}
  if (!raw || typeof raw !== 'string') return
  try {
    const collection = JSON.parse(raw)
    if (!Array.isArray(collection)) return
    let changed = false
    const viewerDate = getSyncfusionViewerModifiedDate(vm)
    for (const pageObj of collection) {
      const annots = pageObj?.annotations
      if (!Array.isArray(annots)) continue
      for (const annot of annots) {
        if (!annot || typeof annot !== 'object') continue
        if (!isValidSyncfusionViewerModifiedDate(annot.modifiedDate)) {
          annot.modifiedDate = viewerDate
          changed = true
        }
        if (annot.review && typeof annot.review === 'object'
          && !isValidSyncfusionViewerModifiedDate(annot.review.modifiedDate)) {
          annot.review.modifiedDate = annot.modifiedDate
          changed = true
        }
      }
    }
    if (!changed) return
    const str = JSON.stringify(collection)
    if (base.annotationStorage) base.annotationStorage[storageKey] = str
    try { base.sessionStorageManager?.setItem?.(storageKey, str) } catch (_) {}
  } catch (_) {}
}

/** Ensure Syncfusion measure-shape render has no undefined fields (avoids .toString() / .unit crashes). */
function sanitizeLinearMeasureShape(importable, displayUnit = 'Mm', drawing = null) {
  const cal = importable.Calibrate ?? importable.calibrate ?? {}
  const xEntry = defaultCalibrateUnitEntry(displayUnit)
  const distEntry = { ...xEntry, ConversionFactor: 1 }
  const bounds = importable.Bounds ?? importable.bounds ?? {}
  const bx = bounds.X ?? bounds.x ?? 0
  const by = bounds.Y ?? bounds.y ?? 0
  const bw = bounds.Width ?? bounds.width ?? 1
  const bh = bounds.Height ?? bounds.height ?? 1
  return {
    ...importable,
    AnnotType: importable.AnnotType ?? 'shape_measure',
    IT: importable.IT ?? importable.it ?? 'LineDimension',
    Indent: importable.Indent ?? importable.indent ?? 'LineDimension',
    Author: importable.Author ?? 'BuildTakeoff',
    BorderDashArray: importable.BorderDashArray ?? importable.borderDashArray ?? 0,
    BorderStyle: importable.BorderStyle ?? 'Solid',
    CloudIntensity: importable.CloudIntensity ?? 0,
    Comments: importable.Comments ?? [],
    EnableShapeLabel: importable.EnableShapeLabel ?? false,
    FillColor: importable.FillColor ?? importable.fillColor ?? 'rgba(239,35,60,0.12)',
    IsCloudShape: importable.IsCloudShape ?? false,
    IsCommentLock: importable.IsCommentLock ?? false,
    IsLocked: importable.IsLocked ?? false,
    IsPrint: importable.IsPrint ?? true,
    ModifiedDate: importable.ModifiedDate ?? getSyncfusionViewerModifiedDate(null),
    CreationDate: importable.CreationDate ?? importable.ModifiedDate ?? getSyncfusionViewerModifiedDate(null),
    Note: importable.Note ?? importable.note ?? '',
    note: importable.note ?? importable.Note ?? '',
    Opacity: importable.Opacity ?? importable.opacity ?? 1,
    RectangleDifference: importable.RectangleDifference ?? [],
    RotateAngle: importable.RotateAngle ?? 'RotateAngle0',
    State: importable.State ?? '',
    StateModel: importable.StateModel ?? '',
    Subject: importable.Subject ?? 'Distance calculation',
    Caption: importable.Caption ?? true,
    CaptionPosition: importable.CaptionPosition ?? 'Top',
    LeaderLength: importable.LeaderLength ?? importable.leaderLength ?? 8,
    LeaderLineExtension: importable.LeaderLineExtension ?? importable.leaderLineExtension ?? 0,
    LeaderLineOffset: importable.LeaderLineOffset ?? 0,
    Bounds: {
      X: bx, Y: by, Width: bw, Height: bh,
      Left: bounds.Left ?? bx,
      Top: bounds.Top ?? by,
      Right: bounds.Right ?? (bx + bw),
      Bottom: bounds.Bottom ?? (by + bh),
    },
    Calibrate: {
      Ratio: resolveCalibrateRatioForRender(cal, drawing, displayUnit),
      X: normalizeCalibrateArray(cal.X, xEntry),
      Distance: normalizeCalibrateArray(cal.Distance, distEntry),
      Area: Array.isArray(cal.Area) && cal.Area.length
        ? normalizeCalibrateArray(cal.Area, { ...xEntry, Unit: `sq ${xEntry.Unit}` })
        : [],
      Angle: Array.isArray(cal.Angle) ? cal.Angle : [],
      Volume: Array.isArray(cal.Volume) ? cal.Volume : [],
      TargetUnitConversion: typeof cal.TargetUnitConversion === 'number' ? cal.TargetUnitConversion : 1,
    },
  }
}

/** Render one linear measurement on the viewer without import/export APIs. */
function renderLinearMeasurementOnViewer(vm, importable, pageIndex, displayUnit, drawing) {
  const mod = vm?.annotation?.measureAnnotationModule
  if (!mod?.renderMeasureShapeAnnotations) return false
  const shape = sanitizeLinearMeasureShape(importable, displayUnit, drawing)
  const viewerDate = getSyncfusionViewerModifiedDate(vm)
  shape.ModifiedDate = isValidSyncfusionViewerModifiedDate(shape.ModifiedDate) ? shape.ModifiedDate : viewerDate
  shape.CreationDate = isValidSyncfusionViewerModifiedDate(shape.CreationDate) ? shape.CreationDate : viewerDate
  try {
    mod.renderMeasureShapeAnnotations([shape], pageIndex, true, false)
  } catch (err) {
    console.error('[BuildTakeoff] renderMeasureShapeAnnotations failed:', err)
    return false
  }
  try { vm.annotation?.renderAnnotations?.(pageIndex, null, null, null, null, false) } catch (_) {}
  try { vm.renderDrawing?.() } catch (_) {}
  patchMeasureShapeSessionStorage(vm)
  const annotId = shape.AnnotName ?? shape.name ?? shape.annotationId
  if (annotId) {
    try { patchLiveLinearMeasureIntegrity(vm, annotId, shape, pageIndex) } catch (_) {}
    setTimeout(() => {
      try { patchLiveLinearMeasureIntegrity(vm, annotId, shape, pageIndex) } catch (_) {}
    }, 50)
    if (resolveLiveAnnotation(vm, annotId)) return true
    if (resolveLiveAnnotationByPoints(vm, shape)) return true
  }
  // renderMeasureShapeAnnotations succeeded — live node may register on next tick
  return true
}

function collectAllLiveMeasureAnnotations(vm) {
  if (!vm) return []
  const seen = new Set()
  const out = []
  const push = (a) => {
    if (!a || !isLinearMeasureAnnotation(a)) return
    const id = resolveStableAnnotationId(a) ?? a.annotName ?? a.id ?? a.name
    if (id && seen.has(id)) return
    if (id) seen.add(id)
    out.push({ live: a, id, pageIndex: a.pageIndex ?? 0 })
  }
  Object.values(vm.nameTable ?? {}).forEach(push)
  ;(vm.annotations ?? []).forEach(push)
  return out
}

/** Minimal in-place patch for export — never calls editAnnotation (avoids corrupting in-progress draws). */
function patchLiveAnnotationForExport(live, displayUnit = 'Mm', vm = null) {
  if (!live) return
  if (extractAnnotationPoints(live).length < 2) return

  ensureLiveMeasureDates(live, vm)

  if (!live.rotateAngle && !live.RotateAngle) {
    live.rotateAngle = 'RotateAngle0'
    live.RotateAngle = 'RotateAngle0'
  }

  const ratio = live.calibrate?.ratio ?? live.Calibrate?.Ratio
  if (!ratio || typeof ratio !== 'string' || !ratio.includes('=')) {
    const u = String(getUnitLabel(displayUnit) || 'mm').toLowerCase()
    const fallback = `1 ${u} = 1 px`
    if (live.calibrate && typeof live.calibrate === 'object') {
      live.calibrate.ratio = fallback
    } else {
      live.calibrate = { ratio: fallback, x: [], distance: [], area: [], angle: [], volume: [] }
    }
  }
}

/** Patch every complete live linear measure before export — read-only safe, no editAnnotation. */
function patchAllLiveMeasureAnnotationsForExport(vm, displayUnit) {
  if (!vm) return
  for (const { live, pageIndex } of collectAllLiveMeasureAnnotations(vm)) {
    try {
      patchLiveAnnotationForExport(live, displayUnit, vm)
      syncLiveMeasureDatesToCollection(vm, live, pageIndex)
    } catch (_) {}
  }
  patchMeasureShapeSessionStorage(vm)
}

/** Full re-sync for pasted/imported lines only — safe before next draw, not during in-progress native draw. */
function patchImportedLinearMeasures(vm, displayUnit, drawing, importedIds) {
  if (!vm || !importedIds?.size) return
  for (const { live, id, pageIndex } of collectAllLiveMeasureAnnotations(vm)) {
    if (!importedIds.has(id)) continue
    const shape = sanitizeLinearMeasureShape({
      AnnotName: id,
      name: id,
      ModifiedDate: live.modifiedDate ?? live.ModifiedDate,
      CreationDate: live.creationDate ?? live.CreationDate,
      RotateAngle: live.rotateAngle ?? live.RotateAngle ?? 'RotateAngle0',
      Calibrate: live.Calibrate ?? live.calibrate,
      calibrate: live.calibrate ?? live.Calibrate,
      vertexPoints: live.vertexPoints,
      VertexPoints: live.vertexPoints,
      Bounds: live.bounds ?? live.Bounds,
      ShapeAnnotationType: 'Distance',
    }, displayUnit, drawing)
    try { patchLiveLinearMeasureIntegrity(vm, id, shape, pageIndex) } catch (_) {}
  }
}

function prepareMeasureAnnotationsForNextDraw(vm, displayUnit, drawing, importedIds) {
  if (!vm) return
  patchAllLiveMeasureAnnotationsForExport(vm, displayUnit)
  patchImportedLinearMeasures(vm, displayUnit, drawing, importedIds)
  patchMeasureShapeSessionStorage(vm)
}

/** Full integrity patch for pasted renders — may call editAnnotation to sync calibrate on canvas. */
function patchLiveLinearMeasureIntegrity(vm, annotId, shape, pageIndex) {
  const live = resolveLiveAnnotation(vm, annotId)
  if (!live) return

  ensureLiveMeasureDates(live, vm)
  const modifiedDate = live.modifiedDate ?? live.ModifiedDate
  const creationDate = live.creationDate ?? live.CreationDate

  Object.assign(live, {
    modifiedDate,
    ModifiedDate: modifiedDate,
    creationDate,
    CreationDate: creationDate,
  })

  if (!shape?.Calibrate) {
    syncLiveMeasureDatesToCollection(vm, live, pageIndex)
    return
  }

  const ratio = typeof shape.Calibrate.Ratio === 'string' && shape.Calibrate.Ratio.includes('=')
    ? shape.Calibrate.Ratio
    : '1 mm = 1 px'
  const rotateAngle = shape.RotateAngle ?? 'RotateAngle0'
  const borderDash = shape.BorderDashArray ?? 0

  const toFmt = (entry, fallbackUnit = 'mm') => ({
    unit: String(entry?.Unit ?? entry?.unit ?? fallbackUnit).toLowerCase(),
    fractionalType: entry?.FractionalType ?? entry?.fractionalType ?? 'D',
    conversionFactor: Number(entry?.ConversionFactor ?? entry?.conversionFactor ?? 0.013888889),
    denominator: Number(entry?.Denominator ?? entry?.denominator ?? 100),
    formatDenominator: entry?.FormatDenominator ?? entry?.formatDenominator ?? false,
  })

  const xEntry = (shape.Calibrate.X ?? [])[0]
  const distEntry = (shape.Calibrate.Distance ?? [])[0]
  const xArr = [toFmt(xEntry)]
  const distArr = [toFmt(distEntry ?? xEntry, xArr[0].unit)]

  const calibrate = {
    ratio,
    x: xArr,
    distance: distArr,
    area: [],
    angle: [],
    volume: [],
    targetUnitConversion: shape.Calibrate.TargetUnitConversion ?? 1,
  }

  Object.assign(live, {
    rotateAngle,
    RotateAngle: rotateAngle,
    borderDashArray: String(borderDash),
    BorderDashArray: borderDash,
    calibrate,
    Calibrate: shape.Calibrate,
  })

  try {
    vm.annotation.editAnnotation({
      ...live,
      annotationId: annotId,
      name: annotId,
      AnnotName: annotId,
      modifiedDate,
      ModifiedDate: modifiedDate,
      creationDate,
      CreationDate: creationDate,
      rotateAngle,
      RotateAngle: rotateAngle,
      borderDashArray: borderDash,
      BorderDashArray: borderDash,
    })
  } catch (_) {}

  const mod = vm.annotation?.measureAnnotationModule
  const pageIdx = pageIndex ?? live.pageIndex ?? 0
  try { mod?.modifyInCollection?.('modifiedDate', pageIdx, live, false) } catch (_) {}
  try { mod?.modifyInCollection?.('creationDate', pageIdx, live, false) } catch (_) {}
  try { mod?.modifyInCollection?.('rotateAngle', pageIdx, live, false) } catch (_) {}
  try { vm.annotation?.renderAnnotations?.(pageIdx, null, null, null, null, false) } catch (_) {}
}

/** Apply toolbar label + line visual style to one linear measurement. */
function applyToolbarLinearStyle(vm, target, {
  measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle, linearLineMode, displayUnit,
}) {
  if (!vm || !target?.annotId) return
  const { annotId, item, annot } = target
  const linearStyle = buildLinearDistanceStyle(
    measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle, linearLineMode,
  )
  linearStyle.strokeColor = fontColor
  applyLinearVisualStyleToDiagram(vm, annotId, linearStyle)

  const pageNumber = annot?.pageNumber ?? annot?.PageNumber
    ?? (item?.pointsJson ? (() => {
      try {
        const raw = JSON.parse(item.pointsJson)
        return raw.pageNumber ?? raw.PageNumber ?? (parseInt(raw.page ?? '0', 10) + 1)
      } catch { return null }
    })() : null)
    ?? (resolveLiveAnnotation(vm, annotId)?.pageIndex ?? 0) + 1

  const labelText = resolveLinearLabelText(vm, annotId, item, displayUnit)
  if (labelText) {
    const diagramStyle = buildLinearLabelDiagramStyle(measureLabelFontSize, pdfScale, fontColor)
    if (!applyCalibratedLabelToDiagram(vm, annotId, pageNumber, labelText, fontColor, diagramStyle)) {
      primeDistanceLabelDom(vm, annotId, labelText, pageNumber)
      applyCalibratedLabelToDiagram(vm, annotId, pageNumber, labelText, fontColor, diagramStyle)
    }
  }
}

function resolveLinearItemColor(item, storeColor, fallback = '#111827') {
  if (item?.color) return item.color
  if (storeColor && /^#[0-9A-Fa-f]{6}$/.test(storeColor)) return storeColor
  if (!item?.pointsJson) return fallback
  try {
    const raw = JSON.parse(item.pointsJson)
    return raw.strokeColor ?? raw.StrokeColor ?? fallback
  } catch { return fallback }
}

function findTakeoffItemByAnnotId(annotations, annotId) {
  if (!annotId || !annotations?.length) return null
  return annotations.find(t => {
    if ((t.itemType || 'Line') !== 'Line' || !t.pointsJson) return false
    return parseAnnotIdFromPointsJson(t.pointsJson) === annotId
  }) ?? null
}

/** Resolve the linear measurement that should receive toolbar style edits. */
function resolveActiveLinearStyleTarget(
  vm, selectedAnnotationId, annotations, selectedAnnotDataRef, lastDrawnAnnotId = null, styleEditTargetId = null,
) {
  const resolveFromItem = (item, dbId) => {
    if (!item || (item.itemType || 'Line') !== 'Line' || !item.pointsJson) return null
    const annotId = parseAnnotIdFromPointsJson(item.pointsJson)
    if (!annotId) return null
    let raw
    try { raw = JSON.parse(item.pointsJson) } catch { raw = null }
    const live = resolveLiveAnnotation(vm, annotId) ?? (raw ? resolveLiveForTakeoffItem(vm, raw) : null)
    return { annotId, item, annot: live, dbId: dbId ?? item.id ?? null }
  }

  // 1. Explicit grid row picked for style editing
  if (styleEditTargetId != null && annotations?.length) {
    const target = resolveFromItem(annotations.find(t => t.id === styleEditTargetId), styleEditTargetId)
    if (target) return target
  }

  // 2. PDF canvas selection (user clicked a line on the drawing)
  const canvasLive = selectedAnnotDataRef?.current
  if (canvasLive && isLinearMeasureAnnotation(canvasLive)) {
    const annotId = resolveStableAnnotationId(canvasLive)
    if (annotId) {
      const item = findTakeoffItemByAnnotId(annotations, annotId)
      return {
        annotId,
        item,
        annot: resolveLiveAnnotation(vm, annotId) ?? canvasLive,
        dbId: item?.id ?? null,
      }
    }
  }

  // 3. Grid row highlight (selectedAnnotationId)
  if (selectedAnnotationId != null && annotations?.length) {
    const target = resolveFromItem(annotations.find(t => t.id === selectedAnnotationId), selectedAnnotationId)
    if (target) return target
  }

  // 4. Last line placed (continuous takeoff — no explicit selection)
  return resolveLastDrawnStyleTarget(vm, annotations, lastDrawnAnnotId)
}

function resolveLastDrawnStyleTarget(vm, annotations, lastDrawnAnnotId) {
  if (!lastDrawnAnnotId || !vm) return null
  let live = resolveLiveAnnotation(vm, lastDrawnAnnotId)
  if (!live) {
    live = (vm.annotations ?? []).find(a => {
      const ids = [a.AnnotName, a.annotName, a.annotationId, a.name, a.id].filter(Boolean)
      return ids.some(id => annotationIdsMatch(id, lastDrawnAnnotId))
    }) ?? null
  }
  if (!live) {
    const item = findTakeoffItemByAnnotId(annotations, lastDrawnAnnotId)
    if (item?.pointsJson) {
      try { live = resolveLiveForTakeoffItem(vm, JSON.parse(item.pointsJson)) } catch (_) {}
    }
  }
  if (!live || !isLinearMeasureAnnotation(live)) return null
  const annotId = resolveStableAnnotationId(live) ?? lastDrawnAnnotId
  const item = findTakeoffItemByAnnotId(annotations, annotId)
    ?? findTakeoffItemByAnnotId(annotations, lastDrawnAnnotId)
  return {
    annotId,
    item,
    annot: live,
    dbId: item?.id ?? null,
  }
}

/** Push stroke width to rendered SVG paths (Syncfusion sometimes ignores diagram style alone). */
function forceMeasureStrokeOnDom(live, vm, thickness, strokeColor) {
  if (!live || thickness == null) return
  const pageIdx = live.pageIndex ?? 0
  const roots = [
    document.getElementById(`${vm?.element?.id ?? 'sfPdfViewer'}_diagram_${pageIdx}`),
    document.getElementById(`${vm?.element?.id ?? 'sfPdfViewer'}_annotationCanvas_${pageIdx}`),
  ].filter(Boolean)
  const groupId = live.wrapper?.id ?? live.id ?? live.name ?? live.annotationId
  for (const root of roots) {
    const group = groupId
      ? (root.querySelector?.(`#${CSS.escape(String(groupId))}`) ?? document.getElementById(String(groupId)))
      : null
    const scope = group ?? root
    scope.querySelectorAll?.('path, line, polyline').forEach(el => {
      const id = String(el.id ?? '').toLowerCase()
      if (id.includes('leader') || id.includes('text') || id.includes('label')) return
      el.setAttribute('stroke-width', String(thickness))
      if (strokeColor) el.setAttribute('stroke', strokeColor)
    })
  }
}

/** Apply toolbar color + thickness to one selected linear measurement. */
function applyStyleToLinearMeasurement(vm, target, color, styleParams) {
  if (!vm || !target?.annotId) return
  const safeHex = /^#[0-9A-Fa-f]{6}$/.test(String(color ?? '')) ? color : '#111827'
  const thick = styleParams.lineThickness ?? 2
  const paintedItem = target.item ? { ...target.item, color: safeHex } : target.item
  const styleTarget = { annotId: target.annotId, item: paintedItem, annot: target.annot }
  applyToolbarLinearStyle(vm, styleTarget, { ...styleParams, fontColor: safeHex, lineThickness: thick })

  let pageNumber = target.annot?.pageNumber ?? target.annot?.PageNumber
  if (pageNumber == null && target.item?.pointsJson) {
    try {
      const raw = JSON.parse(target.item.pointsJson)
      pageNumber = raw.pageNumber ?? raw.PageNumber ?? (parseInt(raw.page ?? '0', 10) + 1)
    } catch (_) {}
  }
  pageNumber = pageNumber ?? ((resolveLiveAnnotation(vm, target.annotId)?.pageIndex ?? 0) + 1)

  const live = resolveLiveAnnotation(vm, target.annotId) ?? target.annot
  if (live) {
    live.thickness = thick
    live.Thickness = thick
    const patched = patchMeasureAnnotationLabel(
      live,
      styleParams.measureLabelFontSize,
      styleParams.pdfScale,
      safeHex,
      thick,
      styleParams.arrowStyle,
      styleParams.linearLineMode,
    )
    try {
      vm.annotation.editAnnotation({
        ...live,
        annotationId: target.annotId,
        name: target.annotId,
        AnnotName: target.annotId,
        strokeColor: safeHex,
        StrokeColor: safeHex,
        thickness: thick,
        Thickness: thick,
        ...patched,
      })
    } catch (_) {}
    const linearStyle = buildLinearDistanceStyle(
      styleParams.measureLabelFontSize, styleParams.pdfScale, safeHex,
      thick, styleParams.arrowStyle, styleParams.linearLineMode,
    )
    linearStyle.strokeColor = safeHex
    applyLinearVisualStyleToDiagram(vm, target.annotId, linearStyle)
    forceMeasureStrokeOnDom(live, vm, thick, safeHex)
  }

  const labelText = resolveLinearLabelText(vm, target.annotId, paintedItem, styleParams.displayUnit)
  if (labelText) {
    applyCalibratedLabelToDiagram(
      vm, target.annotId, pageNumber, labelText, safeHex,
      buildLinearLabelDiagramStyle(styleParams.measureLabelFontSize, styleParams.pdfScale, safeHex),
    )
  }
  try { vm.renderDrawing?.() } catch (_) {}
}

/** @deprecated use applyStyleToLinearMeasurement */
function applyColorToSelectedLinearMeasurement(vm, selectedAnnotationId, annotations, color, styleParams) {
  const target = resolveActiveLinearStyleTarget(vm, selectedAnnotationId, annotations, { current: null })
  if (!target) {
    const item = annotations?.find(t => t.id === selectedAnnotationId)
    if (!item?.pointsJson) return
    const annotId = parseAnnotIdFromPointsJson(item.pointsJson)
    if (!annotId) return
    applyStyleToLinearMeasurement(vm, { annotId, item, annot: resolveLiveAnnotation(vm, annotId), dbId: selectedAnnotationId }, color, styleParams)
    return
  }
  applyStyleToLinearMeasurement(vm, target, color, styleParams)
}

/** Collect every saved linear measurement on the drawing. */
function listAllLinearTargets(annotations, vm) {
  if (!annotations?.length) return []
  const targets = []
  for (const item of annotations) {
    if ((item.itemType || 'Line') !== 'Line' || !item.pointsJson) continue
    const id = parseAnnotIdFromPointsJson(item.pointsJson)
    if (!id) continue
    targets.push({
      annotId: id,
      item,
      annot: vm ? resolveLiveAnnotation(vm, id) : null,
    })
  }
  return targets
}

function resolveStoredLineThickness(item, fallback = 2) {
  if (!item?.pointsJson) return fallback
  try {
    const raw = JSON.parse(item.pointsJson)
    const t = raw.Thickness ?? raw.thickness
    if (t != null && Number.isFinite(Number(t)) && Number(t) > 0) return Number(t)
  } catch (_) {}
  return fallback
}

function inferLinearStyleFromItem(item, styleParams) {
  let arrowStyle = styleParams.arrowStyle ?? 'none'
  let linearLineMode = styleParams.linearLineMode ?? 'simple'
  if (item?.pointsJson) {
    try {
      const raw = JSON.parse(item.pointsJson)
      const itemArrows = inferArrowStyleFromAnnot(raw)
      const itemLineMode = inferLinearLineModeFromAnnot(raw)
      if (itemArrows !== 'none') arrowStyle = itemArrows
      if (itemLineMode === 'simple') linearLineMode = 'simple'
      else if (itemLineMode === 'arrow') linearLineMode = itemLineMode
    } catch (_) {}
  }
  return { arrowStyle, linearLineMode }
}

/** Re-apply label font/gap on zoom or label-size change — each line keeps its own stored thickness. */
function reapplyLinearLabelPresetToAll(vm, annotations, styleParams) {
  if (!vm || !annotations?.length) return
  const displayUnit = styleParams.displayUnit ?? 'Mm'
  for (const target of listAllLinearTargets(annotations, vm)) {
    const fontColor = resolveLinearItemColor(target.item, styleParams.fontColor, styleParams.fontColor ?? '#111827')
    const itemThickness = resolveStoredLineThickness(target.item, 2)
    const { arrowStyle, linearLineMode } = inferLinearStyleFromItem(target.item, styleParams)
    const linearStyle = buildLinearDistanceStyle(
      styleParams.measureLabelFontSize, styleParams.pdfScale, fontColor,
      itemThickness, arrowStyle, linearLineMode,
    )
    linearStyle.strokeColor = fontColor
    applyLinearVisualStyleToDiagram(vm, target.annotId, linearStyle)

    const labelText = resolveLinearLabelText(vm, target.annotId, target.item, displayUnit)
    if (!labelText) continue
    let pageNumber = target.annot?.pageNumber ?? target.annot?.PageNumber
    if (pageNumber == null && target.item?.pointsJson) {
      try {
        const raw = JSON.parse(target.item.pointsJson)
        pageNumber = raw.pageNumber ?? raw.PageNumber ?? (parseInt(raw.page ?? '0', 10) + 1)
      } catch (_) {}
    }
    pageNumber = pageNumber ?? ((resolveLiveAnnotation(vm, target.annotId)?.pageIndex ?? 0) + 1)
    applyCalibratedLabelToDiagram(
      vm, target.annotId, pageNumber, labelText, fontColor,
      buildLinearLabelDiagramStyle(styleParams.measureLabelFontSize, styleParams.pdfScale, fontColor),
    )
  }
}

/** Apply toolbar label + thickness + line mode to ALL linear measurements on the PDF. */
function applyToolbarLinearStyleToAll(vm, annotations, styleParams) {
  if (!vm || !annotations?.length) return
  const targets = listAllLinearTargets(annotations, vm)
  for (const target of targets) {
    const fontColor = resolveLinearItemColor(target.item, styleParams.fontColor, styleParams.fontColor ?? '#111827')
    const itemThickness = resolveStoredLineThickness(target.item, styleParams.lineThickness ?? 2)
    applyToolbarLinearStyle(vm, target, { ...styleParams, fontColor, lineThickness: itemThickness })
    try {
      const live = target.annot ?? resolveLiveAnnotation(vm, target.annotId)
      if (live) {
        const patched = patchMeasureAnnotationLabel(
          live,
          styleParams.measureLabelFontSize,
          styleParams.pdfScale,
          fontColor,
          itemThickness,
          styleParams.arrowStyle,
          styleParams.linearLineMode,
        )
        vm.annotation.editAnnotation({
          ...live,
          annotationId: target.annotId,
          name: target.annotId,
          AnnotName: target.annotId,
          strokeColor: fontColor,
          StrokeColor: fontColor,
          ...patched,
        })
      }
    } catch (_) {}
  }
}

/** Apply unified line weight + leaders + arrows to a live distance annotation. */
function applyLinearVisualStyleToDiagram(vm, annotationId, linearStyle) {
  if (!vm || !annotationId || !linearStyle) return false
  const live = resolveLiveAnnotation(vm, annotationId)
  if (!live?.wrapper) return false

  const startHead = linearStyle.lineHeadStartStyle ?? 'None'
  const endHead = linearStyle.lineHeadEndStyle ?? 'None'

  const nodePatch = {}
  if (linearStyle.thickness != null) nodePatch.thickness = linearStyle.thickness
  if (linearStyle.leaderLength != null) nodePatch.leaderHeight = linearStyle.leaderLength
  if (linearStyle.strokeColor) nodePatch.strokeColor = linearStyle.strokeColor
  nodePatch.lineHeadStartStyle = startHead
  nodePatch.lineHeadEndStyle = endHead

  live.lineHeadStartStyle = startHead
  live.lineHeadEndStyle = endHead
  live.leaderHeight = linearStyle.leaderLength ?? live.leaderHeight
  if (linearStyle.strokeColor) {
    live.strokeColor = linearStyle.strokeColor
    live.StrokeColor = linearStyle.strokeColor
  }
  if (linearStyle.thickness != null) {
    live.thickness = linearStyle.thickness
    live.Thickness = linearStyle.thickness
  }

  if (Object.keys(nodePatch).length) {
    try { vm.nodePropertyChange(live, nodePatch) } catch (_) {}
  }

  const annMod = vm.annotation
  if (annMod?.getArrowType) {
    try { live.sourceDecoraterShapes = annMod.getArrowType(startHead) } catch (_) {}
    try { live.taregetDecoraterShapes = annMod.getArrowType(endHead) } catch (_) {}
  }

  if (live.wrapper.children?.length) {
    for (const child of live.wrapper.children) {
      const id = String(child.id ?? '')
      const isLabelEl = child?.textNodes || id.includes('text') || id.includes('label') || id.includes('note')
      if (child.style && !isLabelEl) {
        if (linearStyle.thickness != null) child.style.strokeWidth = linearStyle.thickness
        if (linearStyle.strokeColor) child.style.strokeColor = linearStyle.strokeColor
      }
    }
  }

  if (live.shapeAnnotationType === 'Distance' && live.vertexPoints?.length) {
    try { vm.drawing?.updateConnector?.(live, live.vertexPoints) } catch (_) {}
  }

  if (live.wrapper.children?.length) {
    applyBluebeamLinearChrome(live, linearStyle)
  }

  const pageIdx = live.pageIndex ?? 0
  const mod = vm.annotation?.measureAnnotationModule
  if (linearStyle.thickness != null) {
    try { mod?.modifyInCollection?.('thickness', pageIdx, live, false) } catch (_) {}
  }
  if (linearStyle.strokeColor) {
    try { mod?.modifyInCollection?.('strokeColor', pageIdx, live, false) } catch (_) {}
  }
  if (linearStyle.leaderLength != null) {
    try { mod?.modifyInCollection?.('leaderHeight', pageIdx, live, false) } catch (_) {}
  }
  try { mod?.modifyInCollection?.('lineHeadStartStyle', pageIdx, live, false) } catch (_) {}
  try { mod?.modifyInCollection?.('lineHeadEndStyle', pageIdx, live, false) } catch (_) {}
  try { vm.annotation?.renderAnnotations?.(pageIdx, null, null, null, null, false) } catch (_) {}
  try { vm.renderDrawing?.() } catch (_) {}
  forceMeasureStrokeOnDom(live, vm, linearStyle.thickness, linearStyle.strokeColor)
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

function patchMeasureAnnotationLabel(annot, userPt, pdfScale, fontColor = '#111827', thicknessOverride, arrowStyle, linearLineMode = 'simple') {
  const isLine = String(annot.shapeAnnotationType ?? annot.ShapeAnnotationType ?? '').toLowerCase() === 'distance'
    || annot.IT === 'LineDimension' || annot.it === 'LineDimension'
  const stylePatch = isLine
    ? buildLinearDistanceStyle(userPt, pdfScale, fontColor, thicknessOverride, arrowStyle, linearLineMode)
    : buildMeasureLabelPatch(userPt, pdfScale, fontColor)
  const patch = { ...annot, ...stylePatch }
  // Mirror lowercase → uppercase so vm.annotation.editAnnotation stores the new value.
  // Without this, ...live spreads Thickness: OLD which editAnnotation re-renders with old stroke.
  if (stylePatch.thickness != null) patch.Thickness = stylePatch.thickness
  if (stylePatch.leaderLength != null) patch.LeaderLength = stylePatch.leaderLength
  return patch
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
  styleEditTargetId = null,
  onAnnotationSelect,
  onMeasurementThicknessChange, // (dbItemId, thickness, annotId?) => void — persist thickness to pointsJson
  resolveMeasurementDbId,       // (annotId) => db row id | null — includes in-flight pending save
  getProtectedAnnotIds,       // () => Set of DB-persisted annotation IDs (safe from Clear)
  onClearPending,             // () => Promise<boolean> — clear active pending measurement
  measureReleaseRef,          // ref — parent calls .current(id) to allow re-save after API failure
}) {
  const viewerRef   = useRef(null)
  const containerRef = useRef(null)
  const pageMetaRef = useRef(null)
  const [pdfBase64, setPdfBase64]       = useState(null)
  const [loading,   setLoading]       = useState(false)
  const [errorMsg,  setErrorMsg]      = useState(null)
  const [viewerSize, setViewerSize]   = useState({ w: 0, h: 0 })
  const [docLoaded,  setDocLoaded]    = useState(false)
  // True while Syncfusion's pdfium WASM is parsing/rendering the document (fetch done, page not yet visible)
  const [docRendering, setDocRendering] = useState(false)
  const [countMarkers, setCountMarkers] = useState([])  // [{id, xPct, yPct, page, label}]
  const [fallbackLabelLayout, setFallbackLabelLayout] = useState([])
  const [fallbackLabelTick, setFallbackLabelTick] = useState(0)
  const [liveDrawLabel, setLiveDrawLabel] = useState(null)
  const [canvasSelectionTick, setCanvasSelectionTick] = useState(0)
  const countMarkersRef = useRef([])
  const fallbackLabelRafRef = useRef(null)
  const liveDrawRafRef = useRef(null)
  const prevUrlRef  = useRef(null)
  const pageTextByPageRef = useRef({})
  const firstRenderDoneRef = useRef(false)
  const fitPassRef = useRef(0)

  const {
    pdfScale, pdfPage, setPdfPage, setPdfTotalPages, setPdfScale,
    pdfCommand, clearPdfCommand,
    measureColor, lineThickness, fillOpacity,
    lineStyle, arrowStyle, linearLineMode, fontSize,
    measureLabelFontSize, activeUnit,
    setCountSession,
    selectedMemberScheduleItem, lastMeasureMember,
    measurementClipboard, setPasteAnchor, pasteAnchor, clearPasteAnchor,
    takeoffItems,
  } = useAppStore()
  const activeMeasureMember = selectedMemberScheduleItem ?? lastMeasureMember
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

  // Keep countMarkers ref in sync and update the store's countSession badge
  useEffect(() => {
    countMarkersRef.current = countMarkers
    setCountSession(countMarkers.filter(m => m.page === pdfPage).length)
  }, [countMarkers, pdfPage, setCountSession])

  // Reset count markers when drawing changes
  useEffect(() => {
    setCountMarkers([])
    setCountSession(0)
    setFallbackLabelLayout([])
  }, [drawingUrl, setCountSession])

  // Track Syncfusion WASM/parse phase: show rendering overlay between fetch-complete and documentLoad
  useEffect(() => {
    if (pdfBase64 && !docLoaded) {
      setDocRendering(true)
    } else {
      setDocRendering(false)
    }
  }, [pdfBase64, docLoaded])

  const bumpFallbackLabelLayout = useCallback(() => {
    setFallbackLabelTick(t => t + 1)
  }, [])

  const clearLiveDrawLabel = useCallback(() => {
    setLiveDrawLabel(null)
  }, [])

  useEffect(() => {
    clearLiveDrawLabelFn = clearLiveDrawLabel
    return () => { clearLiveDrawLabelFn = null }
  }, [clearLiveDrawLabel])

  const updateLiveDrawLabelFromAnnot = useCallback((annot) => {
    const vm = viewerRef.current
    const container = containerRef.current
    if (!vm || !container || !annot) {
      clearLiveDrawLabel()
      return
    }
    const { activeTool: tool, measureColor: storeColor } = useAppStore.getState()
    if (!CONTINUOUS_MEASURE_TOOLS.has(tool)) {
      clearLiveDrawLabel()
      return
    }
    const id = annot.annotationId ?? annot.name ?? annot.AnnotName
    if (id && processedAnnotsRef.current.has(id)) {
      clearLiveDrawLabel()
      return
    }
    const live = id ? resolveLiveAnnotation(vm, id) : null
    const source = live ?? annot
    if (live) hideSyncfusionNativeMeasureLabelText(live)

    const displayUnit = useAppStore.getState().activeUnit
      ?? getCalibratedDrawing(drawingRef)?.calibrationUnit ?? 'Mm'
    const d = getCalibratedDrawing(drawingRef)
    const mod = vm.annotation?.measureAnnotationModule
    if (mod && id) {
      if (d?.isCalibrated && d.scaleRatio > 0) {
        registerAnnotationScaleRatio(mod, id, d, displayUnit)
      } else {
        registerUncalibratedScaleForAnnotation(mod, id, displayUnit)
      }
    }

    const pts = extractAnnotationPoints(source)
    let px = polylineLength(pts)
    if (px < 0.1) px = extractPixelLengthFromAnnot(source, px)
    if (px < 0.1) {
      clearLiveDrawLabel()
      return
    }

    let len = lengthFromPdfPoints(px, displayUnit)
    if ((len == null || !Number.isFinite(len) || len <= 0) && d?.isCalibrated && d.scaleRatio > 0) {
      len = pixelsToReal(px, d.scaleRatio, displayUnit)
    }
    if (len == null || !Number.isFinite(len) || len <= 0) {
      const fb = resolveUncalibratedMeasureLength(px, source, displayUnit)
      if (fb != null && Number.isFinite(fb) && fb > 0) len = fb
    }
    if (len == null || !Number.isFinite(len) || len <= 0) {
      clearLiveDrawLabel()
      return
    }

    const pageIndex = resolveAnnotationPageIndex(source, annot)
    suppressNativeMeasureLabelsOnPage(vm, pageIndex)
    let pos = getMeasureLabelScreenPosition(live, source, pageIndex, vm, container)
    if (!pos) pos = getPositionFromDiagramPoints(pts, pageIndex, vm, container, MEASURE_LABEL_GAP_PX)
    if (!pos) return

    const color = resolveMeasurementColor({ annot: source, storeColor })
    const { selectedMemberScheduleItem: selMember, lastMeasureMember: lastMember } = useAppStore.getState()
    const activeMemberForLabel = selMember ?? lastMember
    const liveMark = String(activeMemberForLabel?.mark ?? '').trim()
    setLiveDrawLabel({
      key: id ?? 'live-draw',
      left: pos.left,
      top: pos.top,
      mark: liveMark,
      text: formatMeasureLength(len, displayUnit),
      color,
    })
  }, [clearLiveDrawLabel])

  const scheduleLiveDrawLabel = useCallback((annot) => {
    if (liveDrawRafRef.current) cancelAnimationFrame(liveDrawRafRef.current)
    liveDrawRafRef.current = requestAnimationFrame(() => {
      liveDrawRafRef.current = null
      updateLiveDrawLabelFromAnnot(annot)
    })
  }, [updateLiveDrawLabelFromAnnot])

  useEffect(() => {
    if (!CONTINUOUS_MEASURE_TOOLS.has(activeTool)) clearLiveDrawLabel()
  }, [activeTool, clearLiveDrawLabel])

  const applyFitWidth = useCallback(() => {
    const containerW = containerRef.current?.clientWidth
    applyFitWidthToViewer(viewerRef.current, setPdfScale, containerW, pageMetaRef.current)
  }, [setPdfScale])

  // Two-pass fit: first pageRenderComplete fits, second finalizes after retile.
  // Every subsequent call (scroll/zoom-triggered virtual renders) repaints annotation overlays.
  const handlePageRenderComplete = useCallback(() => {
    const vm = viewerRef.current
    if (!vm) return
    const pass = fitPassRef.current
    console.log(`[SF-Render] pageRenderComplete pass=${pass} zoom=${getMagnification(vm)?.zoomFactor?.toFixed(3) ?? '?'}`)
    if (pass === 0) {
      fitPassRef.current = 1
      applyFitWidth()
      return
    }
    if (pass === 1) {
      fitPassRef.current = 2
      finalizeViewerLayout(vm, containerRef.current?.clientWidth)
      const meta = pageMetaRef.current
      const mag = getMagnification(vm)
      if (meta && mag?.zoomFactor) {
        alignPageInViewer(vm, meta.width, mag.zoomFactor)
      }
      firstRenderDoneRef.current = true
      return
    }
    // Scroll/zoom-triggered re-renders: repaint annotation canvas overlay for the
    // newly rendered page so measurements stay visible as the user scrolls.
    try { vm.renderDrawing?.() } catch (_) {}
  }, [applyFitWidth])

  const updateFallbackMeasureLabels = useCallback(() => {
    // Skip while any measurement-complete timers are pending — avoids interfering
    // with the finishMeasure → processMeasureAnnotation → autoSave chain.
    if (measureCompleteTimersRef.current.size > 0) return

    const vm = viewerRef.current
    const container = containerRef.current
    const items = annotationsRef.current ?? []

    if (!vm || !container || items.length === 0) {
      setFallbackLabelLayout(prev => prev.length > 0 ? [] : prev)
      return
    }

    const { measureLabelFontSize: labelPt, activeUnit } = useAppStore.getState()
    const displayUnit = activeUnit ?? drawingRef.current?.calibrationUnit ?? 'Mm'
    const GAP_PX = 10

    let debugLogged = false

    const layout = []
    for (const item of items) {
      if (!item.pointsJson || (item.itemType || 'Line') !== 'Line') continue
      try {
        const raw = JSON.parse(item.pointsJson)
        const id = raw.AnnotName ?? raw.annotationId ?? raw.name

        const text = resolveTakeoffLabelText(item, displayUnit)
        if (!text || /nan/i.test(text)) continue

        const mark = String(item.mark ?? '').trim()
        if (/^nan$/i.test(mark)) continue

        const pageIndex = resolveAnnotationPageIndex(raw, raw)
        const live = id ? resolveLiveAnnotation(vm, id) : null
        const pts = collectMeasureLinePoints(live, raw)
        if (pts.length < 2) continue

        let p0, pN

        // Tier 1: Direct DOM query — find annotation's <g id="annotId"> in the canvas SVG
        // and read actual <line> endpoints via getScreenCTM(). This uses the exact same
        // transform matrix Syncfusion applies when drawing the line, immune to coordinate-
        // system ambiguities between PDF points and diagram pixel space.
        if (id) {
          try {
            const annotEl = document.getElementById(id)
            if (annotEl && annotEl.ownerSVGElement) {
              const visual = extractVisibleLineScreenEndpoints(annotEl, container)
              if (visual) {
                p0 = visual.p0
                pN = visual.p1
              }
            }
          } catch (_) {}
        }

        // Tier 2: PDF coordinate mapping — converts stored vertexPoints through current
        // page scale and position (zoom/pan aware). This is the original working approach.
        if (!p0 || !pN) {
          p0 = pdfPointToContainerCoords(pts[0].x, pts[0].y, pageIndex, vm, container)
          pN = pdfPointToContainerCoords(pts[pts.length - 1].x, pts[pts.length - 1].y, pageIndex, vm, container)
        }

        if (!p0 || !pN) continue

        const midLeft = (p0.left + pN.left) / 2
        const midTop  = (p0.top  + pN.top)  / 2

        const dx = pN.left - p0.left
        const dy = pN.top  - p0.top
        const rawAngle = Math.atan2(dy, dx) * 180 / Math.PI
        // Normalize to keep text right-side up
        const angle = rawAngle > 90 ? rawAngle - 180 : rawAngle < -90 ? rawAngle + 180 : rawAngle

        // Debug: log coordinate transform details for the first measurement
        if (!debugLogged) {
          debugLogged = true
          const midPdfX = (pts[0].x + pts[pts.length - 1].x) / 2
          const midPdfY = (pts[0].y + pts[pts.length - 1].y) / 2
          const pageEl = resolvePdfPageElement(vm, pageIndex)
          const pageRect = pageEl?.getBoundingClientRect()
          const cRect = container.getBoundingClientRect()
          const svScroll = vm.viewerBase?.viewerContainer
          console.log('[BT-Label] coord-debug', {
            mark: mark || '(none)', id,
            pdf: { startX: pts[0].x, startY: pts[0].y, endX: pts[pts.length-1].x, endY: pts[pts.length-1].y },
            midPdf: { x: midPdfX, y: midPdfY },
            p0, pN,
            midScreen: { left: midLeft, top: midTop },
            zoom: useAppStore.getState().pdfScale,
            pageIndex,
            pageRect: pageRect ? { left: pageRect.left, top: pageRect.top, w: pageRect.width, h: pageRect.height } : null,
            containerRect: { left: cRect.left, top: cRect.top, w: cRect.width, h: cRect.height },
            scrollTop: svScroll?.scrollTop ?? 0,
            scrollLeft: svScroll?.scrollLeft ?? 0,
          })
        }

        layout.push({
          key: id ?? `item-${item.id}`,
          left: midLeft,
          top: midTop,
          angle,
          gap: GAP_PX,
          mark,
          text,
          color: resolveMeasurementColor({ item, raw }),
          fontSizePt: labelPt,
        })
      } catch (_) {}
    }

    setFallbackLabelLayout(layout)
  }, [])

  const scheduleFallbackLabelLayout = useCallback(() => {
    if (fallbackLabelRafRef.current) cancelAnimationFrame(fallbackLabelRafRef.current)
    fallbackLabelRafRef.current = requestAnimationFrame(() => {
      fallbackLabelRafRef.current = null
      updateFallbackMeasureLabels()
    })
  }, [updateFallbackMeasureLabels])

  const scheduleLabelLayoutWithRetries = useCallback(() => {
    scheduleFallbackLabelLayout()
    setTimeout(scheduleFallbackLabelLayout, 250)
    setTimeout(scheduleFallbackLabelLayout, 700)
    setTimeout(scheduleFallbackLabelLayout, 1500)
  }, [scheduleFallbackLabelLayout])

  useEffect(() => {
    scheduleMeasureLabelLayoutFn = scheduleLabelLayoutWithRetries
    return () => { scheduleMeasureLabelLayoutFn = null }
  }, [scheduleLabelLayoutWithRetries])

  useEffect(() => {
    getPageMetaForCoords = () => pageMetaRef.current
    return () => { getPageMetaForCoords = () => null }
  }, [])

  // CSS safety net: suppress all Syncfusion annotation-canvas text elements.
  // Custom React overlay (fallbackLabelLayout) is the sole visible label renderer.
  useEffect(() => {
    const style = document.createElement('style')
    style.id = 'bt-suppress-sf-measure-labels'
    style.textContent = [
      '[id*="_annotationCanvas_"] text,',
      '[id*="_annotationCanvas_"] tspan,',
      '[id*="_diagram_"] text,',
      '[id*="_diagram_"] tspan {',
      '  visibility: hidden !important;',
      '  opacity: 0 !important;',
      '  pointer-events: none !important;',
      '}',
    ].join('\n')
    if (!document.getElementById('bt-suppress-sf-measure-labels')) {
      document.head.appendChild(style)
    }
    return () => document.getElementById('bt-suppress-sf-measure-labels')?.remove()
  }, [])

  useEffect(() => {
    scheduleFallbackLabelLayout()
  }, [scheduleFallbackLabelLayout, fallbackLabelTick, viewerSize, pdfScale, docLoaded, annotations])

  useEffect(() => {
    if (!docLoaded) return
    const vm = viewerRef.current
    const scrollEl = vm?.viewerBase?.viewerContainer
      ?? document.getElementById('sfPdfViewer_viewerContainer')
    if (!scrollEl) return

    let scrollEndTimer = null

    // Scroll handler: update label positions immediately via RAF, then schedule
    // blank-page recovery 300ms after scrolling stops.
    const onScroll = () => {
      scheduleFallbackLabelLayout()
      if (scrollEndTimer) clearTimeout(scrollEndTimer)
      scrollEndTimer = setTimeout(() => {
        scrollEndTimer = null
        recoverBlankVisiblePages(viewerRef.current)
      }, 300)
    }

    const onMove = () => scheduleFallbackLabelLayout()

    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onMove)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onMove) : null
    if (ro && containerRef.current) ro.observe(containerRef.current)
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onMove)
      ro?.disconnect()
      if (fallbackLabelRafRef.current) cancelAnimationFrame(fallbackLabelRafRef.current)
      if (scrollEndTimer) clearTimeout(scrollEndTimer)
    }
  }, [docLoaded, scheduleFallbackLabelLayout])

  // ── Refs — must be declared before any useEffect that uses them ────────
  // Keep latest drawing + callbacks in refs so stable Syncfusion callbacks
  // always read fresh values without being recreated.
  const drawingRef          = useRef(drawing)
  const onMeasureRef        = useRef(onMeasure)
  const onAnnotationsBlobRef = useRef(onAnnotationsBlob)
  const getProtectedAnnotIdsRef = useRef(getProtectedAnnotIds)
  useEffect(() => { drawingRef.current = normalizeDrawing(drawing) }, [drawing])
  useEffect(() => { onMeasureRef.current         = onMeasure        }, [onMeasure])
  useEffect(() => { onAnnotationsBlobRef.current = onAnnotationsBlob }, [onAnnotationsBlob])
  useEffect(() => { getProtectedAnnotIdsRef.current = getProtectedAnnotIds }, [getProtectedAnnotIds])
  const onMeasurementThicknessChangeRef = useRef(onMeasurementThicknessChange)
  useEffect(() => { onMeasurementThicknessChangeRef.current = onMeasurementThicknessChange }, [onMeasurementThicknessChange])
  const resolveMeasurementDbIdRef = useRef(resolveMeasurementDbId)
  useEffect(() => { resolveMeasurementDbIdRef.current = resolveMeasurementDbId }, [resolveMeasurementDbId])
  const annotationsRef = useRef(annotations)
  useEffect(() => { annotationsRef.current = annotations }, [annotations])
  const styleEditTargetIdRef = useRef(styleEditTargetId)
  useEffect(() => { styleEditTargetIdRef.current = styleEditTargetId }, [styleEditTargetId])
  const selectedAnnotationIdRef = useRef(selectedAnnotationId)
  useEffect(() => { selectedAnnotationIdRef.current = selectedAnnotationId }, [selectedAnnotationId])
  const applyLineThicknessRef = useRef(null)
  const ensureContinuousMeasureModeRef = useRef(null)
  const applyActiveToolToViewerRef = useRef(null)

  const importedAnnotIdsRef = useRef(new Set())
  const processedAnnotsRef = useRef(new Set())
  const pendingLabelByAnnotRef = useRef(new Map())
  const lastDrawnAnnotRef = useRef(null)
  const measureCompleteTimersRef = useRef(new Map())

  const importingAnnotsRef  = useRef(false)
  const importedDrawingRef  = useRef(null)
  const importCompletedRef  = useRef(false)
  const explicitGridSelectRef = useRef(false)
  const pasteStyleRef = useRef(null)
  const pastePlacementRef = useRef(null)
  const pasteCommitInProgressRef = useRef(null)
  const [pastePlacementActive, setPastePlacementActive] = useState(false)
  const [pasteCursorPos, setPasteCursorPos] = useState(null) // {left,top} container-relative px
  const [pasteAnchorScreen, setPasteAnchorScreen] = useState(null)
  const suppressStyleSelectRef = useRef(null)
  const annotationsSyncKeyRef = useRef('')
  const importedTakeoffIdsRef = useRef(new Set())
  const blobFallbackImportedRef = useRef(false)

  useEffect(() => {
    importedAnnotIdsRef.current = new Set()
    processedAnnotsRef.current = new Set()
    pendingLabelByAnnotRef.current = new Map()
    importedDrawingRef.current = null
    importCompletedRef.current = false
    annotationsSyncKeyRef.current = ''
    importedTakeoffIdsRef.current = new Set()
    blobFallbackImportedRef.current = false
    measureCompleteTimersRef.current.forEach(t => clearTimeout(t))
    measureCompleteTimersRef.current.clear()
    pastePlacementRef.current = null
    setPastePlacementActive(false)
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
        const id = raw.AnnotName ?? raw.annotationId ?? raw.uniqueKey ?? raw.name
        if (id) processedAnnotsRef.current.add(id)
      } catch (_) {}
    })
  }, [drawing?.id, annotations])

  // Sync diagram labels + linear visual style when takeoff rows are loaded (not on toolbar changes)
  useEffect(() => {
    if (!docLoaded || !annotations?.length) return
    const syncKey = annotations.map(a => a.id).join(',')
    if (annotationsSyncKeyRef.current === syncKey) return
    annotationsSyncKeyRef.current = syncKey

    const vm = viewerRef.current
    if (!vm) return
    hydrateTakeoffItemsOnViewer(vm, annotations, pdfScale)
    setTimeout(() => {
      hydrateTakeoffLabelsOnViewer(vm, annotations, pdfScale)
      scheduleLabelLayoutWithRetries()
    }, 500)
  }, [docLoaded, annotations, pdfScale, scheduleLabelLayoutWithRetries])

  // Keep selectedAnnotDataRef in sync when user picks a row from the grid
  useEffect(() => {
    if (!selectedAnnotationId || !annotations?.length || !docLoaded) return
    const item = annotations.find(t => t.id === selectedAnnotationId)
    const annotId = parseAnnotIdFromPointsJson(item?.pointsJson)
    if (!annotId) return
    const vm = viewerRef.current
    const live = vm ? resolveLiveAnnotation(vm, annotId) : null
    if (live) selectedAnnotDataRef.current = live
    else if (item?.pointsJson) {
      try { selectedAnnotDataRef.current = JSON.parse(item.pointsJson) } catch (_) {}
    }
    setCanvasSelectionTick(t => t + 1)
  }, [selectedAnnotationId, annotations, docLoaded])

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
    const stableId = resolveStableAnnotationId(a)
    let start = a.start ?? a.Start
    let end = a.end ?? a.End
    const shapeType = String(a.shapeAnnotationType ?? a.ShapeAnnotationType ?? 'Distance').toLowerCase()
    const it = String(a.IT ?? a.it ?? 'LineDimension')
    const normalizedType = shapeType === 'distance' || it === 'LineDimension' ? 'Line'
      : shapeType === 'area' || it === 'PolyLineDimension' || it === 'Area' ? 'Area'
      : shapeType === 'perimeter' || it === 'Perimeter' ? 'Perimeter'
      : (a.type ?? 'Line')
    const { measureColor: storeColor, lineThickness: toolbarThick } = useAppStore.getState()
    const strokeColor = resolveMeasurementColor({ storeColor, annot: a })
    const thickVal = Number(toolbarThick) > 0 ? Number(toolbarThick) : (a.thickness ?? a.Thickness ?? 2)
    const r = parseInt(strokeColor.slice(1, 3), 16) || 239
    const g = parseInt(strokeColor.slice(3, 5), 16) || 35
    const b = parseInt(strokeColor.slice(5, 7), 16) || 60
    return {
      annotationId:        stableId,
      name:                stableId,
      AnnotName:           a.AnnotName ?? a.annotName ?? stableId,
      type:                normalizedType,
      IT:                  a.IT ?? a.it ?? 'LineDimension',
      shapeAnnotationType: a.shapeAnnotationType ?? a.ShapeAnnotationType ?? 'Distance',
      pageNumber:          a.pageNumber ?? a.PageNumber ?? (parseInt(a.page ?? '0', 10) + 1),
      page:                String(a.page != null ? parseInt(a.page, 10) : ((a.pageNumber ?? a.PageNumber ?? 1) - 1)),
      strokeColor,
      StrokeColor:         strokeColor,
      fillColor:           a.fillColor ?? a.FillColor ?? `rgba(${r},${g},${b},0.15)`,
      thickness:           thickVal,
      Thickness:           thickVal,
      opacity:             a.opacity ?? a.Opacity ?? 1,
      measurementValue:    extractMeasurementValue(a),
      Note:                a.Note ?? a.note ?? a.notes,
      note:                a.note ?? a.notes ?? a.Note,
      notes:               a.notes ?? a.note ?? a.Note,
      Caption:             a.Caption ?? a.caption ?? true,
      caption:             a.caption ?? a.Caption ?? true,
      LeaderLength:        a.LeaderLength ?? a.leaderLength ?? a.leaderHeight,
      leaderLength:        a.leaderLength ?? a.leaderHeight ?? a.LeaderLength,
      labelContent:        a.labelContent ?? a.LabelContent,
      LabelContent:        a.LabelContent ?? a.labelContent,
      label:               a.label ?? a.text,
      text:                a.text ?? a.label,
      Calibrate:           a.Calibrate ?? a.calibrate,
      calibrate:           a.calibrate ?? a.Calibrate,
      lineHeadStartStyle: a.lineHeadStartStyle ?? a.LineHeadStartStyle,
      lineHeadEndStyle: a.lineHeadEndStyle ?? a.LineHeadEndStyle,
      fontSize: a.fontSize ?? a.FontSize,
      FontSize: a.FontSize ?? a.fontSize,
      labelSettings: a.labelSettings ?? a.LabelSettings,
      leaderLength: a.leaderLength ?? a.LeaderLength,
      leaderLineExtension: a.leaderLineExtension ?? a.LeaderLineExtension,
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
    if (measureCompleteTimersRef.current.size > 0) return
    if (pasteCommitInProgressRef.current) return
    try {
      const displayUnit = getDisplayUnit()
      patchAllLiveMeasureAnnotationsForExport(vm, displayUnit)
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
    const d = getCalibratedDrawing(drawingRef)
    return useAppStore.getState().activeUnit ?? d?.calibrationUnit ?? 'Mm'
  }, [])

  /** Syncfusion native unit (Inch when uncalibrated; active unit when calibrated). */
  const applyMeasureDisplayUnitToViewer = useCallback((vm) => {
    if (!vm) return
    const d = getCalibratedDrawing(drawingRef)
    const key = useAppStore.getState().activeUnit ?? d?.calibrationUnit ?? 'Mm'
    const sfUnit = toSfUnit(key)
    const patch = { displayUnit: sfUnit, conversionUnit: sfUnit }
    try {
      vm.measurementSettings = { ...(vm.measurementSettings ?? {}), ...patch }
    } catch (_) {}
    ;['Distance', 'Area', 'Perimeter'].forEach(type => {
      try { vm.annotation.updateMeasurementSettings(type, patch) } catch (_) {}
    })
    if (!d?.isCalibrated || !(d.scaleRatio > 0)) {
      applyUncalibratedMeasureRatioToViewer(vm, key)
    }
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
    const d = getCalibratedDrawing(drawingRef)
    if (!vm) return
    ensureMeasureScaleUi(vm)
    applyMeasureDisplayUnitToViewer(vm)
    traceCalibration('viewer.applyCalibration', calibrationSnapshot(d))
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
  }, [ensureMeasureScaleUi, measureLabelFontSize, pdfScale, applyMeasureDisplayUnitToViewer])

  /** Bluebeam-style: after each measurement, deselect and re-enter draw mode for the active tool. */
  const ensureContinuousMeasureMode = useCallback(() => {
    const vm = viewerRef.current
    if (!vm) return
    const {
      activeTool: tool, pdfPage: page, measureColor, measureLabelFontSize: labelPt,
      lineThickness, arrowStyle, linearLineMode, pdfScale: zoom, fillOpacity,
    } = useAppStore.getState()
    if (!CONTINUOUS_MEASURE_TOOLS.has(tool)) return
    const mode = MEASURE_MODES[tool]
    if (!mode) return

    try { vm.interactionMode = 'TextSelection' } catch (_) {}

    const sfUnit = toSfUnit(getSyncfusionNativeUnit(getCalibratedDrawing(drawingRef)))
    selectedAnnotDataRef.current = null
    const pageIdx = Math.max(0, (page ?? 1) - 1)
    try { vm.clearSelection?.(pageIdx) } catch (_) {}
    try { vm.annotation?.clearSelection?.() } catch (_) {}
    try { vm.annotation.setAnnotationMode('None') } catch (_) {}
    setTimeout(() => {
      if (tool === 'line' || tool === 'calibrate') {
        try {
          prepareMeasureAnnotationsForNextDraw(
            vm,
            useAppStore.getState().activeUnit ?? 'Mm',
            getCalibratedDrawing(drawingRef),
            importedAnnotIdsRef.current,
          )
        } catch (_) {}
        const hex = getEffectiveMeasureDrawColor()
        const r = parseInt(hex.slice(1, 3), 16) || 17
        const g = parseInt(hex.slice(3, 5), 16) || 24
        const b = parseInt(hex.slice(5, 7), 16) || 39
        try {
          vm.annotation.updateMeasurementSettings('Distance', {
            strokeColor: hex,
            fillColor: `rgba(${r},${g},${b},${Math.min(fillOpacity ?? 0.15, 0.15)})`,
            opacity: 1,
            displayUnit: sfUnit,
            conversionUnit: sfUnit,
            ...buildLinearDistanceStyle(labelPt, zoom, hex, lineThickness, arrowStyle, linearLineMode),
          })
        } catch (_) {}
      }
      const d = getCalibratedDrawing(drawingRef)
      if (!d?.isCalibrated || !(d.scaleRatio > 0)) {
        applyUncalibratedMeasureRatioToViewer(vm, useAppStore.getState().activeUnit ?? 'Mm')
      }
      try { vm.annotation.setAnnotationMode(mode) } catch (_) {}
    }, 40)
  }, [])

  useEffect(() => { ensureContinuousMeasureModeRef.current = ensureContinuousMeasureMode }, [ensureContinuousMeasureMode])

  /** Apply toolbar thickness to next draw; optionally persist to selected / last-drawn line (user click only). */
  const applyLineThicknessInViewer = useCallback((thickOverride, { persist = false } = {}) => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64 || !docLoaded || activeTool !== 'line') return

    const hex = getEffectiveMeasureDrawColor()
    const safeHex = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : '#111827'
    const thick = Number(thickOverride ?? lineThickness ?? 2)
    if (!Number.isFinite(thick) || thick <= 0) return
    const r = parseInt(safeHex.slice(1, 3), 16) || 17
    const g = parseInt(safeHex.slice(3, 5), 16) || 24
    const b = parseInt(safeHex.slice(5, 7), 16) || 39

    // Always sync next-draw settings (before creation)
    try {
      vm.annotation.updateMeasurementSettings('Distance', {
        strokeColor: safeHex,
        fillColor: `rgba(${r},${g},${b},${Math.min(fillOpacity ?? 0.15, 0.15)})`,
        opacity: 1,
        thickness: thick,
        Thickness: thick,
        ...buildLinearDistanceStyle(measureLabelFontSize, pdfScale, safeHex, thick, arrowStyle, linearLineMode),
      })
    } catch (_) {}

    if (!persist) return

    editingAnnotRef.current = true
    setSkipTakeoffStyleHydrate(800)

    const currentAnnotations = annotationsRef.current
    const target = resolveActiveLinearStyleTarget(
      vm,
      selectedAnnotationIdRef.current,
      currentAnnotations,
      selectedAnnotDataRef,
      lastDrawnAnnotRef.current,
      styleEditTargetIdRef.current,
    )
    if (target) {
      try {
        applyStyleToLinearMeasurement(vm, target, safeHex, {
          measureLabelFontSize, pdfScale, lineThickness: thick, arrowStyle, linearLineMode,
          displayUnit: getDisplayUnit(),
        })
        const dbId = resolveMeasurementDbIdRef.current?.(target.annotId)
          ?? target.dbId
          ?? findTakeoffItemByAnnotId(currentAnnotations, target.annotId)?.id
        onMeasurementThicknessChangeRef.current?.(dbId ?? null, thick, target.annotId)
      } catch (_) {}
    }

    setTimeout(() => { editingAnnotRef.current = false }, 300)
  }, [
    activeTool, pdfBase64, docLoaded, measureColor, lineThickness, fillOpacity,
    measureLabelFontSize, pdfScale, arrowStyle, linearLineMode, getDisplayUnit,
  ])

  useEffect(() => { applyLineThicknessRef.current = applyLineThicknessInViewer }, [applyLineThicknessInViewer])

  // Keep next-draw thickness in sync when toolbar value changes (no DB / no existing-line edits)
  useEffect(() => {
    if (activeTool !== 'line' || !docLoaded || !pdfBase64) return
    applyLineThicknessRef.current?.(lineThickness, { persist: false })
  }, [lineThickness, activeTool, docLoaded, pdfBase64])

  const applyMeasureLabelToViewer = useCallback((annot, labelText, _numericLength, pageNumber, displayUnit) => {
    const vm = viewerRef.current
    const d = getCalibratedDrawing(drawingRef)
    if (!vm || !labelText || !annot || /nan/i.test(labelText)) return
    const annotationId = annot.annotationId ?? annot.AnnotName ?? annot.name
    if (!annotationId) return
    const live = resolveLiveAnnotation(vm, annotationId)
    if (live) hideSyncfusionNativeMeasureLabelText(live)
    const mod = vm.annotation?.measureAnnotationModule
    if (mod && d?.isCalibrated) {
      registerAnnotationScaleRatio(mod, annotationId, d, displayUnit)
    }
    const { measureColor: color, lineThickness: thick, arrowStyle: arrows, measureLabelFontSize: labelPt, linearLineMode: lineMode, pdfScale: zoom } = useAppStore.getState()
    const pasteStyle = pasteStyleRef.current
    const effectiveLabelPt = pasteStyle?.labelFontSize ?? labelPt
    const effectiveThick = pasteStyle?.thickness ?? thick
    const effectiveArrows = pasteStyle?.arrowStyle ?? arrows
    const effectiveLineMode = pasteStyle?.linearLineMode ?? lineMode ?? 'simple'
    const fontColor = pasteStyle?.color
      ?? annot.strokeColor ?? annot.StrokeColor
      ?? getEffectiveMeasureDrawColor()
      ?? color
      ?? '#111827'
    const linearStyle = buildLinearDistanceStyle(effectiveLabelPt, zoom ?? pdfScale, fontColor, effectiveThick, effectiveArrows, effectiveLineMode)
    linearStyle.strokeColor = fontColor
    const diagramStyle = buildLinearLabelDiagramStyle(effectiveLabelPt, zoom ?? pdfScale, fontColor)
    editingAnnotRef.current = true
    const finish = () => {
      try {
        const live = resolveLiveAnnotation(vm, annotationId)
        const base = live ?? annot
        const patched = patchMeasureAnnotationLabel(
          base, effectiveLabelPt, zoom ?? pdfScale, fontColor, effectiveThick, effectiveArrows, effectiveLineMode,
        )
        vm.annotation.editAnnotation({
          ...base,
          annotationId,
          name: annotationId,
          AnnotName: annotationId,
          strokeColor: fontColor,
          StrokeColor: fontColor,
          ...patched,
        })
      } catch (_) {}
      applyLinearVisualStyleToDiagram(vm, annotationId, linearStyle)
      applyCalibratedLabelToDiagram(vm, annotationId, pageNumber, labelText, fontColor, {
        ...diagramStyle,
        syncLeaderHeight: linearStyle.syncLeaderHeight ?? linearStyle.leaderLength,
        leaderLength: linearStyle.leaderLength,
        lineHeadStartStyle: linearStyle.lineHeadStartStyle,
        lineHeadEndStyle: linearStyle.lineHeadEndStyle,
      })
      pendingLabelByAnnotRef.current.set(annotationId, { pageNumber, labelText })
      scheduleLabelLayoutWithRetries()
      pasteStyleRef.current = null
      setTimeout(() => { editingAnnotRef.current = false }, 120)
      setTimeout(scheduleLabelLayoutWithRetries, 80)
      const { activeTool: tool } = useAppStore.getState()
      if (CONTINUOUS_MEASURE_TOOLS.has(tool)) {
        ensureContinuousMeasureMode()
      }
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
  }, [ensureContinuousMeasureMode, pdfScale, scheduleLabelLayoutWithRetries])

  const applyLabelToAnnot = useCallback((annot, labelText) => {
    const vm = viewerRef.current
    if (!vm || !annot) return
    const fontColor = getEffectiveMeasureDrawColor() ?? annot.strokeColor ?? annot.StrokeColor ?? '#111827'
    editingAnnotRef.current = true
    try {
      vm.annotation.editAnnotation(
        patchMeasureAnnotationLabel(annot, measureLabelFontSize, pdfScale, fontColor, lineThickness, arrowStyle, linearLineMode),
      )
    } catch (_) {}
    setTimeout(() => { editingAnnotRef.current = false }, 300)
  }, [measureColor, measureLabelFontSize, pdfScale, lineThickness, arrowStyle, linearLineMode])

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

    if (!isMeasureAnnotation(a)) {
      console.log('[BT-Lifecycle] processMeasureAnnotation — NOT a measure annotation, skipping. IT:', a?.IT, 'type:', a?.shapeAnnotationType)
      return
    }

    const annotationId = resolveStableAnnotationId(a)
    console.log('[BT-Lifecycle] processMeasureAnnotation — id:', annotationId, 'alreadyProcessed:', processedAnnotsRef.current.has(annotationId))
    if (annotationId && processedAnnotsRef.current.has(annotationId)) return

    const d = getCalibratedDrawing(drawingRef)
    const displayUnit = getDisplayUnit()

    const IT = a.IT ?? a.it ?? ''
    const shapeType = (a.shapeAnnotationType ?? a.ShapeAnnotationType ?? a.type ?? '').toLowerCase()
    const isAreaAnnotation     = IT === 'PolyLineDimension' || shapeType === 'polygon' || IT === 'Area'
    const isPerimeterAnnotation = IT === 'Perimeter'

    const pts = extractAnnotationPoints(a)

    let pixelLength = 0
    let pixelArea = 0

    if (isAreaAnnotation && pts.length >= 3) {
      pixelArea   = polygonArea(pts)
      pixelLength = computePixelPerimeter(pts)
    } else if (pts.length >= 2) {
      pixelLength = polylineLength(pts)
    }

    pixelLength = extractPixelLengthFromAnnot(a, pixelLength)
    pixelArea   = extractPixelAreaFromAnnot(a, pixelArea)

    const vmEarly = viewerRef.current
    const liveEarly = annotationId && vmEarly ? resolveLiveAnnotation(vmEarly, annotationId) : null
    if (pixelLength < 0.1 && liveEarly) {
      pixelLength = polylineLength(extractAnnotationPoints(liveEarly))
    }

    const resolved = resolveCalibratedMeasure(pixelLength, pixelArea, d, displayUnit, { isArea: isAreaAnnotation })
    let length = resolved.length ?? computeRealLengthFromDrawing(pixelLength, d, displayUnit)
    let area   = resolved.area

    if (!d?.isCalibrated || !(d.scaleRatio > 0)) {
      const vm = vmEarly
      const live = liveEarly

      if (!isAreaAnnotation && pixelLength >= 0.1) {
        const geoLen = lengthFromPdfPoints(pixelLength, displayUnit)
        if (geoLen != null && Number.isFinite(geoLen) && geoLen > 0) length = geoLen
      }

      const displayed = extractDisplayedMeasureFromAnnot(live ?? a, displayUnit)
      if ((length == null || length <= 0) && displayed.length != null && Number.isFinite(displayed.length)) {
        length = displayed.length
      }
      if (area == null && displayed.area != null && Number.isFinite(displayed.area)) area = displayed.area

      if ((length == null || length <= 0) && vm && annotationId) {
        const label = resolveLinearLabelText(vm, annotationId, null, displayUnit)
        const parsed = parseMeasureLabel(label)
        if (parsed?.value > 0 && !parsed.isArea) {
          length = parsed.unit && parsed.unit !== displayUnit
            ? convertMeasureValue(parsed.value, parsed.unit, displayUnit)
            : parsed.value
        }
      }

      if (length == null || !Number.isFinite(length) || length <= 0) {
        const fb = resolveUncalibratedMeasureLength(pixelLength, live ?? a, displayUnit)
        if (fb != null && Number.isFinite(fb) && fb > 0) length = fb
      }
    }

    const { activeTool: currentTool } = useAppStore.getState()

    traceMeasurementDebug('measure.processAnnotation', {
      drawing: d,
      pixelLength,
      pixelArea,
      displayUnit,
      resolved: { length, area, isCalibrated: resolved.isCalibrated },
      fallbackReason: length == null ? (resolved.fallbackReason ?? 'processAnnotation: length null after resolve') : null,
    })

    if (length != null && !Number.isFinite(length)) length = null
    if (!isAreaAnnotation && (length == null || length <= 0) && pixelLength >= 0.1) {
      const geo = lengthFromPdfPoints(pixelLength, displayUnit)
      if (geo != null && Number.isFinite(geo) && geo > 0) length = geo
    }
    if (!isAreaAnnotation && d?.isCalibrated && d.scaleRatio > 0 && pixelLength >= 0.1) {
      if (length == null || !Number.isFinite(length) || length <= 0) {
        const fromScale = pixelsToReal(pixelLength, d.scaleRatio, displayUnit)
        if (fromScale != null && Number.isFinite(fromScale) && fromScale > 0) length = fromScale
      }
    }

    const hasLineValue = pixelLength >= 0.1 || (length != null && Number.isFinite(length) && length > 0)
    const hasAreaValue = pixelArea >= 0.1 || (area != null && area > 0)
    console.log('[BT-Lifecycle] processMeasureAnnotation — length:', length, 'pixelLength:', pixelLength, 'hasLineValue:', hasLineValue, 'isCalibrated:', d?.isCalibrated, 'scaleRatio:', d?.scaleRatio)
    if (isAreaAnnotation) {
      if (!hasAreaValue) return
    } else if (!hasLineValue) {
      console.warn('[BT-Lifecycle] processMeasureAnnotation — BLOCKED: no line value! pixelLength:', pixelLength, 'length:', length)
      return
    }

    const pageNumber = a.pageNumber ?? a.PageNumber ?? (parseInt(a.page ?? '0', 10) + 1)
    const pageIndex = Math.max(0, pageNumber - 1)

    const activeMember = useAppStore.getState().selectedMemberScheduleItem
      ?? useAppStore.getState().lastMeasureMember
    const knownMarks = (useAppStore.getState().memberScheduleItems ?? [])
      .map(m => String(m.mark ?? m.Mark ?? '').trim())
      .filter(Boolean)
    const linePts = extractAnnotationPoints(a)
    const drawingMark = detectMarkNearMeasureLine(
      viewerRef.current,
      pageIndex,
      containerRef.current,
      linePts,
      knownMarks,
      () => getPageMetaForCoords?.() ?? null,
      pageTextByPageRef.current?.[pageIndex],
    )
    const memberMark = String(
      drawingMark || activeMember?.mark || activeMember?.Mark || '',
    ).trim()

    const measurePayload = {
      length,
      area,
      pixelLength,
      pixelArea,
      unit: displayUnit,
      points: [],
      annotationId,
      pageNumber,
      memberMark,
      drawingMark,
      memberScheduleId: activeMember?.id ?? null,
      rawAnnotation: (() => {
        const vm = viewerRef.current
        const id = annotationId
        const live = id && vm ? resolveLiveAnnotation(vm, id) : null
        let plain
        if (live) {
          plain = buildPlainAnnot(live)
          if (extractAnnotationPoints(plain).length < 2) plain = buildPlainAnnot(a)
        } else {
          plain = buildPlainAnnot(a)
        }
        if (extractAnnotationPoints(plain).length < 2) return a
        const {
          measureColor: toolbarColor,
          takeoffItems: items,
          memberScheduleItems,
          lineThickness: toolbarThick,
        } = useAppStore.getState()
        const captureColor = pasteStyleRef.current?.color
          ?? resolveDrawColorForMemberMark(memberMark, toolbarColor, items, memberScheduleItems)
        if (captureColor && /^#[0-9A-Fa-f]{6}$/.test(captureColor)) {
          plain.strokeColor = captureColor
          plain.StrokeColor = captureColor
        }
        const savedThick = Number(toolbarThick) > 0 ? Number(toolbarThick) : (plain.thickness ?? plain.Thickness ?? 2)
        plain.thickness = savedThick
        plain.Thickness = savedThick
        if (length != null && length > 0) {
          const labelText = formatMeasureLength(length, displayUnit)
          plain.notes = labelText
          plain.Note = labelText
          plain.note = labelText
          plain.labelContent = labelText
          plain.LabelContent = labelText
        }
        return plain
      })(),
      measureType: isAreaAnnotation ? 'Area' : isPerimeterAnnotation ? 'Perimeter' : 'Line',
    }

    if (currentTool === 'calibrate') {
      onMeasureRef.current?.(measurePayload)
      return
    }

    if (!d?.isCalibrated) {
      if (annotationId) processedAnnotsRef.current.add(annotationId)
      measurePayload.length = length
      measurePayload.area = area
      measurePayload.unit = displayUnit
      measurePayload.pixelLength = pixelLength
      if (annotationId && !isAreaAnnotation && memberMark) {
        const {
          measureColor: toolbarColor,
          takeoffItems: items,
          memberScheduleItems,
          lineThickness: thick,
          arrowStyle: arrows,
          linearLineMode: lineMode,
          measureLabelFontSize: labelPt,
          pdfScale: zoom,
        } = useAppStore.getState()
        const strokeColor = resolveDrawColorForMemberMark(memberMark, toolbarColor, items, memberScheduleItems)
        if (strokeColor && /^#[0-9A-Fa-f]{6}$/.test(strokeColor)) {
          try {
            const vm = viewerRef.current
            const linearStyle = buildLinearDistanceStyle(labelPt, zoom, strokeColor, thick, arrows, lineMode)
            linearStyle.strokeColor = strokeColor
            applyLinearVisualStyleToDiagram(vm, annotationId, linearStyle)
          } catch (_) {}
        }
      }
      onMeasureRef.current?.(measurePayload)
      if (annotationId && !isAreaAnnotation) {
        hideLineMeasureLabelOnViewer(viewerRef.current, annotationId)
        pendingLabelByAnnotRef.current.delete(annotationId)
      }
      return
    }

    if (annotationId) {
      processedAnnotsRef.current.add(annotationId)
      lastDrawnAnnotRef.current = annotationId
      suppressStyleSelectRef.current = annotationId
    }

    const vmForScale = viewerRef.current
    const modForScale = vmForScale?.annotation?.measureAnnotationModule
    if (annotationId && modForScale && d?.isCalibrated && d.scaleRatio > 0) {
      try { registerAnnotationScaleRatio(modForScale, annotationId, d, displayUnit) } catch (_) {}
    }

    if (annotationId && !isAreaAnnotation && memberMark) {
      const {
        measureColor: toolbarColor,
        takeoffItems: items,
        memberScheduleItems,
        lineThickness: thick,
        arrowStyle: arrows,
        linearLineMode: lineMode,
        measureLabelFontSize: labelPt,
        pdfScale: zoom,
      } = useAppStore.getState()
      const strokeColor = resolveDrawColorForMemberMark(memberMark, toolbarColor, items, memberScheduleItems)
      if (strokeColor && /^#[0-9A-Fa-f]{6}$/.test(strokeColor)) {
        try {
          const vm = viewerRef.current
          const linearStyle = buildLinearDistanceStyle(labelPt, zoom, strokeColor, thick, arrows, lineMode)
          linearStyle.strokeColor = strokeColor
          applyLinearVisualStyleToDiagram(vm, annotationId, linearStyle)
        } catch (_) {}
      }
    }

    console.log('[BT-Lifecycle] processMeasureAnnotation — calling onMeasureRef with payload, length:', measurePayload.length, 'unit:', measurePayload.unit)
    onMeasureRef.current?.(measurePayload)
    if (annotationId && !isAreaAnnotation) {
      hideLineMeasureLabelOnViewer(viewerRef.current, annotationId)
      pendingLabelByAnnotRef.current.delete(annotationId)
    }
  }, [getDisplayUnit, ensureContinuousMeasureMode])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { processMeasureRef.current = processMeasureAnnotation }, [processMeasureAnnotation])

  const cancelPastePlacement = useCallback(() => {
    pastePlacementRef.current = null
    setPastePlacementActive(false)
    setPasteCursorPos(null)
  }, [])

  const commitPasteLinearMeasurement = useCallback((clipboard, offsetX, offsetY, targetPage, pasteAnchor = null) => {
    const vm = viewerRef.current
    if (!vm || !(clipboard?.copyJson ?? clipboard?.raw)) return false

    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
      toast.error('Could not paste — invalid placement offset')
      return false
    }

    pasteStyleRef.current = {
      color: clipboard.color,
      category: clipboard.category,
      thickness: clipboard.thickness,
      labelFontSize: clipboard.labelFontSize,
      arrowStyle: clipboard.arrowStyle,
      linearLineMode: clipboard.linearLineMode,
    }

    const sourceRaw = clipboard.copyJson ?? clipboard.raw
    const pageIndexNum = Math.max(0, targetPage - 1)
    const container = containerRef.current
    const pastedPts = pasteAnchor && container
      ? computePastedVertexPoints(sourceRaw, pasteAnchor, pageIndexNum, vm, container)
      : null
    const cloned = pastedPts?.length >= 2
      ? cloneLinearAnnotationForPaste(sourceRaw, 0, 0, targetPage, pastedPts)
      : cloneLinearAnnotationForPaste(sourceRaw, offsetX, offsetY, targetPage)
    if (!cloned) {
      pasteStyleRef.current = null
      toast.error('Could not paste — invalid line geometry')
      return false
    }

    const stylePatch = buildLinearDistanceStyle(
      clipboard.labelFontSize,
      pdfScale,
      clipboard.color,
      clipboard.thickness,
      clipboard.arrowStyle,
      clipboard.linearLineMode,
    )
    Object.assign(cloned, stylePatch, {
      strokeColor: clipboard.color,
      StrokeColor: clipboard.color,
      Thickness: clipboard.thickness,
      thickness: clipboard.thickness,
    })

    if (targetPage !== pdfPage) {
      try { vm.navigation.goToPage(targetPage) } catch (_) {}
    }
    try { vm.annotation.setAnnotationMode('None') } catch (_) {}

    const pageIdx = String(targetPage - 1)
    const newId = cloned.annotationId

    const ptsForSave = extractAnnotationPoints(cloned)
    const pxLen = polylineLength(ptsForSave)
    const rawAnnotForSave = {
      annotationId: newId,
      AnnotName: newId,
      name: newId,
      shapeAnnotationType: 'Distance',
      ShapeAnnotationType: 'Distance',
      IT: 'LineDimension',
      type: 'Line',
      pageNumber: targetPage,
      page: pageIdx,
      vertexPoints: ptsForSave,
      VertexPoints: ptsForSave.map(p => ({ X: p.x, Y: p.y })),
      strokeColor: clipboard.color,
      StrokeColor: clipboard.color,
      thickness: clipboard.thickness,
      Thickness: clipboard.thickness,
      FontSize: stylePatch.fontSize,
      fontSize: stylePatch.fontSize,
      LeaderLength: stylePatch.leaderLength,
      leaderLength: stylePatch.leaderLength,
      LeaderLineExtension: stylePatch.leaderLineExtension,
      leaderLineExtension: stylePatch.leaderLineExtension,
      LineHeadStart: stylePatch.lineHeadStartStyle ?? 'None',
      lineHeadStartStyle: stylePatch.lineHeadStartStyle ?? 'None',
      LineHeadEnd: stylePatch.lineHeadEndStyle ?? 'None',
      lineHeadEndStyle: stylePatch.lineHeadEndStyle ?? 'None',
      labelSettings: stylePatch.labelSettings,
      Calibrate: cloned.Calibrate ?? cloned.calibrate,
      calibrate: cloned.calibrate ?? cloned.Calibrate,
      start: ptsForSave.length >= 2 ? `${ptsForSave[0].x},${ptsForSave[0].y}` : '',
      end: ptsForSave.length >= 2 ? `${ptsForSave[ptsForSave.length - 1].x},${ptsForSave[ptsForSave.length - 1].y}` : '',
    }

    const fakeItem = {
      id: newId,
      itemType: 'Line',
      color: clipboard.color,
      category: clipboard.category ?? 'General',
      length: clipboard.length,
      unit: clipboard.unit,
      pointsJson: JSON.stringify(rawAnnotForSave),
    }
    const builtClone = buildImportableFromTakeoffItem(fakeItem, measureLabelFontSize, pdfScale)
    if (!builtClone) {
      pasteStyleRef.current = null
      toast.error('Could not paste — invalid geometry after offset')
      return false
    }
    const displayUnit = getDisplayUnit()
    const d = getCalibratedDrawing(drawingRef)
    const clonedImportable = sanitizeLinearMeasureShape({
      ...builtClone.importable,
      ShapeAnnotationType: 'Distance',
      shapeAnnotationType: 'Distance',
      IT: 'LineDimension',
      AnnotName: newId,
      name: newId,
      ModifiedDate: getSyncfusionViewerModifiedDate(vm),
      CreationDate: getSyncfusionViewerModifiedDate(vm),
      State: '',
      StateModel: '',
      Author: 'BuildTakeoff',
      Subject: 'Distance calculation',
    }, displayUnit, d)

    const pageIndex = targetPage - 1
    pasteCommitInProgressRef.current = newId
    importingAnnotsRef.current = true
    importedAnnotIdsRef.current.add(newId)
    processedAnnotsRef.current.add(newId)

    try {
      if (!renderLinearMeasurementOnViewer(vm, clonedImportable, pageIndex, displayUnit, d)) {
        throw new Error('renderLinearMeasurementOnViewer failed')
      }
      const liveRendered = resolveLiveAnnotation(vm, newId)
        ?? resolveLiveAnnotationByPoints(vm, clonedImportable)
      const liveId = liveRendered ? resolveStableAnnotationId(liveRendered) : null
      if (liveId) {
        importedAnnotIdsRef.current.add(liveId)
        processedAnnotsRef.current.add(liveId)
      }
      try {
        patchLiveLinearMeasureIntegrity(vm, newId, clonedImportable, pageIndex)
        if (liveId && liveId !== newId) {
          patchLiveLinearMeasureIntegrity(vm, liveId, clonedImportable, pageIndex)
        }
        prepareMeasureAnnotationsForNextDraw(vm, displayUnit, d, importedAnnotIdsRef.current)
      } catch (_) {}
      const mod = vm.annotation?.measureAnnotationModule
      try {
        if (mod && d?.isCalibrated) {
          registerAnnotationScaleRatio(mod, newId, d, displayUnit)
        }
      } catch (_) {}
    } catch (err) {
      console.error('[BuildTakeoff] paste render failed:', err)
      importingAnnotsRef.current = false
      pasteCommitInProgressRef.current = null
      pasteStyleRef.current = null
      importedAnnotIdsRef.current.delete(newId)
      processedAnnotsRef.current.delete(newId)
      toast.error('Paste failed')
      return false
    }

    let pasteFinalized = false
    setTimeout(() => {
      try {
        const pageIndexNum = targetPage - 1
        const finalizePasteCommit = () => {
          if (pasteFinalized) return
          pasteFinalized = true

          try {
            prepareMeasureAnnotationsForNextDraw(
              vm, getDisplayUnit(), getCalibratedDrawing(drawingRef), importedAnnotIdsRef.current,
            )
          } catch (_) {}

          const liveAfter = resolveLiveAnnotation(vm, newId)
          const finalPts = liveAfter?.vertexPoints?.length >= 2
            ? liveAfter.vertexPoints.map(p => ({
              x: Number(p.x ?? p.X) || 0,
              y: Number(p.y ?? p.Y) || 0,
            }))
            : ptsForSave

          const finalRawAnnot = {
            ...rawAnnotForSave,
            vertexPoints: finalPts,
            VertexPoints: finalPts.map(p => ({ X: p.x, Y: p.y })),
            start: finalPts.length >= 2 ? `${finalPts[0].x},${finalPts[0].y}` : '',
            end: finalPts.length >= 2
              ? `${finalPts[finalPts.length - 1].x},${finalPts[finalPts.length - 1].y}`
              : '',
          }

          const pastePayload = {
            length: clipboard.length,
            area: null,
            pixelLength: pxLen > 0 ? pxLen : 1,
            pixelArea: 0,
            unit: clipboard.unit ?? getDisplayUnit(),
            points: [],
            annotationId: newId,
            pageNumber: targetPage,
            memberMark: '',
            drawingMark: null,
            memberScheduleId: null,
            rawAnnotation: {
              ...finalRawAnnot,
              Calibrate: clonedImportable.Calibrate,
              calibrate: clonedImportable.Calibrate,
            },
            measureType: 'Line',
          }
          onMeasureRef.current?.(pastePayload, { isPaste: true })

          hideLineMeasureLabelOnViewer(vm, newId)
          const labelText = clipboard.length != null
            ? formatMeasureLength(clipboard.length, clipboard.unit ?? getDisplayUnit())
            : resolveLinearLabelText(vm, newId, null, getDisplayUnit())
          if (labelText) {
            applyCalibratedLabelToDiagram(
              vm, newId, targetPage, labelText, clipboard.color,
              buildLinearLabelDiagramStyle(clipboard.labelFontSize, pdfScale, clipboard.color),
            )
          }
          lastDrawnAnnotRef.current = newId
          selectedAnnotDataRef.current = null
          toast.success('Measurement pasted', { duration: 2000 })
          setTimeout(() => {
            try {
              prepareMeasureAnnotationsForNextDraw(
                vm, getDisplayUnit(), getCalibratedDrawing(drawingRef), importedAnnotIdsRef.current,
              )
            } catch (_) {}
            const { activeTool: currentTool } = useAppStore.getState()
            if (CONTINUOUS_MEASURE_TOOLS.has(currentTool)) {
              ensureContinuousMeasureModeRef.current?.()
            } else {
              try { vm.annotation.setAnnotationMode('None') } catch (_) {}
            }
          }, 200)

          importingAnnotsRef.current = false
          pasteCommitInProgressRef.current = null
          pasteStyleRef.current = null
        }

        const runFinalize = (attempt = 0) => {
          const live = resolveLiveAnnotation(vm, newId)
          if (!live && attempt < 16) {
            setTimeout(() => runFinalize(attempt + 1), 50)
            return
          }
          applyLinearVisualStyleToDiagram(vm, newId, { ...stylePatch, strokeColor: clipboard.color })
          let aligned = false
          if (pasteAnchor && containerRef.current) {
            for (let i = 0; i < 3; i++) {
              try {
                aligned = nudgeLiveLinearMeasureToScreenAnchor(
                  vm, newId, pasteAnchor, containerRef.current, pageIndexNum,
                )
                if (aligned) break
              } catch (_) {}
            }
          }
          if (pasteAnchor && !aligned && attempt < 12) {
            setTimeout(() => runFinalize(attempt + 1), 80)
            return
          }
          finalizePasteCommit()
        }

        requestAnimationFrame(() => runFinalize(0))
      } catch (err) {
        console.error('[BuildTakeoff] paste commit failed:', err)
        importingAnnotsRef.current = false
        pasteCommitInProgressRef.current = null
        toast.error('Paste failed — try again')
      }
    }, 200)
    return true
  }, [pdfScale, pdfPage, getDisplayUnit, measureLabelFontSize])

  // Stable ref so the pdfCommand useEffect can call commitPasteLinearMeasurement
  // without it being listed in that effect's dependency array.
  const commitPasteRef = useRef(null)
  useEffect(() => { commitPasteRef.current = commitPasteLinearMeasurement }, [commitPasteLinearMeasurement])

  // Copy → click on plan → Ctrl+V: record PDF click as paste destination while clipboard has data.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !pdfBase64) return

    let downX = 0
    let downY = 0

    const onMouseDown = (e) => {
      if (e.button !== 0) return
      downX = e.clientX
      downY = e.clientY
    }

    const onMouseUp = (e) => {
      const { measurementClipboard: clip, activeTool } = useAppStore.getState()
      if (!clip || pastePlacementActive) return
      if (importingAnnotsRef.current) return
      if (e.button !== 0) return
      if (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6) return

      const drawTools = ['line', 'area', 'perimeter', 'calibrate']
      if (drawTools.includes(activeTool) && !e.shiftKey) return

      const vm = viewerRef.current
      if (!vm) return
      const page = useAppStore.getState().pdfPage ?? 1
      const pageIndex = Math.max(0, page - 1)
      const anchor = buildPasteAnchorFromClick(e.clientX, e.clientY, page, pageIndex, vm, el)
      if (!anchor) return

      setPasteAnchor(anchor)
      toast('Paste location set — press Ctrl+V or Paste', { duration: 2500, icon: '📍' })
    }

    el.addEventListener('mousedown', onMouseDown, true)
    el.addEventListener('mouseup', onMouseUp, true)
    return () => {
      el.removeEventListener('mousedown', onMouseDown, true)
      el.removeEventListener('mouseup', onMouseUp, true)
    }
  }, [pdfBase64, pastePlacementActive, setPasteAnchor])

  // Screen position for paste-anchor crosshair (updates on zoom/scroll/page).
  useEffect(() => {
    if (!pasteAnchor || !viewerRef.current || !containerRef.current) {
      setPasteAnchorScreen(null)
      return
    }
    const pageIndex = Math.max(0, (pasteAnchor.pageNumber ?? 1) - 1)
    const vm = viewerRef.current
    const container = containerRef.current

    const updatePos = () => {
      const pos = resolvePasteAnchorScreenPosition(pasteAnchor, pageIndex, vm, container)
      setPasteAnchorScreen(pos)
    }
    updatePos()

    const scrollEl = vm?.viewerBase?.viewerContainer
      ?? document.getElementById('sfPdfViewer_viewerContainer')
    scrollEl?.addEventListener('scroll', updatePos, { passive: true })
    window.addEventListener('resize', updatePos)
    return () => {
      scrollEl?.removeEventListener('scroll', updatePos)
      window.removeEventListener('resize', updatePos)
    }
  }, [pasteAnchor, pdfScale, pdfPage, fallbackLabelTick, canvasSelectionTick])

  const handlePastePlacementClick = useCallback((e) => {
    const pending = pastePlacementRef.current
    const sourceRaw = pending?.clipboard?.copyJson ?? pending?.clipboard?.raw
    if (!sourceRaw) return
    e.preventDefault()
    e.stopPropagation()

    const vm = viewerRef.current
    if (!vm) return

    const targetPage = pdfPage ?? pending.clipboard.pageNumber ?? 1
    const pageIndex = Math.max(0, targetPage - 1)
    const anchor = buildPasteAnchorFromClick(
      e.clientX, e.clientY, targetPage, pageIndex, vm, containerRef.current,
    )
    if (!anchor) {
      toast.error('Could not place measurement — click on the drawing')
      return
    }

    const offset = computeLinearPasteOffsetForAnchor(
      sourceRaw, anchor, pageIndex, vm, containerRef.current,
    )
    if (!offset) {
      cancelPastePlacement()
      toast.error('Could not paste — invalid line geometry')
      return
    }

    const ok = commitPasteLinearMeasurement(
      pending.clipboard, offset.offsetX, offset.offsetY, targetPage, anchor,
    )
    cancelPastePlacement()
    if (!ok) toast.error('Paste failed')
  }, [pdfPage, commitPasteLinearMeasurement, cancelPastePlacement])

  useEffect(() => {
    if (!pastePlacementActive) return
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        cancelPastePlacement()
        toast('Paste cancelled', { duration: 1500 })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pastePlacementActive, cancelPastePlacement])

  // Exit draw mode before export — Syncfusion only commits finished annotations in None mode
  // (same pattern as the manual Save button / captureAnnotations).
  const flushMeasurementExport = useCallback((vm) => {
    if (!vm) return
    try { vm.annotation.setAnnotationMode('None') } catch (_) {}
    setTimeout(() => {
      exportAndProcessUnsaved(vm)
      setTimeout(() => {
        const { activeTool: tool } = useAppStore.getState()
        if (CONTINUOUS_MEASURE_TOOLS.has(tool)) ensureContinuousMeasureMode()
        else applyActiveToolToViewerRef.current?.()
      }, 80)
    }, 200)
  }, [exportAndProcessUnsaved, ensureContinuousMeasureMode])

  const scheduleMeasurementComplete = useCallback((plainAnnot) => {
    if (!plainAnnot) return
    const id = plainAnnot.annotationId ?? plainAnnot.name ?? plainAnnot.AnnotName
    if (!id) return

    console.log('[BT-Lifecycle] scheduleMeasurementComplete — id:', id)
    const prev = measureCompleteTimersRef.current.get(id)
    if (prev) clearTimeout(prev)

    const resolveAnnot = () => {
      const annotId = plainAnnot.annotationId ?? plainAnnot.name ?? plainAnnot.AnnotName
      const vm = viewerRef.current
      const live = annotId && vm ? resolveLiveAnnotation(vm, annotId) : null
      if (live) {
        const fromLive = buildPlainAnnot(live)
        if (extractAnnotationPoints(fromLive).length >= 2) return fromLive
      }
      if (extractAnnotationPoints(plainAnnot).length >= 2) return plainAnnot
      return plainAnnot
    }

    const hasOnScreenLength = (annotId, attempt) => {
      const vm = viewerRef.current
      const d = getCalibratedDrawing(drawingRef)
      const displayUnit = getDisplayUnit()
      const annot = resolveAnnot()
      const live = annotId && vm ? resolveLiveAnnotation(vm, annotId) : null

      const pts = extractAnnotationPoints(live ?? annot)
      let pxLen = polylineLength(pts)
      if (pxLen < 0.1) pxLen = extractPixelLengthFromAnnot(live ?? annot, pxLen)

      // Calibrated drawings still need valid geometry — never fire processMeasure with pxLen=0.
      if (pxLen >= 0.1) {
        if (d?.isCalibrated && d.scaleRatio > 0) return true

        const label = vm && annotId ? resolveLinearLabelText(vm, annotId, null, displayUnit) : ''
        if (label && !/nan/i.test(label)) {
          const parsed = parseMeasureLabel(label)
          if (parsed?.value > 0 && !parsed.isArea) return true
        }

        const displayed = extractDisplayedMeasureFromAnnot(live ?? annot, displayUnit)
        if (displayed.length != null && displayed.length > 0) return true

        return true
      }

      const eventPts = extractAnnotationPoints(plainAnnot)
      if (polylineLength(eventPts) >= 0.1 && attempt >= 2) return true

      return attempt >= 15
    }

    const finishMeasure = (attempt = 0) => {
      const annotId = plainAnnot.annotationId ?? plainAnnot.name ?? plainAnnot.AnnotName

      if (!hasOnScreenLength(annotId, attempt)) {
        const delay = attempt < 2 ? 350 : attempt < 5 ? 250 : 200
        measureCompleteTimersRef.current.set(id, setTimeout(() => finishMeasure(attempt + 1), delay))
        return
      }

      console.log('[BT-Lifecycle] finishMeasure firing — attempt:', attempt, 'id:', annotId)
      measureCompleteTimersRef.current.delete(id)
      clearLiveDrawLabel()

      const wasProcessed = annotId ? processedAnnotsRef.current.has(annotId) : false
      processMeasureRef.current?.(resolveAnnot())
      const nowProcessed = annotId ? processedAnnotsRef.current.has(annotId) : false

      if (annotId && !nowProcessed && !wasProcessed && attempt < 15) {
        const delay = attempt < 3 ? 200 : attempt < 8 ? 150 : 100
        measureCompleteTimersRef.current.set(id, setTimeout(() => finishMeasure(attempt + 1), delay))
        return
      }

      const { activeTool: tool } = useAppStore.getState()
      if (CONTINUOUS_MEASURE_TOOLS.has(tool)) {
        ensureContinuousMeasureModeRef.current?.()
      } else {
        applyActiveToolToViewerRef.current?.()
      }
      setTimeout(() => {
        if (annotId) hideLineMeasureLabelOnViewer(viewerRef.current, annotId)
      }, 120)

      exportAndProcessUnsaved(viewerRef.current)
      setTimeout(() => {
        const { activeTool: t } = useAppStore.getState()
        if (CONTINUOUS_MEASURE_TOOLS.has(t)) {
          ensureContinuousMeasureModeRef.current?.()
        } else {
          applyActiveToolToViewerRef.current?.()
        }
      }, 300)
    }

    measureCompleteTimersRef.current.set(id, setTimeout(() => finishMeasure(0), 250))
  }, [exportAndProcessUnsaved, ensureContinuousMeasureMode, getDisplayUnit, clearLiveDrawLabel])

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

  // ── Import stored annotations from takeoff pointsJson (incremental + reload-safe) ──
  useEffect(() => {
    if (!docLoaded || !drawing?.id) return

    const vm = viewerRef.current
    if (!vm) return

    // wasImported=true means vm.importAnnotation() was called just before this finishImport.
    // Syncfusion's internal canvas repaint from importAnnotation overrides any FitWidth
    // that fired in the 300ms/700ms timeouts from handleDocumentLoaded, so we must
    // re-apply FitWidth after Syncfusion's renderDrawing() settles.
    const finishImport = (importedItems, wasImported = false) => {
      importingAnnotsRef.current = false
      importCompletedRef.current = true
      importedDrawingRef.current = drawing.id
      applyCalibrationToViewer(vm)
      setTimeout(() => {
        hydrateTakeoffItemsOnViewer(vm, importedItems?.length ? importedItems : annotations, pdfScale)
        importedItems?.forEach(item => importedTakeoffIdsRef.current.add(item.id))
        try { vm.renderDrawing?.() } catch (_) {}
        // Re-apply FitWidth after Syncfusion finishes its canvas repaint from importAnnotation.
        // renderDrawing() re-paints synchronously but Syncfusion's internal scroll/zoom
        // settling is async — 300ms gives it time to complete before we override.
        if (wasImported) setTimeout(() => applyFitWidth(), 300)
        // Second pass — Syncfusion may overwrite notes during calibrate refresh
        setTimeout(() => {
          const batch = importedItems?.length ? importedItems : annotations
          hydrateTakeoffItemsOnViewer(vm, batch, pdfScale)
          hydrateTakeoffLabelsOnViewer(vm, batch, pdfScale)
        }, 600)
        setTimeout(() => {
          hydrateTakeoffLabelsOnViewer(vm, importedItems?.length ? importedItems : annotations, pdfScale)
          scheduleLabelLayoutWithRetries()
        }, 1200)
        setTimeout(() => {
          hydrateTakeoffLabelsOnViewer(vm, importedItems?.length ? importedItems : annotations, pdfScale)
          scheduleLabelLayoutWithRetries()
        }, 2200)
        setTimeout(() => scheduleLabelLayoutWithRetries(), 3000)

        // Fallback: import annotation blob if some rows still missing on canvas
        const stillMissing = annotations.some(item => {
          const id = parseAnnotIdFromPointsJson(item.pointsJson)
          return id && !resolveLiveAnnotation(vm, id)
        })
        if (stillMissing && drawing.annotationData && !blobFallbackImportedRef.current) {
          blobFallbackImportedRef.current = true
          // Always schedule the reset BEFORE calling importAnnotation so that even if
          // importAnnotation throws synchronously, importingAnnotsRef is still cleared.
          importingAnnotsRef.current = true
          const resetBlobFallback = () => {
            importingAnnotsRef.current = false
            hydrateTakeoffItemsOnViewer(vm, annotations, pdfScale)
            hydrateTakeoffLabelsOnViewer(vm, annotations, pdfScale)
            scheduleLabelLayoutWithRetries()
            try { vm.renderDrawing?.() } catch (_) {}
            setTimeout(() => applyFitWidth(), 300)
          }
          const blobResetTimer = setTimeout(resetBlobFallback, 300)
          try {
            const blob = typeof drawing.annotationData === 'string'
              ? drawing.annotationData
              : JSON.stringify(drawing.annotationData)
            vm.importAnnotation(blob, 'Json')
          } catch (_) {
            // importAnnotation threw — cancel the 300ms timer and reset immediately
            clearTimeout(blobResetTimer)
            importingAnnotsRef.current = false
            console.warn('[BuildTakeoff] blob-fallback importAnnotation failed — importingAnnotsRef reset immediately')
          }
        }
      }, 250)
    }

    const itemsToImport = annotations.filter(item => {
      if (!item.pointsJson || importedTakeoffIdsRef.current.has(item.id)) return false
      const id = parseAnnotIdFromPointsJson(item.pointsJson)
      if (id && resolveLiveAnnotation(vm, id)) {
        importedTakeoffIdsRef.current.add(item.id)
        return false
      }
      return true
    })

    if (!itemsToImport.length) {
      if (annotations.length > 0) {
        hydrateTakeoffItemsOnViewer(vm, annotations, pdfScale)
        setTimeout(() => {
          hydrateTakeoffItemsOnViewer(vm, annotations, pdfScale)
          hydrateTakeoffLabelsOnViewer(vm, annotations, pdfScale)
          bumpFallbackLabelLayout()
        }, 500)
        setTimeout(() => {
          hydrateTakeoffLabelsOnViewer(vm, annotations, pdfScale)
          bumpFallbackLabelLayout()
        }, 1200)
      }
      return
    }

    const byPage = {}
    const importedBatch = []
    itemsToImport.forEach(item => {
      const built = buildImportableFromTakeoffItem(item, measureLabelFontSize, pdfScale)
      if (!built) {
        console.warn('[BuildTakeoff] skip import — no geometry in pointsJson for item', item.id, item.mark)
        return
      }
      if (!byPage[built.pageIdx]) byPage[built.pageIdx] = []
      byPage[built.pageIdx].push(built.importable)
      importedBatch.push(item)
      const id = built.importable.AnnotName ?? built.importable.annotationId ?? built.importable.name
      if (id) importedAnnotIdsRef.current.add(id)
    })

    if (!Object.keys(byPage).length) {
      finishImport([])
      return
    }

    const pdfAnnotation = {}
    Object.entries(byPage).forEach(([pageIdx, annots]) => {
      pdfAnnotation[pageIdx] = {
        measureShapeAnnotation: annots,
        shapeAnnotation: [],
      }
    })

    console.log('[BuildTakeoff] import', Object.values(byPage).flat().length, 'annotation(s) from pointsJson')
    importingAnnotsRef.current = true
    try {
      if (typeof vm.importAnnotation === 'function') {
        // Strip undefined values — Syncfusion may call .toString() on missing fields
        const json = JSON.stringify({ pdfAnnotation }, (_k, v) => (v === undefined ? null : v))
        vm.importAnnotation(json, 'Json')
      }
    } catch (err) {
      console.error('[BuildTakeoff] pointsJson import failed:', err)
    }
    setTimeout(() => finishImport(importedBatch, true), 100)
  }, [docLoaded, drawing?.id, drawing?.annotationData, annotations, measureLabelFontSize, pdfScale, applyCalibrationToViewer, scheduleLabelLayoutWithRetries, applyFitWidth])  // eslint-disable-line react-hooks/exhaustive-deps

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
      mouseUpTimer = setTimeout(() => {
        if (measureCompleteTimersRef.current.size > 0) return
        exportAndProcessUnsaved(viewerRef.current)
      }, 400)
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
      }
      const dx = state.prevX - e.clientX
      const dy = state.prevY - e.clientY
      state.prevX = e.clientX
      state.prevY = e.clientY
      if (dx !== 0 || dy !== 0) applyScroll(dx, dy)
    }

    const onMouseUp = (e) => {
      if (!state.dragging) return
      const wasClick = !state.hasMoved
      state.dragging = false
      state.scrollEls = null
      state.hasMoved = false
      outer.style.cursor = 'grab'

      if (wasClick && e?.button === 0 && !pastePlacementActive && !importingAnnotsRef.current) {
        const clip = useAppStore.getState().measurementClipboard
        if (clip) {
          const vm = viewerRef.current
          if (vm) {
            const page = useAppStore.getState().pdfPage ?? 1
            const pageIndex = Math.max(0, page - 1)
            const anchor = buildPasteAnchorFromClick(
              e.clientX, e.clientY, page, pageIndex, vm, containerRef.current,
            )
            if (anchor) {
              setPasteAnchor(anchor)
              toast('Paste location set — press Ctrl+V or Paste', { duration: 2500, icon: '📍' })
            }
          }
        }
      }
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
  }, [activeTool, docLoaded, setPasteAnchor, pastePlacementActive])

  // ── Handle imperative viewer commands (fitPage, selectAnnotation, …) ───
  useEffect(() => {
    const vm = viewerRef.current
    if (!pdfCommand || !vm || !pdfBase64) return
    const type    = typeof pdfCommand === 'string' ? pdfCommand : pdfCommand.type
    const payload = typeof pdfCommand === 'object'  ? pdfCommand : {}
    try {
      if (type === 'fitPage') {
        applyFitWidthToViewer(vm, setPdfScale, containerRef.current?.clientWidth, pageMetaRef.current)
      } else if (type === 'refreshCalibration') {
        // After calibration, the import cycle (if any) is always complete — force-clear the gate
        // so the user can immediately draw new measurements.
        console.log('[BT-Lifecycle] pdfCommand refreshCalibration — clearing importingAnnotsRef, was:', importingAnnotsRef.current)
        importingAnnotsRef.current = false
        applyCalibrationToViewer(vm)
      } else if (type === 'rehydrateMeasureLabels') {
        // Same: force-clear the import gate. This command fires after calibration/paste completes,
        // so any in-flight import is definitionally done at this point.
        console.log('[BT-Lifecycle] pdfCommand rehydrateMeasureLabels — clearing importingAnnotsRef, was:', importingAnnotsRef.current)
        importingAnnotsRef.current = false
        applyCalibrationToViewer(vm)
        hydrateTakeoffItemsOnViewer(vm, annotationsRef.current, pdfScale)
        scheduleLabelLayoutWithRetries()
      } else if (type === 'searchText' && payload.query) {
        const q = String(payload.query).trim()
        if (q) {
          try {
            if (typeof vm.textSearch?.searchText === 'function') {
              vm.textSearch.searchText(q, false)
            } else if (typeof vm.textSearchModule?.searchText === 'function') {
              vm.textSearchModule.searchText(q, false)
            }
          } catch (_) {}
        }
        // Text search steals Syncfusion interaction — restore whatever tool is active now
        setTimeout(() => applyActiveToolToViewerRef.current?.(), 120)
        setTimeout(() => applyActiveToolToViewerRef.current?.(), 450)
      } else if (type === 'ensureMeasureMode') {
        try {
          prepareMeasureAnnotationsForNextDraw(
            vm, getDisplayUnit(), getCalibratedDrawing(drawingRef), importedAnnotIdsRef.current,
          )
        } catch (_) {}
        applyActiveToolToViewerRef.current?.()
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
      } else if (type === 'applyLineThickness') {
        applyLineThicknessRef.current?.(payload.thickness, { persist: true })
      } else if (type === 'deleteAnnotation' && payload.annotationId) {
        // Mark as processed so scheduleMeasurementComplete (triggered by the selectAnnotation call
        // below) does not re-save the annotation as a new measurement after it's deleted.
        processedAnnotsRef.current.add(payload.annotationId)
        pendingLabelByAnnotRef.current.delete(payload.annotationId)
        if (lastDrawnAnnotRef.current === payload.annotationId) lastDrawnAnnotRef.current = null
        // Also add to importedAnnotIds so handleAnnotationSelect skips it
        importedAnnotIdsRef.current.add(payload.annotationId)
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
      } else if (type === 'pasteWithFixedOffset') {
        // Direct paste: places the clone immediately with a fixed 15-screen-pixel
        // offset from the original — no extra click required.
        const clipboard = payload.clipboard
        if (!(clipboard?.copyJson ?? clipboard?.raw)) {
          toast('Nothing to paste — copy a line measurement first')
          return
        }
        if ((clipboard.itemType || 'Line') !== 'Line') {
          toast('Only linear measurements can be pasted')
          return
        }
        try { vm.annotation.setAnnotationMode('None') } catch (_) {}
        const { pdfPage: currentPage } = useAppStore.getState()
        const targetPage = currentPage ?? 1
        const pageIndex = Math.max(0, targetPage - 1)
        const pdfOffsetX = screenPixelsToPdfUnits(15, pageIndex, vm)
        const pdfOffsetY = screenPixelsToPdfUnits(15, pageIndex, vm)
        const ok = commitPasteRef.current?.(clipboard, pdfOffsetX, pdfOffsetY, targetPage)
        if (!ok) toast.error('Paste failed')
      } else if (type === 'pasteAtPoint') {
        const clipboard = payload.clipboard
        const anchor = payload.anchor
        if (!(clipboard?.copyJson ?? clipboard?.raw)) {
          toast('Nothing to paste — copy a line measurement first')
          return
        }
        if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
          toast('Click on the drawing where you want to paste, then press Ctrl+V', { duration: 3500, icon: '📍' })
          return
        }
        if ((clipboard.itemType || 'Line') !== 'Line') {
          toast('Only linear measurements can be pasted')
          return
        }
        try { vm.annotation.setAnnotationMode('None') } catch (_) {}
        const sourceRaw = clipboard.copyJson ?? clipboard.raw
        const targetPage = anchor.pageNumber ?? useAppStore.getState().pdfPage ?? 1
        const pageIndex = Math.max(0, targetPage - 1)
        const container = containerRef.current
        const anchorScreen = container
          ? resolvePasteAnchorScreenPosition(anchor, pageIndex, vm, container)
          : null
        const anchorForPaste = {
          ...anchor,
          screenLeft: anchorScreen?.left ?? anchor.screenLeft,
          screenTop: anchorScreen?.top ?? anchor.screenTop,
        }
        const offset = computeLinearPasteOffsetForAnchor(
          sourceRaw, anchorForPaste, pageIndex, vm, container,
        )
        if (!offset) {
          toast.error('Could not paste — invalid line geometry')
          return
        }
        const ok = commitPasteRef.current?.(clipboard, offset.offsetX, offset.offsetY, targetPage, anchorForPaste)
        if (ok) {
          useAppStore.getState().clearPasteAnchor()
        } else {
          toast.error('Paste failed')
        }
      } else if (type === 'pasteMeasurement') {
        const clipboard = payload.clipboard
        if (!(clipboard?.copyJson ?? clipboard?.raw)) {
          toast('Nothing to paste — copy a line measurement first')
          return
        }
        if ((clipboard.itemType || 'Line') !== 'Line') {
          toast('Only linear measurements can be pasted')
          return
        }

        try { vm.annotation.setAnnotationMode('None') } catch (_) {}
        const { pdfPage: currentPage } = useAppStore.getState()
        const targetPage = currentPage ?? clipboard.pageNumber ?? 1
        const pageIndex = Math.max(0, targetPage - 1)
        const sourceRaw = clipboard.copyJson ?? clipboard.raw
        let screenVec = null
        try {
          const container = containerRef.current
          if (container) {
            const screenEnds = getLinearMeasureScreenEndpoints(sourceRaw, pageIndex, vm, container)
            if (screenEnds) {
              screenVec = {
                halfDx: (screenEnds.p1.left - screenEnds.p0.left) / 2,
                halfDy: (screenEnds.p1.top - screenEnds.p0.top) / 2,
              }
            }
          }
        } catch (_) {}
        pastePlacementRef.current = { clipboard, screenVec }
        setPasteCursorPos(null)
        setPastePlacementActive(true)
        toast('Click on the drawing to place the measurement', { duration: 3500 })
      } else if (type === 'saveAnnotationBlob') {
        try { vm.annotation.setAnnotationMode('None') } catch (_) {}
        setTimeout(() => {
          try {
            if (importingAnnotsRef.current) return
            if (measureCompleteTimersRef.current.size > 0) return
            if (typeof vm.exportAnnotationsAsObject !== 'function') return
            patchAllLiveMeasureAnnotationsForExport(vm, getDisplayUnit())
            let result
            try {
              result = vm.exportAnnotationsAsObject()
            } catch (_) {
              return
            }
            const saveBlob = (rawData) => {
              if (!rawData) return
              const saveBlobFn = onAnnotationsBlobRef.current
              if (!saveBlobFn) return
              try {
                const jsonStr = typeof rawData === 'string' ? rawData : JSON.stringify(rawData)
                saveBlobFn(jsonStr)
              } catch (_) {}
            }
            if (result && typeof result.then === 'function') {
              void result.then(saveBlob).catch(() => {})
            } else if (result) {
              saveBlob(result)
            }
          } catch (_) {}
          const { activeTool: currentTool } = useAppStore.getState()
          const mode = MEASURE_MODES[currentTool]
          if (mode) { try { vm.annotation.setAnnotationMode(mode) } catch (_) {} }
        }, 300)
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

            patchAllLiveMeasureAnnotationsForExport(vm, getDisplayUnit())
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
            scheduleLabelLayoutWithRetries()
          }
        }, 500)
      }
    } catch (_) { }
    clearPdfCommand()
  }, [pdfCommand, pdfBase64, clearPdfCommand, processMeasureAnnotation, applyCalibrationToViewer, setPdfScale, scheduleLabelLayoutWithRetries, pdfScale])

  // ── Load PDF as base64 whenever drawingUrl changes ─────────────────────
  useEffect(() => {
    if (!drawingUrl) {
      setPdfBase64(null)
      pageMetaRef.current = null
      setErrorMsg(null)
      prevUrlRef.current = null
      return
    }
    if (drawingUrl === prevUrlRef.current) return
    prevUrlRef.current = drawingUrl

    setLoading(true)
    setErrorMsg(null)
    setPdfBase64(null)
    pageMetaRef.current = null
    setDocLoaded(false)
    firstRenderDoneRef.current = false
    fitPassRef.current = 0
    setPdfScale(1.2)
    importedDrawingRef.current = null
    importCompletedRef.current = false

    fetch(drawingUrl)
      .then(res => {
        if (res.status === 404) throw Object.assign(new Error('Drawing file not found on server. Please re-upload.'), { code: 404 })
        if (res.status === 401) throw Object.assign(new Error('Authentication error — please log in again.'), { code: 401 })
        if (!res.ok)            throw new Error(`Server error (${res.status})`)
        const ct = res.headers.get('content-type') ?? ''
        if (ct && !ct.includes('pdf') && !ct.includes('octet-stream')) {
          throw new Error('Server did not return a PDF file')
        }
        return res.blob()
      })
      .then(blob => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve({ dataUrl: reader.result, blob })
        reader.onerror = () => reject(new Error('Failed to read PDF file'))
        reader.readAsDataURL(blob)
      }))
      .then(async ({ dataUrl, blob }) => {
        // Lightweight MediaBox parse — never use pdf.js here (conflicts with Syncfusion pdfium WASM).
        try {
          const buf = await blob.arrayBuffer()
          pageMetaRef.current = probeMediaBoxFromBuffer(buf)
        } catch {
          pageMetaRef.current = null
        }
        setPdfBase64(dataUrl)
      })
      .catch(err => {
        const msg = err.message || 'Failed to load PDF'
        setErrorMsg(msg)
        toast.error(msg)
      })
      .finally(() => setLoading(false))
  }, [drawingUrl, setPdfScale])

  useEffect(() => {
    if (!pdfBase64) {
      pageTextByPageRef.current = {}
      return
    }
    let cancelled = false
    loadPdfTextItemsByPage(pdfBase64, pdfjsLib)
      .then(byPage => {
        if (!cancelled) pageTextByPageRef.current = byPage
      })
      .catch(err => console.warn('[BuildTakeoff] PDF text index failed', err))
    return () => { cancelled = true }
  }, [pdfBase64])

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
  const applyActiveToolToViewer = useCallback(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64 || !docLoaded) return
    const tool = useAppStore.getState().activeTool
    selectedAnnotDataRef.current = null
    try {
      if (MEASURE_MODES[tool]) {
        vm.interactionMode = 'TextSelection'
        applyCalibrationToViewer(vm)
        try {
          prepareMeasureAnnotationsForNextDraw(
            vm,
            useAppStore.getState().activeUnit ?? 'Mm',
            getCalibratedDrawing(drawingRef),
            importedAnnotIdsRef.current,
          )
        } catch (_) {}
        vm.annotation.setAnnotationMode(MEASURE_MODES[tool])
      } else if (MARKUP_MODES[tool]) {
        vm.interactionMode = 'TextSelection'
        vm.annotation.setAnnotationMode(MARKUP_MODES[tool])
      } else if (tool === 'pan') {
        cancelMeasureCompleteTimers(measureCompleteTimersRef)
        vm.annotation.setAnnotationMode('None')
        vm.interactionMode = 'Pan'
        try { vm.focusViewerContainer?.() } catch (_) {}
      } else {
        cancelMeasureCompleteTimers(measureCompleteTimersRef)
        vm.annotation.setAnnotationMode('None')
        vm.interactionMode = 'TextSelection'
      }
    } catch (_) { /* viewer not ready */ }
  }, [activeTool, pdfBase64, docLoaded, applyCalibrationToViewer])

  useEffect(() => { applyActiveToolToViewerRef.current = applyActiveToolToViewer }, [applyActiveToolToViewer])

  useEffect(() => {
    applyActiveToolToViewer()
  }, [applyActiveToolToViewer, activeTool, drawing?.isCalibrated, drawing?.scaleRatio, drawing?.id])

  // ── Sync zoom after first page render (user +/- toolbar) ───────────────
  // DEBOUNCED: rapid zoom clicks (user pressing + quickly) generate many pdfScale
  // changes. Applying each immediately would cancel the prior pdfium render before
  // it completes, causing blank pages. Wait 150 ms for clicks to settle, then
  // apply once. After zoom settles, run a recovery check at 900 ms.
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64 || !docLoaded || !firstRenderDoneRef.current) return
    console.log(`[SF-Render] zoomTo ${Math.round(pdfScale * 100)}% (debounced)`)
    const applyT   = setTimeout(() => applyViewerZoomPct(vm, pdfScale * 100), 150)
    const recoverT = setTimeout(() => recoverBlankVisiblePages(vm), 900)
    return () => { clearTimeout(applyT); clearTimeout(recoverT) }
  }, [pdfScale, pdfBase64, docLoaded])

  // ── Reflow when container resizes (fixes scroll-to-see-PDF symptom) ───
  // DEBOUNCED: panel open/close fires many resize events. Each syncViewerLayout call
  // with recalcPages=true calls vb.onWindowResize() which can interrupt an active
  // pdfium render. Settle 200 ms after the last resize before recalculating.
  useEffect(() => {
    if (!docLoaded || !firstRenderDoneRef.current) return
    const t = setTimeout(() => {
      const containerW = containerRef.current?.clientWidth
      syncViewerLayout(viewerRef.current, true, containerW)
    }, 200)
    return () => clearTimeout(t)
  }, [viewerSize.w, viewerSize.h, docLoaded])

  // ── Stale-page watchdog ────────────────────────────────────────────────
  // Runs every 2.5 s while a document is loaded. If any visible page still
  // has a blank/transparent canvas (render deadlock from rapid scroll/zoom),
  // recoverBlankVisiblePages re-applies the current zoom to flush the queue.
  // The check itself is near-zero cost when all pages are already rendered.
  useEffect(() => {
    if (!docLoaded) return
    const t = setInterval(() => recoverBlankVisiblePages(viewerRef.current), 2500)
    return () => clearInterval(t)
  }, [docLoaded])

  // ── Sync page navigation ───────────────────────────────────────────────
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64 || !docLoaded) return
    try { vm.navigation.goToPage(pdfPage) } catch (_) { }
  }, [pdfPage, pdfBase64, docLoaded])

  // ── Sync color + thickness + opacity to Syncfusion ──────────────────────
  // Runs whenever any of these change so newly drawn annotations pick up the
  // current settings immediately without requiring a tool switch.
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64 || !docLoaded) return

    const hex  = getEffectiveMeasureDrawColor()
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
      const sfUnit = toSfUnit(getSyncfusionNativeUnit(normalizeDrawing(drawing)))
      if (activeTool === 'line') {
        vm.annotation.updateMeasurementSettings('Distance', {
          strokeColor: safeHex, fillColor: fillLight, opacity: 1,
          thickness: thick,
          Thickness: thick,
          displayUnit: sfUnit,
          conversionUnit: sfUnit,
          ...buildLinearDistanceStyle(measureLabelFontSize, pdfScale, safeHex, thick, arrowStyle, linearLineMode),
        })
      } else if (activeTool === 'area') {
        try { vm.annotation.updateMeasurementSettings('Area', { strokeColor: safeHex, fillColor: fillRgba, opacity: 1, thickness: thick, displayUnit: sfUnit, conversionUnit: sfUnit, ...buildMeasureLabelPatch(measureLabelFontSize, pdfScale, safeHex) }) } catch (_) {}
      } else if (activeTool === 'perimeter') {
        try { vm.annotation.updateMeasurementSettings('Perimeter', { strokeColor: safeHex, fillColor: fillLight, opacity: 1, thickness: thick, displayUnit: sfUnit, conversionUnit: sfUnit, ...buildMeasureLabelPatch(measureLabelFontSize, pdfScale, safeHex) }) } catch (_) {}
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

    } catch (_) {}
  }, [activeTool, pdfBase64, docLoaded, measureColor, lineThickness, fillOpacity, lineStyle, fontSize, measureLabelFontSize, pdfScale, arrowStyle, linearLineMode, activeUnit, selectedMemberScheduleItem, lastMeasureMember])

  // Re-sync Syncfusion native unit when display unit or calibration changes
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64 || !docLoaded) return
    applyMeasureDisplayUnitToViewer(vm)
    applyActiveToolToViewerRef.current?.()
  }, [activeUnit, drawing?.isCalibrated, drawing?.scaleRatio, pdfBase64, docLoaded, applyMeasureDisplayUnitToViewer])

  // ── Apply calibration scale to Syncfusion (display unit in grid is separate) ──
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64 || !docLoaded) return
    applyCalibrationToViewer(vm)
  }, [drawing?.isCalibrated, drawing?.scaleRatio, drawing?.calibrationUnit, pdfBase64, applyCalibrationToViewer])

  // ── Re-apply label size when user changes preset or zoom (Bluebeam-style) ──
  // Each line keeps its own saved thickness from pointsJson — toolbar thickness is for the next draw only.
  useEffect(() => {
    const vm = viewerRef.current
    if (!vm || !pdfBase64 || !docLoaded) return
    const hex = getEffectiveMeasureDrawColor()
    const safeHex = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : '#111827'
    applyGlobalMeasureLabelSettings(vm, measureLabelFontSize, pdfScale, safeHex)
    if (activeTool === 'line') {
      const r = parseInt(safeHex.slice(1, 3), 16)
      const g = parseInt(safeHex.slice(3, 5), 16)
      const b = parseInt(safeHex.slice(5, 7), 16)
      try {
        vm.annotation.updateMeasurementSettings('Distance', {
          strokeColor: safeHex,
          fillColor: `rgba(${r},${g},${b},${Math.min(fillOpacity ?? 0.15, 0.15)})`,
          opacity: 1,
          ...buildLinearDistanceStyle(measureLabelFontSize, pdfScale, safeHex, lineThickness, arrowStyle, linearLineMode),
        })
      } catch (_) {}
    }
    if (activeTool === 'line') {
      const targets = listAllLinearTargets(annotationsRef.current, vm)
      if (targets.length) {
        editingAnnotRef.current = true
        try {
          reapplyLinearLabelPresetToAll(vm, annotationsRef.current, {
            measureLabelFontSize, pdfScale, lineThickness,
            arrowStyle, linearLineMode, displayUnit: getDisplayUnit(),
          })
        } catch (_) {}
        setTimeout(() => {
          editingAnnotRef.current = false
          hydrateTakeoffLabelsOnViewer(vm, annotationsRef.current, pdfScale)
          bumpFallbackLabelLayout()
        }, 350)
      }
    }
  }, [measureLabelFontSize, pdfScale, pdfBase64, docLoaded, arrowStyle, linearLineMode, fillOpacity, activeTool, getDisplayUnit, bumpFallbackLabelLayout, measureColor, selectedMemberScheduleItem, lastMeasureMember])

  // ── Fired by Syncfusion when PDF fully loads ───────────────────────────
  const handleDocumentLoaded = useCallback((args) => {
    console.log(`[SF-Render] documentLoad pageCount=${args.pageCount ?? 1}`)
    setPdfTotalPages(args.pageCount ?? 1)
    setPdfPage(1)
    setDocLoaded(true)
    firstRenderDoneRef.current = false
    fitPassRef.current = 0
    const vm = viewerRef.current
    if (vm) {
      try { vm.enableShapeLabel = false } catch (_) {}
      try { vm.contextMenuOption = 'None' } catch (_) {}
      // Fallback page size from Syncfusion if MediaBox probe missed.
      // vb.pageWidth/pageHeight are in PDF points; vb.pageSize[0] is CSS pixels at current
      // zoom and must NOT be used as the denominator in pdfPointToContainerCoords.
      if (!pageMetaRef.current) {
        const vb = vm.viewerBase
        const w = Array.isArray(vb?.pageWidth) ? vb.pageWidth[0] : vb?.pageWidth
        const h = Array.isArray(vb?.pageHeight) ? vb.pageHeight[0] : vb?.pageHeight
        if (Number(w) > 0 && Number(h) > 0) {
          pageMetaRef.current = { width: Number(w), height: Number(h) }
        }
      }
      applyGlobalMeasureLabelSettings(vm, measureLabelFontSize, pdfScale, getEffectiveMeasureDrawColor())
      applyCalibrationToViewer(vm)
      syncViewerLayout(vm, true, containerRef.current?.clientWidth)
    }
    setTimeout(() => applyActiveToolToViewerRef.current?.(), 300)
    setTimeout(() => applyActiveToolToViewerRef.current?.(), 800)
    // Single fallback fit if pageRenderComplete hasn't finished yet
    setTimeout(() => {
      if (fitPassRef.current < 2 && viewerRef.current) {
        applyFitWidth()
        finalizeViewerLayout(viewerRef.current, containerRef.current?.clientWidth)
        fitPassRef.current = 2
        firstRenderDoneRef.current = true
      }
    }, 1200)
  }, [setPdfTotalPages, setPdfPage, measureColor, measureLabelFontSize, pdfScale, applyCalibrationToViewer, applyFitWidth])

  // ── Fired by Syncfusion on page change ────────────────────────────────
  const handlePageChange = useCallback((args) => {
    console.log(`[SF-Render] pageChange currentPage=${args.currentPageNumber}`)
    setPdfPage(args.currentPageNumber)
    bumpFallbackLabelLayout()
    // Repaint annotation overlays when Syncfusion signals a new page is in view.
    // firstRenderDoneRef guards against firing before initial fit completes.
    if (firstRenderDoneRef.current) {
      try { viewerRef.current?.renderDrawing?.() } catch (_) {}
    }
  }, [setPdfPage, bumpFallbackLabelLayout])

  // ── Fired by Syncfusion when an annotation is added ──────────────────────
  const handleAnnotationAdd = useCallback((args) => {
    const firstId = args?.annotation?.annotationId ?? args?.annotation?.name ?? '?'
    console.log('[BT-Lifecycle] annotationAdd entry — importing:', importingAnnotsRef.current, 'id:', firstId)
    if (importingAnnotsRef.current) {
      console.warn('[BT-Lifecycle] annotationAdd BLOCKED by importingAnnotsRef=true — measurement will NOT be saved!')
      return
    }

    const eventAnnotations = []
    const single     = args?.annotation
    const collection = args?.annotationCollection
    if (single)                          eventAnnotations.push(single)
    else if (Array.isArray(collection))  collection.forEach(a => eventAnnotations.push(a))
    if (!eventAnnotations.length) return

    const isPastedAnnot = eventAnnotations.some(a => {
      const plain = buildPlainAnnot(a)
      const id = resolveStableAnnotationId(plain)
      return (id && importedAnnotIdsRef.current.has(id))
        || (pasteCommitInProgressRef.current && id === pasteCommitInProgressRef.current)
    })
    if (isPastedAnnot) {
      console.log('[BT-Lifecycle] annotationAdd skipped — pasted/imported annotation')
      return
    }

    // Safe log — args.annotation contains Syncfusion internal circular refs; don't JSON.stringify(args)
    console.log('[BuildTakeoff] annotationAdd fired, count:', eventAnnotations.length,
      'id:', eventAnnotations[0]?.annotationId ?? eventAnnotations[0]?.name ?? '?')

    // ── IMMEDIATE: process event annotations directly — no export/match needed ──
    // Build a PLAIN-DATA object from the event annotation — do NOT spread the full
    // Syncfusion annotation (it contains internal module refs / circular references
    // that cause JSON.stringify to throw a TypeError in autoSave's pointsJson step).
    eventAnnotations.forEach(a => {
      const plain = buildPlainAnnot(a)
      const annotId = resolveStableAnnotationId(plain)
      const vm = viewerRef.current
      const mod = vm?.annotation?.measureAnnotationModule
      const calD = getCalibratedDrawing(drawingRef)
      if (annotId && mod && calD?.isCalibrated && calD.scaleRatio > 0) {
        try { registerAnnotationScaleRatio(mod, annotId, calD, getDisplayUnit()) } catch (_) {}
      }
      scheduleMeasurementComplete(plain)
    })
    setTimeout(() => bumpFallbackLabelLayout(), 120)
    setTimeout(() => bumpFallbackLabelLayout(), 450)
    // Do not set selectedAnnotDataRef here — continuous draw keeps the tool active;
    // explicit selection uses handleAnnotationSelect (PDF click or grid row).
  }, [scheduleMeasurementComplete, bumpFallbackLabelLayout])

  const handleAnnotationPropertiesChange = useCallback((args) => {
    if (importingAnnotsRef.current || editingAnnotRef.current) return
    const a = args?.annotation
    if (!a) return
    const vm = viewerRef.current
    const annotId = a.annotationId ?? a.name ?? a.AnnotName
    const mod = vm?.annotation?.measureAnnotationModule
    const calD = getCalibratedDrawing(drawingRef)
    if (annotId && mod && calD?.isCalibrated && calD.scaleRatio > 0) {
      try { registerAnnotationScaleRatio(mod, annotId, calD, getDisplayUnit()) } catch (_) {}
    }
    const { activeTool: tool } = useAppStore.getState()
    if (vm && CONTINUOUS_MEASURE_TOOLS.has(tool) && isMeasureAnnotation(a)) {
      const annotId = a.annotationId ?? a.name ?? a.AnnotName
      const live = annotId ? resolveLiveAnnotation(vm, annotId) : null
      scheduleLiveDrawLabel(a)
      const pageIdx = resolveAnnotationPageIndex(live ?? a, a)
      suppressNativeMeasureLabelsOnPage(vm, pageIdx)
      if (live) hideSyncfusionNativeMeasureLabelText(live)
    }
    scheduleMeasurementComplete(buildPlainAnnot(a))
    setTimeout(() => bumpFallbackLabelLayout(), 120)
  }, [scheduleMeasurementComplete, bumpFallbackLabelLayout, scheduleLiveDrawLabel])

  const handleAnnotationSelect = useCallback((args) => {
    const annotation = args?.annotation
    const id = annotation?.annotationId
    if (!id) return
    onAnnotationSelect?.(id)
    const { activeTool: tool } = useAppStore.getState()
    // Skip if this annotation is in the imported/processed set (e.g. deletion flow pre-marks it)
    const isImportedOrProcessed = importedAnnotIdsRef.current.has(id) || processedAnnotsRef.current.has(id)
    if (isMeasureAnnotation(annotation) && !importingAnnotsRef.current && !isImportedOrProcessed) {
      scheduleMeasurementComplete(buildPlainAnnot(annotation))
    }
    // During continuous takeoff, Syncfusion auto-selects the line just drawn — skip that
    // one select so toolbar style changes target the next line, not the one just placed.
    const skipAutoSelect = CONTINUOUS_MEASURE_TOOLS.has(tool)
      && !explicitGridSelectRef.current
      && suppressStyleSelectRef.current === id
    if (skipAutoSelect) {
      suppressStyleSelectRef.current = null
    } else {
      selectedAnnotDataRef.current = annotation
      explicitGridSelectRef.current = false
      if (isLinearMeasureAnnotation(annotation)) setCanvasSelectionTick(t => t + 1)
    }
  }, [onAnnotationSelect, scheduleMeasurementComplete])

  // Stable distanceSettings — memoized so Syncfusion does not receive a new object on every render.
  const memoDistanceSettings = useMemo(() => {
    const distHex = measureColor ?? '#111827'
    const dr = parseInt(distHex.slice(1, 3), 16) || 17
    const dg = parseInt(distHex.slice(3, 5), 16) || 24
    const db = parseInt(distHex.slice(5, 7), 16) || 39
    return {
      displayUnit:    toSfUnit(getSyncfusionNativeUnit(drawing)),
      conversionUnit: toSfUnit(getSyncfusionNativeUnit(drawing)),
      ...(drawing?.isCalibrated && drawing?.scaleRatio ? {
        depth: drawing.scaleRatio,
        scaleRatio: 1,
      } : {
        depth: 25.4 / 72,
        scaleRatio: 1,
      }),
      strokeColor: distHex,
      fillColor:   `rgba(${dr},${dg},${db},${fillOpacity ?? 0.15})`,
      opacity: 1,
      ...buildLinearDistanceStyle(
        measureLabelFontSize, pdfScale, distHex, lineThickness, arrowStyle, linearLineMode,
      ),
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureColor, drawing?.isCalibrated, drawing?.scaleRatio, drawing?.calibrationUnit,
      fillOpacity, measureLabelFontSize, pdfScale, lineThickness, arrowStyle, linearLineMode])

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
        #sfPdfViewer .e-pv-sidebar-panel,
        #sfPdfViewer_sideBarContentContainer,
        #sfPdfViewer .e-pv-sidebar-content-container { display: none !important; width: 0 !important; }

        /* Collapse hidden Syncfusion toolbar (~56px top gap on large pages) */
        #sfPdfViewer .e-pv-toolbar,
        #sfPdfViewer_toolbarContainer,
        #sfPdfViewer_annotation_toolbar,
        #sfPdfViewer_formdesigner_toolbar {
          display: none !important;
          height: 0 !important;
          min-height: 0 !important;
          max-height: 0 !important;
          overflow: hidden !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        #sfPdfViewer .e-pv-main-container,
        #sfPdfViewer .e-pv-viewer-main-container,
        #sfPdfViewer_viewerMainContainer { height: 100% !important; }

        /* ── Expand the viewer content to fill the full width left by the sidebar ── */
        #sfPdfViewer_viewerContainer,
        #sfPdfViewer .e-pv-viewer-container {
          top: 0 !important;
          left: 0 !important;
          width: 100% !important;
          margin-top: 0 !important;
        }

        #sfPdfViewer_pageContainer,
        #sfPdfViewer .e-pv-page-container {
          width: 100% !important;
          max-width: 100% !important;
        }

        /* Pan mode — grab cursor + let drag reach the scroll container */
        .bt-pan-active #sfPdfViewer,
        .bt-pan-active #sfPdfViewer_viewerContainer,
        .bt-pan-active #sfPdfViewer .e-pv-viewer-container { cursor: grab !important; }

        /* Remove stray modal overlays that block PDF interaction */
        #sfPdfViewer .e-dlg-overlay,
        #sfPdfViewer .e-overlay,
        .e-dlg-overlay.e-fade { display: none !important; pointer-events: none !important; }
        .bt-pan-active #sfPdfViewer_viewerContainer { touch-action: none; }

        /* Hide bulky Syncfusion distance end-cap handles (leaders stay in DOM for label math). */
        #sfPdfViewer [id*="leader1_"],
        #sfPdfViewer [id*="leader2_"],
        #sfPdfViewer [id*="Leader1_"],
        #sfPdfViewer [id*="Leader2_"] {
          visibility: hidden !important;
          stroke-width: 0 !important;
        }
      `}</style>

      {/* Loading overlay — only while fetching from server */}
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

      {/* Syncfusion rendering overlay — shows while pdfium WASM parses/renders after fetch completes */}
      {pdfBase64 && !loading && docRendering && (
        <div style={{ position:'absolute', inset:0, zIndex:19,
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          background:'#0a0f1e', gap:'12px' }}>
          <svg className="spin" width="28" height="28" viewBox="0 0 24 24"
            fill="none" stroke="#EF233C" strokeWidth="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
          <span style={{ fontSize:'13px', color:'#64748b' }}>Preparing drawing…</span>
          <span style={{ fontSize:'11px', color:'#334155' }}>Large drawings may take a few seconds</span>
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

      {/* Scale hint — only when no member is selected for measuring */}
      {pdfBase64 && !loading && activeTool === 'line' && !drawing?.isCalibrated && !activeMeasureMember && (
        <div style={{ position:'absolute', top:'12px', left:'50%', transform:'translateX(-50%)',
          zIndex:15, display:'flex', alignItems:'center', gap:'6px',
          background:'rgba(17,24,39,.92)', border:'1px solid rgba(245,158,11,.4)',
          color:'#fbbf24', fontSize:'11px', fontWeight:600,
          padding:'6px 14px', borderRadius:'20px', pointerEvents:'none', whiteSpace:'nowrap',
          maxWidth:'90%', backdropFilter:'blur(4px)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Draw along a labelled dimension — enter its length once to set scale
        </div>
      )}

      {pdfBase64 && !loading && activeTool === 'line' && activeMeasureMember && (
        <div style={{ position:'absolute', top:'12px', left:'50%', transform:'translateX(-50%)',
          zIndex:15, display:'flex', alignItems:'center', gap:'6px',
          background:'rgba(17,24,39,.92)', border:'1px solid rgba(34,197,94,.35)',
          color:'#4ade80', fontSize:'11px', fontWeight:600,
          padding:'6px 14px', borderRadius:'20px', pointerEvents:'none', whiteSpace:'nowrap',
          maxWidth:'90%', backdropFilter:'blur(4px)' }}>
          Measuring {activeMeasureMember.mark} — click and drag to draw a line
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
          Click start → end on a known size (door, wall) → Save Calib
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

      {/* Live value while drawing — Bluebeam-style two-line label above line midpoint */}
      {liveDrawLabel && !/nan/i.test(liveDrawLabel.text ?? '') && (
        <div
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none', overflow: 'hidden' }}
        >
          {/* Rotation anchor at the line midpoint */}
          <div style={{ position: 'absolute', left: `${liveDrawLabel.left}px`, top: `${liveDrawLabel.top}px` }}>
            {/* Inner: center horizontally and shift above — white background covers Syncfusion SVG NaN */}
            <div
              style={{
                transform: `translate(-50%, calc(-100% - 10px))`,
                textAlign: 'center',
                userSelect: 'none',
                lineHeight: 1.2,
                whiteSpace: 'nowrap',
                background: 'rgba(255,255,255,0.92)',
                border: `1px solid ${liveDrawLabel.color ?? '#EF233C'}`,
                borderRadius: '3px',
                padding: '1px 7px 2px',
                boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
              }}
            >
              {liveDrawLabel.mark && !/^nan$/i.test(liveDrawLabel.mark) && (
                <div style={{
                  fontSize: `${measureLabelFontSize * 0.85 * Math.max(pdfScale, 0.45)}px`,
                  fontWeight: 800,
                  color: liveDrawLabel.color ?? '#EF233C',
                  letterSpacing: '0.03em',
                }}>
                  {liveDrawLabel.mark}
                </div>
              )}
              <div style={{
                fontSize: `${measureLabelFontSize * Math.max(pdfScale, 0.45)}px`,
                fontWeight: 700,
                color: liveDrawLabel.color ?? '#EF233C',
                letterSpacing: '0.01em',
              }}>
                {liveDrawLabel.text}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bluebeam-style measurement labels — mark + measurement, rotated to follow line */}
      {pdfBase64 && !loading && fallbackLabelLayout.length > 0 && (
        <div
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, zIndex: 11, pointerEvents: 'none', overflow: 'hidden' }}
        >
          {fallbackLabelLayout.map(entry => {
            // Clamp font between 9–13 px screen size regardless of zoom level
            const BASE = entry.fontSizePt ?? 12
            const fsPx = Math.min(Math.max(BASE * Math.max(pdfScale, 0.45), 9), 13)
            const color = entry.color ?? '#EF233C'
            const gap = entry.gap ?? 10
            const angle = entry.angle ?? 0
            return (
              <div
                key={entry.key}
                style={{
                  position: 'absolute',
                  left: `${entry.left}px`,
                  top: `${entry.top}px`,
                  transform: `rotate(${angle}deg)`,
                  transformOrigin: '0 0',
                  pointerEvents: 'none',
                }}
              >
                {/* Shift up from midpoint after rotation — white box matches live draw label */}
                <div
                  style={{
                    transform: `translate(-50%, calc(-100% - ${gap}px))`,
                    textAlign: 'center',
                    userSelect: 'none',
                    lineHeight: 1.2,
                    whiteSpace: 'nowrap',
                    background: 'rgba(255,255,255,0.92)',
                    border: `1px solid ${color}`,
                    borderRadius: '3px',
                    padding: '1px 7px 2px',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
                  }}
                >
                  {entry.mark && !/^nan$/i.test(entry.mark) && (
                    <div
                      style={{
                        fontSize: `${fsPx * 0.88}px`,
                        fontWeight: 800,
                        color,
                        letterSpacing: '0.02em',
                      }}
                    >
                      {entry.mark}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: `${fsPx}px`,
                      fontWeight: 700,
                      color,
                      letterSpacing: '0.01em',
                    }}
                  >
                    {entry.text}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Paste destination marker (set by click after copy, before Ctrl+V) */}
      {pdfBase64 && !loading && measurementClipboard && pasteAnchorScreen && !pastePlacementActive && (
        <div
          data-paste-marker
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${pasteAnchorScreen.left}px`,
            top: `${pasteAnchorScreen.top}px`,
            transform: 'translate(-50%, -50%)',
            zIndex: 12,
            pointerEvents: 'none',
            width: 22,
            height: 22,
          }}
        >
          <svg width="22" height="22" viewBox="0 0 22 22" style={{ overflow: 'visible' }}>
            <circle cx="11" cy="11" r="9" fill="rgba(239,35,60,0.15)" stroke="#EF233C" strokeWidth="1.5" />
            <line x1="11" y1="2" x2="11" y2="20" stroke="#EF233C" strokeWidth="1.5" />
            <line x1="2" y1="11" x2="20" y2="11" stroke="#EF233C" strokeWidth="1.5" />
          </svg>
        </div>
      )}

      {/* ── Paste placement overlay — line preview follows cursor, click to place ── */}
      {pdfBase64 && !loading && pastePlacementActive && (() => {
        const pending  = pastePlacementRef.current
        const sv       = pending?.screenVec          // { halfDx, halfDy } in container-px
        const cb       = pending?.clipboard
        const color    = cb?.color ?? '#EF233C'
        const thick    = Math.max(1, cb?.thickness ?? 2)
        // Preview line endpoints (container-relative px) centered on cursor
        const cx = pasteCursorPos?.left ?? null
        const cy = pasteCursorPos?.top  ?? null
        const hasPreview = cx != null && sv != null
        const x1 = hasPreview ? cx - sv.halfDx : 0
        const y1 = hasPreview ? cy - sv.halfDy : 0
        const x2 = hasPreview ? cx + sv.halfDx : 0
        const y2 = hasPreview ? cy + sv.halfDy : 0
        const labelText = cb?.length != null
          ? formatMeasureLength(cb.length, cb.unit ?? 'Mm')
          : null
        return (
          <div
            style={{ position: 'absolute', inset: 0, zIndex: 13, cursor: 'crosshair' }}
            onClick={handlePastePlacementClick}
            onMouseMove={(e) => {
              const cr = containerRef.current?.getBoundingClientRect()
              if (!cr) return
              setPasteCursorPos({ left: e.clientX - cr.left, top: e.clientY - cr.top })
            }}
            onMouseLeave={() => setPasteCursorPos(null)}
          >
            {/* SVG preview line that follows the cursor */}
            {hasPreview && (
              <svg
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
              >
                {/* End-cap markers */}
                <circle cx={x1} cy={y1} r={4} fill={color} opacity={0.8} />
                <circle cx={x2} cy={y2} r={4} fill={color} opacity={0.8} />
                {/* Main preview line */}
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={color}
                  strokeWidth={thick}
                  strokeDasharray="6 3"
                  opacity={0.85}
                />
                {/* Measurement label near midpoint */}
                {labelText && (
                  <text
                    x={(x1 + x2) / 2}
                    y={Math.min(y1, y2) - 8}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight="600"
                    fill={color}
                    stroke="rgba(255,255,255,0.7)"
                    strokeWidth={3}
                    paintOrder="stroke"
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {labelText}
                  </text>
                )}
              </svg>
            )}
            {/* Instruction banner */}
            <div
              style={{
                position: 'absolute',
                bottom: 16,
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'rgba(15,23,42,0.92)',
                color: '#e2e8f0',
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid #334155',
                pointerEvents: 'none',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              Click to place {labelText ? `${labelText} measurement` : 'measurement'} · Esc to cancel
            </div>
          </div>
        )
      })()}

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
          {measurementClipboard
            ? (pasteAnchor
              ? 'Paste location set — press Ctrl+V or Paste'
              : 'Click where to paste, then Ctrl+V')
            : 'Hold and drag to pan the drawing'}
        </div>
      )}

      {/* Syncfusion PDF Viewer — only mount once we know the container size. */}
      {pdfBase64 && !errorMsg && viewerSize.h > 0 && (() => {
        return (
        <PdfViewerComponent
          key={drawingUrl ?? 'pdf-viewer'}
          id="sfPdfViewer"
          ref={viewerRef}
          documentPath={pdfBase64}
          resourceUrl={SF_RESOURCE_URL}
          initialRenderPages={1}
          style={{
            height: `${viewerSize.h}px`,
            width:  `${viewerSize.w}px`,
            display: 'block',
          }}

          enableNavigationToolbar={false}
          enableToolbar={false}
          contextMenuOption="None"

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
          distanceSettings={memoDistanceSettings}

          /* ── Annotation appearance ────────────────────────────────────────── */
          annotationSettings={{
            author: 'BuildTakeoff',
            isLock: false,
          }}

          /* ── Events ──────────────────────────────────────────────────────── */
          documentLoad={handleDocumentLoaded}
          pageRenderComplete={handlePageRenderComplete}
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
        )
      })()}
    </div>
  )
}

