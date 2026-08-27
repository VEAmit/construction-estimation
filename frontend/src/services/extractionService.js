import api from './api'
import {
  normalizeExtractedMember,
  dedupeUniqueByMarkAndSection,
  sortMembersByMark,
} from '../utils/extractionNormalize'

export const extractionService = {
  async extract(drawingId) {
    const res = await api.post(`/extraction/drawing/${drawingId}`)
    const data = res.data.data
    // The extraction preview is a review surface, so it must show every row the
    // server found. De-duplicating here changed a stable 159-row response into
    // 116 visible rows and made Re-scan appear non-deterministic. The confirm
    // path below still de-duplicates by the persisted Mark + Section identity,
    // preserving the existing database/import behaviour.
    const members = sortMembersByMark(
      (data?.members ?? data?.Members ?? []).map(normalizeExtractedMember)
    )
    return { ...data, members }
  },

  async confirm(drawingId, members) {
    const items = sortMembersByMark(dedupeUniqueByMarkAndSection(members)).map(m => ({
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
    const data = res.data.data
    // Keep compatibility with an older API build that returned only a count.
    return typeof data === 'number'
      ? { savedCount: data, addedCount: data, updatedCount: 0 }
      : {
          savedCount: Number(data?.savedCount ?? data?.SavedCount ?? 0),
          addedCount: Number(data?.addedCount ?? data?.AddedCount ?? 0),
          updatedCount: Number(data?.updatedCount ?? data?.UpdatedCount ?? 0),
        }
  },

  async detectMark(drawingId, payload) {
    const res = await api.post(`/extraction/drawing/${drawingId}/detect-mark`, {
      pageNumber: payload.pageNumber ?? 1,
      points: (payload.points ?? []).map(p => ({
        x: Number(p.x ?? p.X ?? 0),
        y: Number(p.y ?? p.Y ?? 0),
      })),
      knownMarks: payload.knownMarks ?? [],
    })
    return res.data.data
  },
}
