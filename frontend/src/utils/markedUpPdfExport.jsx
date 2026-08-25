import { createRoot } from 'react-dom/client'
import jsPDF from 'jspdf'
import PdfSvgOverlay from '../components/drawings/pdfjs/PdfSvgOverlay'

const EXPORT_RENDER_SCALE = 2
const MAX_EXPORT_DIMENSION = 5200

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

function safeFilename(value) {
  const filename = String(value ?? 'Drawing')
    .trim()
    .replace(/\.pdf$/i, '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
  return filename || 'Drawing'
}

function loadSvgImage(svg) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('The markup layer could not be rendered'))
    }
    image.src = url
  })
}

async function renderMarkupLayer({
  pageNumber,
  pageSize,
  annotations,
  sectionPlacements,
  sectionFocuses,
  sectionMeasurementColors,
  sectionDraftColor,
}) {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${pageSize.width}px`,
    height: `${pageSize.height}px`,
    overflow: 'hidden',
    pointerEvents: 'none',
  })
  document.body.appendChild(host)
  const root = createRoot(host)

  try {
    root.render(
      <PdfSvgOverlay
        pageNumber={pageNumber}
        pageSize={pageSize}
        viewerScale={1}
        annotations={annotations}
        pdfLineEndpoints={[]}
        pdfLineSegments={[]}
        selectedAnnotationId={null}
        selectedAnnotationIds={new Set()}
        pasteClipboard={null}
        sectionPlacementMode={null}
        sectionPlacements={sectionPlacements}
        sectionFocus={null}
        sectionFocuses={sectionFocuses}
        sectionMeasurementColors={sectionMeasurementColors}
        sectionDraftColor={sectionDraftColor}
        sectionEditMode={null}
        onSectionEditRequest={() => {}}
        onMeasure={() => {}}
        onSectionSelection={() => {}}
        onSectionPlacement={() => {}}
        onSectionPlacementContextMenu={() => {}}
        onSelect={() => {}}
        onAnnotationContextMenu={() => {}}
        onClearSelection={() => {}}
        onGeometryChange={() => {}}
        onLabelSizeChange={() => {}}
      />,
    )
    await nextPaint()

    const sourceSvg = host.querySelector('svg.pdfjs-annotation-layer')
    if (!sourceSvg) return null
    const svg = sourceSvg.cloneNode(true)
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    svg.setAttribute('width', String(pageSize.width))
    svg.setAttribute('height', String(pageSize.height))
    svg.removeAttribute('class')
    svg.removeAttribute('style')
    svg.querySelectorAll('.pdfjs-endpoint-snap-indicator').forEach(node => node.remove())

    return loadSvgImage(new XMLSerializer().serializeToString(svg))
  } finally {
    root.unmount()
    host.remove()
  }
}

function pageOrientation(width, height) {
  return width > height ? 'landscape' : 'portrait'
}

/**
 * Creates a static, all-page copy of the selected drawing. Each original PDF
 * page is rendered first, then the same SVG annotation layer used by the live
 * viewer is painted over it. Nothing is written back to the viewer or server.
 */
export async function exportMarkedUpPdfDocument({
  pdfDocument,
  annotations = [],
  sectionPlacements = [],
  sectionFocuses = [],
  sectionMeasurementColors = [],
  sectionDraftColor = '#3B82F6',
  drawingName,
  onProgress,
}) {
  if (!pdfDocument?.numPages) throw new Error('The drawing is not ready to export')

  let output = null
  const totalPages = pdfDocument.numPages

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    onProgress?.({ page: pageNumber, total: totalPages })
    const page = await pdfDocument.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const pageSize = { width: viewport.width, height: viewport.height }
    const pixelRatio = Math.min(
      EXPORT_RENDER_SCALE,
      MAX_EXPORT_DIMENSION / Math.max(pageSize.width, pageSize.height),
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(pageSize.width * pixelRatio))
    canvas.height = Math.max(1, Math.round(pageSize.height * pixelRatio))
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error(`Page ${pageNumber} could not be prepared`)

    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
      background: '#ffffff',
    })
    await renderTask.promise

    const markupImage = await renderMarkupLayer({
      pageNumber,
      pageSize,
      annotations: annotations.filter(annotation => Number(annotation.pageNumber) === pageNumber),
      sectionPlacements,
      sectionFocuses,
      sectionMeasurementColors,
      sectionDraftColor,
    })
    if (markupImage) context.drawImage(markupImage, 0, 0, canvas.width, canvas.height)

    const orientation = pageOrientation(pageSize.width, pageSize.height)
    if (!output) {
      output = new jsPDF({
        orientation,
        unit: 'pt',
        format: [pageSize.width, pageSize.height],
        compress: true,
      })
    } else {
      output.addPage([pageSize.width, pageSize.height], orientation)
    }

    output.addImage(
      canvas.toDataURL('image/jpeg', 0.96),
      'JPEG',
      0,
      0,
      pageSize.width,
      pageSize.height,
      `drawing-page-${pageNumber}`,
      'FAST',
    )
  }

  const fileName = `${safeFilename(drawingName)}_Marked-Up.pdf`
  output.save(fileName)
  return { fileName, pages: totalPages }
}
