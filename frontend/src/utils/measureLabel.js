// User-facing label sizes (pt) — similar to Bluebeam measurement label presets.
export const MEASURE_LABEL_PRESETS = [
  { value: 10, label: 'S', title: 'Small (10pt)' },
  { value: 14, label: 'M', title: 'Medium (14pt)' },
  { value: 18, label: 'L', title: 'Large (18pt)' },
  { value: 24, label: 'XL', title: 'Extra Large (24pt)' },
]

export const DEFAULT_MEASURE_LABEL_SIZE = 14

/**
 * Syncfusion renders labels in PDF coordinate space. Convert the user-selected
 * point size to a Syncfusion fontSize and compensate for zoom so labels stay
 * roughly the same readable size on screen (Bluebeam-style behaviour).
 */
export function toSyncfusionLabelSize(userPt, pdfScale = 1) {
  const scale = Math.max(pdfScale, 0.25)
  const base = userPt * 2.2
  return Math.max(10, Math.min(64, Math.round(base / scale)))
}

export function buildMeasureLabelPatch(userPt, pdfScale, fontColor = '#111827') {
  const sfSize = toSyncfusionLabelSize(userPt, pdfScale)
  return {
    fontSize: sfSize,
    fontColor,
    labelFillColor: 'rgba(255,255,255,0.88)',
    labelBorderColor: 'rgba(0,0,0,0.18)',
    labelSettings: {
      fontSize: sfSize,
      fontColor,
      fillColor: 'rgba(255,255,255,0.88)',
      borderColor: 'rgba(0,0,0,0.18)',
    },
  }
}
