import api from './api'

function unwrapApiPayload(res) {
  const body = res?.data ?? res
  if (body == null) return null
  if (body.data !== undefined && body.data !== null) return body.data
  if (body.Data !== undefined && body.Data !== null) return body.Data
  return body
}

export const takeoffService = {
  async getByDrawing(drawingId) {
    const res = await api.get(`/takeoffitems/drawing/${drawingId}`)
    return unwrapApiPayload(res)
  },

  async create(payload) {
    const { drawingId, ...data } = payload
    const res = await api.post(`/takeoffitems/drawing/${drawingId}`, {
      mark:        data.mark        ?? '',
      description: data.description ?? '',
      itemType:    data.itemType    ?? 'Other',
      length:      data.length      ?? null,
      area:        data.area        ?? null,
      quantity:    data.quantity    ?? 1,
      unit:        data.unit        ?? 'Mm',
      material:    data.material    ?? '',
      unitWeight:  data.unitWeight  ?? null,
      totalWeight: data.totalWeight ?? null,
      notes:       data.notes       ?? '',
      pointsJson:  data.pointsJson  ?? null,
      color:       data.color       ?? null,
      category:    data.category    ?? null,
      scaleRatioAtCreation:      data.scaleRatioAtCreation      ?? null,
      calibrationUnitAtCreation: data.calibrationUnitAtCreation ?? null,
    })
    return unwrapApiPayload(res)
  },

  async update(item) {
    const res = await api.put(`/takeoffitems/${item.id}`, item)
    return unwrapApiPayload(res)
  },

  async delete(id) {
    await api.post(`/takeoffitems/${id}/delete`)
  },

  async getSummary(drawingId) {
    const res = await api.get(`/takeoffitems/drawing/${drawingId}/summary`)
    return unwrapApiPayload(res)
  },
}
