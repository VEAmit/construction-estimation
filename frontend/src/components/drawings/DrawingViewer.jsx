import { lazy, Suspense } from 'react'

const PdfJsViewer = lazy(() => import('./pdfjs/PdfJsViewer'))

export default function DrawingViewer(props) {
  return (
    <Suspense fallback={<div style={{ width: '100%', height: '100%', background: '#0b1324' }} />}>
      <PdfJsViewer {...props} />
    </Suspense>
  )
}
