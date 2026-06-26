/**
 * Normalizes PDF extraction to mark + section only (what is on the drawing).
 */
export function normalizeExtractedMember(m) {
  const desc = String(m.description ?? m.Description ?? '').trim()
  const memberSize = String(m.memberSize ?? m.MemberSize ?? '').trim()
  let mark = String(m.mark ?? m.Mark ?? '').trim()

  const markFromDesc =
    desc.match(/(?:Schedule|Pattern)\s*:\s*([A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—:]/i)?.[1]
    ?? desc.match(/^([A-Z]{1,4}\d{0,3}[A-Z]?)\s*[-–—:]/i)?.[1]

  if (markFromDesc) {
    mark = markFromDesc.toUpperCase()
  }

  const sectionFromDesc = desc.match(
    /(\d{2,4}\s*(?:UB|UC|PFC|TFC|EA|UA|CHS|RHS|SHS)\s*\d{1,3}(?:\.\d+)?|\d{2,4}(?:UB|UC|PFC)\d{1,3}(?:\.\d+)?|\d{2,3}\s*[xX×]\s*\d{2,3}(?:\s*[xX×]\s*\d{1,2}(?:\.\d+)?)?\s*(?:RHS|SHS|CHS|EA|UA)|RB\d+)/i
  )?.[1]

  let normalizedSize = memberSize
  if (sectionFromDesc) {
    normalizedSize = sectionFromDesc
      .replace(/\s+/g, '')
      .replace(/[xX×]/g, 'X')
      .toUpperCase()
  }

  return {
    mark,
    memberSize: normalizedSize,
    memberType: m.memberType ?? m.MemberType ?? 'Other',
    description: desc,
    confidence: Number(m.confidence ?? m.Confidence ?? 0),
  }
}

function isPatternDescription(desc) {
  return /^Pattern\s*:/i.test(String(desc ?? '').trim())
}

function preferExtractedMember(a, b) {
  const confA = Number(a.confidence ?? 0)
  const confB = Number(b.confidence ?? 0)
  if (confA !== confB) return confA > confB ? a : b

  const patA = isPatternDescription(a.description)
  const patB = isPatternDescription(b.description)
  if (patA !== patB) return patB ? a : b

  const lenA = String(a.memberSize ?? '').length
  const lenB = String(b.memberSize ?? '').length
  if (lenA !== lenB) return lenA > lenB ? a : b

  return a
}

/** One row per mark — same rule as backend extraction merge. */
export function dedupeUniqueByMark(members) {
  const best = new Map()
  for (const m of members) {
    const mark = String(m.mark ?? '').trim().toUpperCase()
    if (!mark) continue
    const existing = best.get(mark)
    best.set(mark, existing ? preferExtractedMember(m, existing) : m)
  }
  return [...best.values()]
}

/** Same A → B1 → B10 order as Member Schedule grid (repository OrderBy Mark). */
export function sortMembersByMark(members) {
  return [...members].sort((a, b) =>
    (a.mark ?? '').localeCompare(b.mark ?? '', undefined, { sensitivity: 'base' })
  )
}
