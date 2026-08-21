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

function getPlacementCount(section) {
  if (Array.isArray(section?.placements) && section.placements.length > 0) {
    return section.placements.filter(placement => (
      placement?.isDeleted !== true && placement?.IsDeleted !== true
    )).length
  }

  const usedPlaces = Number(section?.usedPlaces)
  return Number.isFinite(usedPlaces) && usedPlaces > 0 ? Math.floor(usedPlaces) : 0
}

/**
 * Builds calculated measurement quantities for Section Groups owned by one PDF.
 *
 * A template can contain several visual occurrences backed by the same saved
 * TakeoffItem row. Counting those references before multiplying by the number
 * of saved placements keeps one grid row while still producing, for example,
 * two occurrences x three placements = quantity six.
 */
export function buildSectionQuantityByTakeoffItem(sections, sourceDrawingId) {
  const drawingId = positiveId(sourceDrawingId)
  const totals = new Map()
  if (!drawingId) return totals

  for (const section of sections ?? []) {
    if (positiveId(section?.sourceDrawingId) !== drawingId) continue

    const placementCount = getPlacementCount(section)
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
