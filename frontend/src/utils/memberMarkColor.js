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
 * Color assigned to a member mark from existing measurements (first match wins — Bluebeam-style).
 * Returns null when this member has never been measured on the drawing.
 */
export function findColorForMemberMark(memberMark, takeoffItems = [], memberScheduleItems = []) {
  const key = normalizeMemberMark(memberMark)
  if (!key) return null
  const keyLower = key.toLowerCase()

  for (const item of takeoffItems) {
    const itemKey = itemMemberMarkKey(item, memberScheduleItems)
    if (!itemKey || itemKey.toLowerCase() !== keyLower) continue
    const c = item.color
    if (c && HEX_RE.test(c)) return c
  }
  return null
}

/** Draw/save color: existing member color, else toolbar color for first measurement on that mark. */
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
