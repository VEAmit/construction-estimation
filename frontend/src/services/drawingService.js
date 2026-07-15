import api from './api'
import { normalizeDrawing } from '../utils/measureCalibration'
import { calibrationSnapshot, traceCalibration, traceCalibrationWarn } from '../utils/calibrationTrace'

/** Unwrap ApiResponse payload — supports camelCase `data` and PascalCase `Data`. */
function unwrapApiPayload(res) {
  const body = res?.data ?? res
  if (body == null) return null
  if (body.data !== undefined && body.data !== null) return body.data
  if (body.Data !== undefined && body.Data !== null) return body.Data
  return body
}

function traceDrawingLoad(source, raw) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
  traceCalibration(`drawing.load.${source}`, {
    count: list.length,
    first: list[0] ? calibrationSnapshot(list[0]) : null,
  })
  list.forEach((d, i) => {
    const snap = calibrationSnapshot(d)
    if (snap.isCalibrated && !(snap.scaleRatio > 0)) {
      traceCalibrationWarn('drawing.load.invalidCalibration', { index: i, ...snap })
    }
  })
}

export const drawingService = {
  async getByProject(projectId) {
    const res = await api.get(`/drawings/project/${projectId}`)
    const raw = unwrapApiPayload(res)
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
    traceDrawingLoad('getByProject', list)
    return list
  },
  async getById(id) {
    const res = await api.get(`/drawings/${id}`)
    const raw = unwrapApiPayload(res)
    traceDrawingLoad('getById', raw)
    return raw
  },
  getFileUrl(id) {
    return `/api/drawings/${id}/file`
  },
  async upload(projectId, file, onProgress) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await api.post(`/drawings/upload/${projectId}`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total))
      },
    })
    const raw = unwrapApiPayload(res)
    traceCalibration('drawing.upload', calibrationSnapshot(raw))
    return raw
  },
  async resetCalibration(id) {
    await api.post(`/drawings/${id}/reset-calibration`)
    const refreshed = normalizeDrawing(await this.getById(id))
    traceCalibration('calibration.reset', calibrationSnapshot(refreshed))
    return refreshed
  },

  async calibrate(id, scaleRatio, unit) {
    traceCalibration('calibration.save.request', { drawingId: id, scaleRatio, unit })
    await api.post(`/drawings/${id}/calibrate`, { scaleRatio, unit })
    const verified = normalizeDrawing(await this.getById(id))
    traceCalibration('calibration.save.verified', calibrationSnapshot(verified))
    if (!verified?.isCalibrated) {
      traceCalibrationWarn('calibration.save.failedState', {
        drawingId: id,
        sent: { scaleRatio, unit },
        received: calibrationSnapshot(verified),
      })
      // The write appeared to succeed (no HTTP error) but the drawing doesn't come
      // back calibrated — surface this instead of letting the caller believe the
      // new scale is active when it silently isn't.
      throw new Error('Calibration was saved but did not take effect — please try again')
    }
    return verified
  },
  async saveAnnotations(id, annotationData) {
    await api.put(`/drawings/${id}/annotations`, { annotationData })
  },
  async delete(id) {
    await api.post(`/drawings/${id}/delete`)
  },
}
