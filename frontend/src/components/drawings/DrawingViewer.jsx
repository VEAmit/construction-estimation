import { forwardRef, lazy, Suspense } from 'react'

const PdfJsViewer = lazy(() => import('./pdfjs/PdfJsViewer'))

const DrawingViewer = forwardRef(function DrawingViewer(props, ref) {
  return (
    <Suspense fallback={<div style={{ width: '100%', height: '100%', background: '#0b1324' }} />}>
      <PdfJsViewer ref={ref} {...props} />
    </Suspense>
  )
})

export default DrawingViewer
