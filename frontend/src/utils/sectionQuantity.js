function readSectionTemplate(section) {
  try {
    const template = typeof section?.templateJson === 'string'
      ? JSON.parse(section.templateJson)
      : section?.templateJson
    return template && typeof template === 'object' ? template : null
  } catch {
    return null
  }
}

function positiveId(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function isDeletedPlacement(placement) {
  return placement?.isDeleted === true || placement?.IsDeleted === true
}

function isSourcePlacement(placement) {
  return placement?.isSource === true || placement?.IsSource === true
}

export function getCountedSectionPlacements(section) {
  if (!Array.isArray(section?.placements)) return []
  return section.placements.filter(placement => (
    !isDeletedPlacement(placement) && !isSourcePlacement(placement)
  ))
}

export function getSectionPlacementCount(section) {
  // When placements are present they are authoritative. The source placement
  // only records where the reusable template was created and is never usage.
  if (Array.isArray(section?.placements)) {
    return getCountedSectionPlacements(section).length
  }

  const usedPlaces = Number(section?.usedPlaces)
  return Number.isFinite(usedPlaces) && usedPlaces > 0 ? Math.floor(usedPlaces) : 0
}

export function getSectionGroupQuantity(section) {
  const countedPlacements = getSectionPlacementCount(section)
  if (countedPlacements < 1) return 0

  const measurementCount = Number(section?.measurementCount)
  if (!Number.isFinite(measurementCount) || measurementCount < 1) return 0

  // The saved source boundary is only a reusable template and never adds an
  // extra group occurrence. Group Qty is exactly the measurements contained
  // in the template multiplied by the counted placement locations.
  return Math.floor(measurementCount) * countedPlacements
}

/**
 * Maps each original TakeoffItem row to the project Section Groups whose saved
 * template contains that row. Membership is read-only display metadata: the
 * TakeoffItem records and their ordering/quantities are never mutated here.
 */
export function buildSectionMembershipByTakeoffItem(sections, sourceDrawingId) {
  const drawingId = positiveId(sourceDrawingId)
  const memberships = new Map()
  if (!drawingId) return memberships

  for (const section of sections ?? []) {
    if (positiveId(section?.sourceDrawingId) !== drawingId) continue

    const measurements = readSectionTemplate(section)?.measurements
    if (!Array.isArray(measurements) || measurements.length === 0) continue

    const sectionInfo = {
      id: positiveId(section?.id),
      name: String(section?.name ?? 'Section').trim() || 'Section',
      color: String(section?.color ?? '#3B82F6'),
    }
    const itemIds = new Set(measurements
      .map(measurement => positiveId(measurement?.sourceTakeoffItemId))
      .filter(Boolean))

    for (const itemId of itemIds) {
      const current = memberships.get(itemId) ?? []
      current.push(sectionInfo)
      memberships.set(itemId, current)
    }
  }

  memberships.forEach(items => items.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })))
  return memberships
}

/**
 * Builds the quantity increases contributed by counted Section Group placements
 * for one PDF. The existing grid quantity already represents the first counted
 * occurrence, so placement one changes Used/Group Qty without increasing the
 * grid. Only placements after the first add copies to the existing quantity.
 *
 * A template can contain several visual occurrences backed by the same saved
 * TakeoffItem row. Counting those references before multiplying by the number
 * of counted placements keeps one grid row while still adding, for example,
 * two occurrences x three placements = six to its existing quantity.
 */
export function buildSectionQuantityByTakeoffItem(sections, sourceDrawingId) {
  const drawingId = positiveId(sourceDrawingId)
  const totals = new Map()
  if (!drawingId) return totals

  for (const section of sections ?? []) {
    if (positiveId(section?.sourceDrawingId) !== drawingId) continue

    const additionalPlacementCount = Math.max(0, getSectionPlacementCount(section) - 1)
    if (additionalPlacementCount < 1) continue

    const measurements = readSectionTemplate(section)?.measurements
    if (!Array.isArray(measurements) || measurements.length === 0) continue

    const occurrencesByItem = new Map()
    for (const measurement of measurements) {
      const itemId = positiveId(measurement?.sourceTakeoffItemId)
      if (!itemId) continue
      occurrencesByItem.set(itemId, (occurrencesByItem.get(itemId) ?? 0) + 1)
    }

    for (const [itemId, occurrenceCount] of occurrencesByItem) {
      const sectionQuantity = occurrenceCount * additionalPlacementCount
      totals.set(itemId, (totals.get(itemId) ?? 0) + sectionQuantity)
    }
  }

  return totals
}
