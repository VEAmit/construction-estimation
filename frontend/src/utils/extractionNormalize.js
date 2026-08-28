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
    /(\d{2,4}\s*(?:UB|UC|PFC|TFC|EA|UA|CHS|RHS|SHS)\s*\d{1,3}(?:\.\d+)?|\d{2,4}(?:UB|UC|PFC)\d{1,3}(?:\.\d+)?|\d{2,3}\s*[xX×]\s*\d{2,3}(?:\s*[xX×]\s*\d{1,2}(?:\.\d+)?)?\s*(?:RHS|SHS|CHS|EA|UA))/i
  )?.[1]

  let normalizedSize = memberSize
  // The API memberSize is authoritative. Description recovery must never let a
  // mark token (for example RB1) replace its actual material (for example
  // 125x125x6.0 SHS). Reid-bar sections remain intact through memberSize.
  if (sectionFromDesc && normalizeIdentityPart(sectionFromDesc) !== normalizeIdentityPart(mark)) {
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
    color: m.color ?? m.Color ?? null,
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

function normalizeIdentityPart(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, '')
    .replace(/[xX×]/g, 'X')
    .toUpperCase()
}

/**
 * Project schedule identity: Mark + Section. This removes an exact duplicate
 * extracted from another drawing while preserving a same-mark/different-section
 * row because that is a distinct project schedule item.
 */
export function dedupeUniqueByMarkAndSection(members) {
  const best = new Map()
  for (const member of members) {
    const mark = normalizeIdentityPart(member.mark)
    if (!mark) continue
    const key = `${mark}|${normalizeIdentityPart(member.memberSize)}`
    const existing = best.get(key)
    best.set(key, existing ? preferExtractedMember(member, existing) : member)
  }
  return [...best.values()]
}

/** Same A → B1 → B10 order as Member Schedule grid (repository OrderBy Mark). */
export function sortMembersByMark(members) {
  return [...members].sort((a, b) =>
    (a.mark ?? '').localeCompare(b.mark ?? '', undefined, { sensitivity: 'base' })
  )
}
