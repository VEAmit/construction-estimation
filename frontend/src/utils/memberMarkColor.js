import { getMeasurementMemberMark } from './memberMeasureLink'
import { useAppStore } from '../store/useAppStore'

const HEX_RE = /^#[0-9A-Fa-f]{6}$/

export function normalizeMemberMark(mark) {
  return String(mark ?? '').trim()
}

/** Member mark key for a saved takeoff row (material column or msi-linked schedule mark). */
export function itemMemberMarkKey(item, memberScheduleItems = []) {
  if (!item) return ''
  const material = normalizeMemberMark(item.material)
  if (material) return material
  return normalizeMemberMark(getMeasurementMemberMark(item, memberScheduleItems))
}

/**
 * Color assigned to a member mark.
 * Priority: MemberScheduleItem.color (authoritative palette color) → existing measurement color.
 * Returns null when no color is found.
 */
export function findColorForMemberMark(memberMark, takeoffItems = [], memberScheduleItems = []) {
  const key = normalizeMemberMark(memberMark)
  if (!key) return null
  const keyLower = key.toLowerCase()

  // MSI color is the authoritative source — assigned by palette at extraction time
  for (const msi of memberScheduleItems) {
    const msiMark = normalizeMemberMark(msi.mark ?? msi.Mark)
    if (msiMark.toLowerCase() !== keyLower) continue
    const c = msi.color ?? msi.Color
    if (c && HEX_RE.test(c)) return c
  }

  // Fall back to existing measurement color (Bluebeam first-match)
  for (const item of takeoffItems) {
    const itemKey = itemMemberMarkKey(item, memberScheduleItems)
    if (!itemKey || itemKey.toLowerCase() !== keyLower) continue
    const c = item.color
    if (c && HEX_RE.test(c)) return c
  }
  return null
}

/** Draw/save color: member schedule color or existing measurement color, else toolbar color. */
export function resolveDrawColorForMemberMark(
  memberMark,
  toolbarColor,
  takeoffItems = [],
  memberScheduleItems = [],
) {
  const existing = findColorForMemberMark(memberMark, takeoffItems, memberScheduleItems)
  if (existing) return existing
  const tb = toolbarColor && HEX_RE.test(toolbarColor) ? toolbarColor : '#EF233C'
  return tb
}

/** Effective stroke color for the next measure draw from current store state. */
export function getEffectiveMeasureDrawColor(memberMarkOverride = null) {
  const {
    measureColor,
    takeoffItems,
    memberScheduleItems,
    selectedMemberScheduleItem,
    lastMeasureMember,
  } = useAppStore.getState()

  const active = selectedMemberScheduleItem ?? lastMeasureMember
  const memberMark = memberMarkOverride != null
    ? normalizeMemberMark(memberMarkOverride)
    : normalizeMemberMark(active?.mark ?? active?.Mark)

  return resolveDrawColorForMemberMark(
    memberMark,
    measureColor,
    takeoffItems,
    memberScheduleItems,
  )
}
