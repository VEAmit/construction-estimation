import api from './api'

function unwrapApiPayload(res) {
  const body = res?.data ?? res
  if (body == null) return null
  if (body.data !== undefined && body.data !== null) return body.data
  if (body.Data !== undefined && body.Data !== null) return body.Data
  return body
}

export const measurementSectionService = {
  async getByProject(projectId) {
    const res = await api.get(`/measurementsections/project/${projectId}`)
    return unwrapApiPayload(res) ?? []
  },

  async create(projectId, payload) {
    const res = await api.post(`/measurementsections/project/${projectId}`, payload)
    return unwrapApiPayload(res)
  },

  async rename(id, name) {
    const res = await api.put(`/measurementsections/${id}`, { name })
    return unwrapApiPayload(res)
  },

  async updateTemplate(id, payload) {
    const res = await api.put(`/measurementsections/${id}/template`, payload)
    return unwrapApiPayload(res)
  },

  async addPlacement(id, payload) {
    const res = await api.post(`/measurementsections/${id}/placements`, payload)
    return unwrapApiPayload(res)
  },

  async deletePlacement(id, placementId) {
    const res = await api.post(`/measurementsections/${id}/placements/${placementId}/delete`)
    return unwrapApiPayload(res)
  },

  async delete(id) {
    await api.post(`/measurementsections/${id}/delete`)
  },
}
