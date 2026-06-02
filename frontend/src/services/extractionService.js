import api from './api'

export const extractionService = {
  async extract(drawingId) {
    const res = await api.post(`/extraction/drawing/${drawingId}`)
    return res.data.data
  },

  async confirm(drawingId, members) {
    const items = members.map(m => ({
      mark: m.mark ?? '',
      memberSize: m.memberSize ?? '',
      memberType: m.memberType ?? 'Other',
      unitWeight: parseFloat(m.unitWeight) || 0,
      length: parseFloat(m.length) || 0,
      quantity: parseInt(m.quantity, 10) || 1,
      description: m.description ?? '',
      takeoffItemId: m.takeoffItemId ?? null,
    }))
    const res = await api.post(`/extraction/drawing/${drawingId}/confirm`, { items })
    return res.data.data
  },
}
