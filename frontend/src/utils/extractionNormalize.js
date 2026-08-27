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
    color: m.color ?? m.Color ?? null,
  }
}

/**
 * Presentation-only cleanup for the extraction review table. The backend keeps
 * the untouched description as extraction evidence; this removes only parser
 * labels and the repeated leading mark so "PDF source line" starts with the
 * actual material/note printed beside that mark.
 */
export function formatPdfSourceLine(description, mark) {
  let source = String(description ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  source = source
    .replace(/^(?:Schedule(?:\s+row)?|Pattern)\s*:\s*/i, '')
    .replace(/^[•·▪◦]\s*/, '')
    .trim()

  const compactMark = String(mark ?? '').replace(/\s+/g, '')
  if (!compactMark) return source

  const escapedMark = [...compactMark]
    .map(character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*')
  const repeatedLeadingMark = new RegExp(
    `^(?:${escapedMark})(?=\\s|[-–—:]|$)[\\s:–—-]*`,
    'i',
  )

  // A few PDFs repeat the mark more than once before the material. Remove
  // only consecutive leading copies; a mark found later in a note is kept.
  while (repeatedLeadingMark.test(source)) {
    source = source.replace(repeatedLeadingMark, '').trim()
  }

  return source
}

/**
 * Removes only rows that would be visually identical in the extraction
 * review. Different sections or material/source text for the same mark remain
 * separate so valid schedule variants are never collapsed.
 */
export function dedupeExactExtractedMembers(members) {
  const seen = new Set()
  return members.filter(member => {
    const key = [
      normalizeIdentityPart(member.mark),
      normalizeIdentityPart(member.memberSize),
      normalizeIdentityPart(member.memberType),
      normalizeIdentityPart(formatPdfSourceLine(member.description, member.mark)),
    ].join('|')

    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
