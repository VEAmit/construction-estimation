import api from './api'

export const drawingService = {
  async getByProject(projectId) {
    const res = await api.get(`/drawings/project/${projectId}`)
    return res.data.data
  },
  async getById(id) {
    const res = await api.get(`/drawings/${id}`)
    return res.data.data
  },
  // Returns the raw URL — now AllowAnonymous so no auth header needed
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
    return res.data.data
  },
  async calibrate(id, scaleRatio, unit) {
    await api.put(`/drawings/${id}/calibrate`, { scaleRatio, unit })
  },
  async saveAnnotations(id, annotationData) {
    await api.put(`/drawings/${id}/annotations`, { annotationData })
  },
  async delete(id) {
    await api.delete(`/drawings/${id}`)
  },
}
