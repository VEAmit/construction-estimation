import api from './api'
import { normalizeExtractedMember, dedupeUniqueByMark, sortMembersByMark } from '../utils/extractionNormalize'

export const extractionService = {
  async extract(drawingId) {
    const res = await api.post(`/extraction/drawing/${drawingId}`)
    const data = res.data.data
    const members = sortMembersByMark(
      dedupeUniqueByMark((data?.members ?? data?.Members ?? []).map(normalizeExtractedMember))
    )
    return { ...data, members }
  },

  async confirm(drawingId, members) {
    const items = sortMembersByMark(dedupeUniqueByMark(members)).map(m => ({
      mark: m.mark ?? '',
      memberSize: m.memberSize ?? '',
      memberType: m.memberType ?? 'Other',
      unitWeight: 0,
      length: 0,
      quantity: 0,
      description: m.description ?? '',
      takeoffItemId: m.takeoffItemId ?? null,
      color: m.color ?? null,
    }))
    const res = await api.post(`/extraction/drawing/${drawingId}/confirm`, { items })
    return res.data.data
  },
}
