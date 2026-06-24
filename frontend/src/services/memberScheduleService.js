import api from './api'

export const memberScheduleService = {
  async getByDrawing(drawingId) {
    const res = await api.get(`/memberschedules/drawing/${drawingId}`)
    return res.data.data
  },

  async getSummary(drawingId) {
    const res = await api.get(`/memberschedules/drawing/${drawingId}/summary`)
    return res.data.data
  },

  async create(drawingId, payload) {
    const res = await api.post(`/memberschedules/drawing/${drawingId}`, {
      mark: payload.mark ?? '',
      memberSize: payload.memberSize ?? '',
      memberType: payload.memberType ?? '',
      unitWeight: payload.unitWeight ?? 0,
      length: payload.length ?? 0,
      quantity: payload.quantity ?? 1,
      description: payload.description ?? '',
      takeoffItemId: payload.takeoffItemId ?? null,
    })
    return res.data.data
  },

  async update(item) {
    const res = await api.put(`/memberschedules/${item.id}`, {
      mark: item.mark ?? '',
      memberSize: item.memberSize ?? '',
      memberType: item.memberType ?? '',
      unitWeight: item.unitWeight ?? 0,
      length: item.length ?? 0,
      quantity: item.quantity ?? 1,
      description: item.description ?? '',
      takeoffItemId: item.takeoffItemId ?? null,
    })
    return res.data.data
  },

  async delete(id) {
    await api.post(`/memberschedules/${id}/delete`)
  },
}
