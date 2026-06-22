/** Structured console tracing for the calibration → measurement pipeline. */

import { useAppStore } from '../store/useAppStore'



const PREFIX = '[BuildTakeoff Calib]'



export function traceCalibration(stage, payload = {}) {

  const ts = new Date().toISOString().slice(11, 23)

  console.log(`${PREFIX} ${ts} ${stage}`, payload)

}



export function traceCalibrationWarn(stage, payload = {}) {

  const ts = new Date().toISOString().slice(11, 23)

  console.warn(`${PREFIX} ${ts} ${stage}`, payload)

}



/** Summarise drawing calibration fields for logs. */

export function calibrationSnapshot(drawing) {

  if (!drawing) return null

  return {

    drawingId: drawing.id ?? drawing.Id ?? null,

    name: drawing.name ?? drawing.Name ?? null,

    isCalibrated: !!(drawing.isCalibrated ?? drawing.IsCalibrated),

    scaleRatio: Number(drawing.scaleRatio ?? drawing.ScaleRatio ?? 0) || 0,

    calibrationUnit: drawing.calibrationUnit ?? drawing.CalibrationUnit ?? null,

  }

}



/** Full measurement pipeline debug — filter console by [BuildTakeoff Calib]. */

export function traceMeasurementDebug(stage, {

  drawing,

  pixelLength,

  pixelArea,

  displayUnit,

  resolved,

  saveLength,

  description,

  fallbackReason,

} = {}) {

  const { selectedProject, selectedDrawing, activeUnit } = useAppStore.getState()

  traceCalibration(stage, {

    projectId: selectedProject?.id ?? selectedProject?.Id ?? null,

    drawingId: drawing?.id ?? selectedDrawing?.id ?? null,

    calibration: calibrationSnapshot(drawing ?? selectedDrawing),

    scaleRatio: drawing?.scaleRatio ?? selectedDrawing?.scaleRatio ?? null,

    unit: displayUnit ?? activeUnit ?? drawing?.calibrationUnit ?? null,

    pixelLength: pixelLength ?? null,

    pixelArea: pixelArea ?? null,

    measurementValue: resolved?.length ?? saveLength ?? null,

    measurementArea: resolved?.area ?? null,

    conversionResult: resolved ?? null,

    description: description ?? null,

    fallbackReason: fallbackReason ?? null,

    entersFallbackMode: !!(fallbackReason || (description && /not calibrated/i.test(description))),

  })

}



/** Merge locally computed scale into API drawing when DB read-back is stale. */

export function mergeCalibrationState(apiDrawing, scaleRatio, unit) {

  if (!apiDrawing || !(scaleRatio > 0)) return apiDrawing

  return { ...apiDrawing, scaleRatio, calibrationUnit: unit, isCalibrated: true }

}


