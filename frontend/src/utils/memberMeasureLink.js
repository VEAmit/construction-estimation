/** Links a takeoff row to a member schedule item via notes (no backend schema change). */
export const MEMBER_SCHEDULE_NOTE_PREFIX = 'msi:'

export function memberScheduleNoteId(memberId) {
  if (memberId == null || memberId === '') return ''
  return `${MEMBER_SCHEDULE_NOTE_PREFIX}${memberId}`
}

export function parseMemberScheduleNoteId(notes) {
  const s = String(notes ?? '').trim()
  if (!s.startsWith(MEMBER_SCHEDULE_NOTE_PREFIX)) return null
  const id = parseInt(s.slice(MEMBER_SCHEDULE_NOTE_PREFIX.length), 10)
  return Number.isFinite(id) ? id : null
}

/** Member mark shown in the Measurement grid (PF7). */
export function getMeasurementMemberMark(item, memberScheduleItems = []) {
  if (item?.material) return item.material
  const msiId = parseMemberScheduleNoteId(item?.notes)
  if (msiId == null) return ''
  const member = memberScheduleItems.find(m => m.id === msiId)
  return member?.mark ?? ''
}
