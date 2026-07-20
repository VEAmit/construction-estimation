# PDF.js Migration - Phase 2

## 1. Analysis

The previous drawing component combined Syncfusion document rendering with measurement interaction. During zoom, Syncfusion could clear or recreate a page surface before its replacement render completed, producing the visible blank-page interval on large drawings.

The backend already exposes `GET /api/drawings/{id}/file` with HTTP range processing. The existing APIs, database, calibration, schedule extraction, OCR, and export services do not require changes for PDF.js rendering.

## 2. Changes

- Added a viewer-neutral `DrawingViewer` boundary.
- Made PDF.js the active document and text renderer.
- Load PDFs directly from the existing byte-range URL without Base64 conversion.
- Render visible and near-visible pages only.
- Render into a staging canvas and replace the displayed bitmap only after completion.
- Reuse exact and nearest-scale cached bitmaps while zoom rendering is in progress.
- Added a React SVG overlay and a `pointsJson` geometry adapter for existing line measurements.
- Kept page, zoom, fit, pan, selection, dragging, two-click line creation, and translated paste integrated with the existing store and callbacks.

## 3. Files Modified

- `frontend/src/pages/DrawingsPage.jsx`
- `frontend/src/main.jsx`
- `frontend/src/index.css`
- `frontend/src/components/drawings/DrawingViewer.jsx`
- `frontend/src/components/drawings/pdfjs/PdfJsViewer.jsx`
- `frontend/src/components/drawings/pdfjs/PdfJsPage.jsx`
- `frontend/src/components/drawings/pdfjs/PdfSvgOverlay.jsx`
- `frontend/src/components/drawings/pdfjs/pdfGeometryAdapter.js`
- `frontend/src/components/drawings/pdfjs/pdfJsViewer.css`

## 4. Why

PDF.js now owns only PDF loading and rendering. The SVG overlay reads and emits the existing application payloads, keeping the rendering engine separate from takeoff business logic. Existing projects remain compatible because their stored `pointsJson` is normalized at the viewer boundary.

## 5. Risks

- Browser canvas limits still apply at extreme zoom. Output resolution is capped at device pixel ratio 2.
- Mixed-size pages update from their actual PDF metadata as it is loaded.
- Non-linear drawing tools are separate migration phases; persisted area, perimeter, and count geometry can already be displayed by the neutral overlay.

## 6. Testing Checklist

- [x] Production frontend build.
- [x] Existing drawing endpoint used as a URL with range loading enabled.
- [x] No Syncfusion viewer or notification DOM mounted at runtime.
- [x] `123456.pdf` rendered and retained content through rapid zoom changes.
- [x] Large ROC drawing rendered and retained content through rapid zoom changes.
- [x] Existing saved line geometry and labels rendered through the SVG overlay.
- [x] Backend, API, SQL schema, extraction, OCR, export, and calibration services unchanged.

## 7. Implementation

The active renderer provides:

- HTTP range loading
- visible and near-visible page rendering
- cancellable render tasks
- completed-bitmap retention during zoom
- bounded canvas caching
- device-pixel-ratio-aware output
- selectable PDF.js text layer
- fit width and fit page
- page and zoom store synchronization
- mouse and middle-button pan
- viewer-neutral SVG measurement rendering
- PDF-coordinate line creation, movement, and paste placement
