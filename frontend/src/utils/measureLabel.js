// User-facing label sizes (pt) — Bluebeam-style measurement label presets.
export const MEASURE_LABEL_PRESETS = [
  { value: 10, label: 'S', title: 'Small (10pt)' },
  { value: 14, label: 'M', title: 'Medium (14pt)' },
  { value: 18, label: 'L', title: 'Large (18pt)' },
  { value: 24, label: 'XL', title: 'Extra Large (24pt)' },
]

export const DEFAULT_MEASURE_LABEL_SIZE = 14

/** Visual scale tied to each label-size preset (line + arrows + end caps). */
const LINE_LABEL_VISUAL_SCALE = {
  10: { defaultThickness: 1, leaderLength: 22, leaderLineExtension: 2 },
  14: { defaultThickness: 2, leaderLength: 30, leaderLineExtension: 2 },
  18: { defaultThickness: 3, leaderLength: 38, leaderLineExtension: 3 },
  24: { defaultThickness: 5, leaderLength: 48, leaderLineExtension: 4 },
}

export function defaultLineThicknessForLabelSize(userPt) {
  return LINE_LABEL_VISUAL_SCALE[userPt]?.defaultThickness
    ?? LINE_LABEL_VISUAL_SCALE[DEFAULT_MEASURE_LABEL_SIZE].defaultThickness
}

export function resolveLinearThickness(userPt, thicknessOverride) {
  if (thicknessOverride != null && thicknessOverride > 0) return thicknessOverride
  return defaultLineThicknessForLabelSize(userPt)
}

function hexToRgba(hex, alpha) {
  const safe = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : '#111827'
  const r = parseInt(safe.slice(1, 3), 16)
  const g = parseInt(safe.slice(3, 5), 16)
  const b = parseInt(safe.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * Syncfusion renders labels in PDF coordinate space. Convert the user-selected
 * point size to a Syncfusion fontSize and compensate for zoom so labels stay
 * readable on screen (Bluebeam-style).
 */
export function toSyncfusionLabelSize(userPt, pdfScale = 1) {
  const scale = Math.max(pdfScale, 0.25)
  const base = userPt * 2.35
  return Math.max(12, Math.min(72, Math.round(base / scale)))
}

/** Map toolbar arrow style → Syncfusion distance line-head styles. */
export function mapLinearArrowStyle(arrowStyle = 'none') {
  switch (arrowStyle) {
    case 'start':
      return { lineHeadStartStyle: 'ClosedArrow', lineHeadEndStyle: 'Closed' }
    case 'end':
      return { lineHeadStartStyle: 'Closed', lineHeadEndStyle: 'ClosedArrow' }
    case 'both':
      return { lineHeadStartStyle: 'ClosedArrow', lineHeadEndStyle: 'ClosedArrow' }
    default:
      return { lineHeadStartStyle: 'Closed', lineHeadEndStyle: 'Closed' }
  }
}

export function buildMeasureLabelPatch(userPt, pdfScale, fontColor = '#111827') {
  const sfSize = toSyncfusionLabelSize(userPt, pdfScale)
  const haloFill = 'rgba(255,255,255,0.94)'
  const haloBorder = hexToRgba(fontColor, 0.45)
  return {
    fontSize: sfSize,
    fontColor,
    labelFillColor: haloFill,
    labelBorderColor: haloBorder,
    labelSettings: {
      fontSize: sfSize,
      fontColor,
      fillColor: haloFill,
      borderColor: haloBorder,
    },
  }
}

/**
 * Unified Bluebeam-style linear measure appearance: label text, line weight,
 * end-cap leaders, and arrow heads scale together from Label Size (S/M/L/XL).
 * `thicknessOverride` keeps the toolbar Thickness control as an advanced override.
 */
export function buildLinearDistanceStyle(userPt, pdfScale, fontColor = '#111827', thicknessOverride, arrowStyle = 'none') {
  const preset = LINE_LABEL_VISUAL_SCALE[userPt] ?? LINE_LABEL_VISUAL_SCALE[DEFAULT_MEASURE_LABEL_SIZE]
  const thickness = resolveLinearThickness(userPt, thicknessOverride)
  return {
    thickness,
    leaderLength: preset.leaderLength,
    leaderLineExtension: preset.leaderLineExtension,
    ...mapLinearArrowStyle(arrowStyle),
    ...buildMeasureLabelPatch(userPt, pdfScale, fontColor),
  }
}

/** Style fields applied to live Syncfusion diagram text (label halo + size). */
export function buildLinearLabelDiagramStyle(userPt, pdfScale, fontColor = '#111827') {
  const patch = buildMeasureLabelPatch(userPt, pdfScale, fontColor)
  return {
    fontSize: patch.fontSize,
    fontColor: patch.fontColor,
    labelFillColor: patch.labelFillColor,
    labelBorderColor: patch.labelBorderColor,
  }
}
