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

  // Before placement the saved boundary is only a template. Once the section
  // is used, the total contains both its source measurements and every placed
  // copy, matching the base-plus-placement quantities shown in the grid.
  return Math.floor(measurementCount) * (countedPlacements + 1)
}

/**
 * Builds the quantity increases contributed by counted Section Group placements
 * for one PDF. The existing grid quantity already represents the source/base
 * measurements, so it is intentionally not included here.
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

    const placementCount = getSectionPlacementCount(section)
    if (placementCount < 1) continue

    const measurements = readSectionTemplate(section)?.measurements
    if (!Array.isArray(measurements) || measurements.length === 0) continue

    const occurrencesByItem = new Map()
    for (const measurement of measurements) {
      const itemId = positiveId(measurement?.sourceTakeoffItemId)
      if (!itemId) continue
      occurrencesByItem.set(itemId, (occurrencesByItem.get(itemId) ?? 0) + 1)
    }

    for (const [itemId, occurrenceCount] of occurrencesByItem) {
      const sectionQuantity = occurrenceCount * placementCount
      totals.set(itemId, (totals.get(itemId) ?? 0) + sectionQuantity)
    }
  }

  return totals
}
