import api from './api'

export const takeoffService = {
  async getByDrawing(drawingId) {
    const res = await api.get(`/takeoffitems/drawing/${drawingId}`)
    return res.data.data
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
    })
    return res.data.data
  },

  async update(item) {
    const res = await api.put(`/takeoffitems/${item.id}`, item)
    return res.data.data
  },

  async delete(id) {
    await api.delete(`/takeoffitems/${id}`)
  },

  async getSummary(drawingId) {
    const res = await api.get(`/takeoffitems/drawing/${drawingId}/summary`)
    return res.data.data
  },
}
