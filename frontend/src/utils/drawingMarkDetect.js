/** Drawing member marks on plan (PF7, CJ1, SF3, …) — same shape as backend extraction. */
const MARK_TOKEN_RE = /\b([A-Z]{1,4}\d{0,3}[A-Z]?)\b/gi
const STRUCTURAL_SECTION_TOKEN_RE = /\b(\d+(?:\.\d+)?\s*[X×]\s*\d+(?:\.\d+)?\s*(?:CHS|SHS|RHS|PFC|TFC|UB|UC|WB|WC|EA|UA)|\d+(?:\.\d+)?\s*(?:UB|UC|WB|WC|PFC|TFC|CHS|SHS|RHS|EA|UA)\s*\d+(?:\.\d+)?)\b/gi

const EXCLUDED_MARKS = new Set([
  'MM', 'CM', 'M', 'FT', 'IN', 'YD', 'KG', 'NO', 'YES', 'MAX', 'MIN', 'PDF',
  'UB', 'UC', 'PFC', 'TFC', 'RHS', 'SHS', 'CHS', 'EA', 'UA', 'RSJ', 'RB',
])

export function isPlausibleDrawingMark(token, knownMarks = []) {
  const u = String(token ?? '').trim().toUpperCase()
  if (!u || u.length > 8) return false
  if (EXCLUDED_MARKS.has(u)) return false
  if (!/^[A-Z]{1,4}\d{0,3}[A-Z]?$/.test(u)) return false
  if (!/[A-Z]/.test(u)) return false
  if (/^\d+[A-Z]?$/.test(u)) return false
  // Free-form all-letter text is usually title-block/company/note text (for
  // example "BLACK", "PTY" or "LTD"), not a drawing member mark. Preserve
  // legitimate letter-only schedule marks only when the schedule already
  // identifies them explicitly.
  if (!/\d/.test(u)) {
    const known = new Set(knownMarks.map(mark => String(mark ?? '').trim().toUpperCase()))
    if (!known.has(u)) return false
  }
  return true
}

function resolvePdfPageElement(vm, pageIndex) {
  const rootId = vm?.element?.id ?? 'sfPdfViewer'
  return document.getElementById(`${rootId}_pageDiv_${pageIndex}`)
    ?? document.getElementById(`${rootId}_pageCanvas_${pageIndex}`)
    ?? document.querySelector(`#${rootId} [id$="_pageDiv_${pageIndex}"]`)
}

function getPdfPageSize(vm, pageIndex, getPageMeta) {
  const meta = getPageMeta?.()
  if (meta?.width > 0 && meta?.height > 0) {
    return { width: meta.width, height: meta.height }
  }
  const vb = vm?.viewerBase
  if (!vb) return null
  const w = Array.isArray(vb.pageWidth) ? vb.pageWidth[pageIndex] : vb.pageWidth
  const h = Array.isArray(vb.pageHeight) ? vb.pageHeight[pageIndex] : vb.pageHeight
  if (Number(w) > 0 && Number(h) > 0) return { width: Number(w), height: Number(h) }
  return null
}

function pdfPointToContainerCoords(pdfX, pdfY, pageIndex, vm, containerEl, getPageMeta) {
  const pageEl = resolvePdfPageElement(vm, pageIndex)
  if (!pageEl || !containerEl) return null
  const pageRect = pageEl.getBoundingClientRect()
  const containerRect = containerEl.getBoundingClientRect()
  const pageSize = getPdfPageSize(vm, pageIndex, getPageMeta)
  if (pageSize) {
    return {
      left: pageRect.left - containerRect.left + pdfX * (pageRect.width / pageSize.width),
      top: pageRect.top - containerRect.top + pdfY * (pageRect.height / pageSize.height),
    }
  }
  return {
    left: pageRect.left - containerRect.left + pdfX,
    top: pageRect.top - containerRect.top + pdfY,
  }
}

function samplePointsAlongLine(pts) {
  if (!pts?.length) return []
  if (pts.length < 2) return [pts[0]]
  const a = pts[0]
  const b = pts[pts.length - 1]
  const out = []
  for (let i = 0; i <= 4; i++) {
    const t = i / 4
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  }
  return out
}

function addMarkCandidatesFromText(text, dist, candidates, knownMarks) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return
  const knownUpper = new Set(knownMarks.map(m => String(m).trim().toUpperCase()))
  const upper = trimmed.toUpperCase()

  if (isPlausibleDrawingMark(upper, knownMarks)) {
    candidates.push({
      mark: upper,
      dist,
      exact: true,
      inSchedule: knownUpper.has(upper),
    })
  }

  for (const m of trimmed.matchAll(MARK_TOKEN_RE)) {
    const token = m[1].toUpperCase()
    if (!isPlausibleDrawingMark(token, knownMarks)) continue
    candidates.push({
      mark: token,
      dist,
      exact: upper === token,
      inSchedule: knownUpper.has(token),
    })
  }

  // Some drawings label a member directly with its structural section rather
  // than a schedule mark (for example 139.7x3.5CHS). Keep the existing mark
  // detector unchanged and add these as a second, tightly-scoped candidate
  // type so an unmatched section can be offered to the user for schedule add.
  for (const match of trimmed.matchAll(STRUCTURAL_SECTION_TOKEN_RE)) {
    const token = match[1]
      .replace(/\s+/g, '')
      .replace(/×/g, 'X')
      .toUpperCase()
      .replace(/(\d)X(?=\d)/g, '$1x')
    const tokenUpper = token.toUpperCase()
    candidates.push({
      mark: token,
      dist,
      exact: upper.replace(/\s+/g, '').replace(/×/g, 'X') === tokenUpper,
      inSchedule: knownUpper.has(tokenUpper),
      structuralSection: true,
    })
  }
}

function pickBestMark(candidates, knownMarks = []) {
  if (!candidates.length) return ''
  const knownMap = new Map(
    knownMarks.map(m => [String(m).trim().toUpperCase(), String(m).trim()]),
  )
  let best = ''
  let bestScore = -1
  for (const c of candidates) {
    const u = String(c.mark).trim().toUpperCase()
    if (!c.structuralSection && !isPlausibleDrawingMark(u, knownMarks)) continue
    let score = 120 - Math.min(c.dist, 119)
    if (c.exact) score += 35
    if (c.inSchedule) score += 15
    if (c.structuralSection) score += 10
    if (score > bestScore) {
      bestScore = score
      best = knownMap.get(u) ?? String(c.mark).trim()
    }
  }
  return best
}

/** PDF.js text items — primary source (Syncfusion WASM renders text on canvas). */
function collectFromPdfTextItems(textItems, pts, candidates, knownMarks) {
  const samples = samplePointsAlongLine(pts)
  for (const pdfPt of samples) {
    for (const item of textItems) {
      const t = String(item.str ?? item.text ?? '').trim()
      if (!t || t.length > 32) continue
      const tx = item.transform
      if (!tx || tx.length < 6) continue
      const ix = Number(tx[4]) || 0
      const iy = Number(tx[5]) || 0
      const iw = Number(item.width) || 0
      const ih = Math.abs(Number(tx[3]) || 10)
      const cx = ix + iw / 2
      const cy = iy - ih / 2
      const dist = Math.hypot(pdfPt.x - cx, pdfPt.y - cy)
      if (dist > 90) continue
      addMarkCandidatesFromText(t, dist, candidates, knownMarks)
    }
  }
}

function collectFromElementsFromPoint(screenX, screenY, candidates, knownMarks) {
  const radius = 32
  for (let dx = -radius; dx <= radius; dx += 16) {
    for (let dy = -radius; dy <= radius; dy += 16) {
      let els
      try { els = document.elementsFromPoint(screenX + dx, screenY + dy) } catch { continue }
      for (const el of els) {
        const t = (el.textContent ?? '').trim()
        if (!t || t.length > 32) continue
        const r = el.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const dist = Math.hypot(cx - screenX, cy - screenY)
        addMarkCandidatesFromText(t, dist, candidates, knownMarks)
      }
    }
  }
}

function collectFromTextLayerSpans(pageEl, screenX, screenY, candidates, knownMarks) {
  const spans = pageEl.querySelectorAll('span, text, tspan, [class*="text"]')
  spans.forEach(span => {
    const t = (span.textContent ?? '').trim()
    if (!t || t.length > 32) return
    const r = span.getBoundingClientRect()
    if (r.width < 0.5 && r.height < 0.5) return
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const dist = Math.hypot(cx - screenX, cy - screenY)
    if (dist > 120) return
    addMarkCandidatesFromText(t, dist, candidates, knownMarks)
  })
}

/**
 * Find a plan label (PF7, CJ1, …) near a drawn measurement line.
 * Uses PDF.js text (primary) + DOM text layer fallback.
 */
export function detectMarkNearMeasureLine(
  vm, pageIndex, containerEl, pts, knownMarks = [], getPageMeta, pageTextItems,
) {
  if (!pts?.length) return ''

  const candidates = []

  if (pageTextItems?.length) {
    collectFromPdfTextItems(pageTextItems, pts, candidates, knownMarks)
  }

  if (vm && containerEl) {
    const pageEl = resolvePdfPageElement(vm, pageIndex)
    if (pageEl) {
      const containerRect = containerEl.getBoundingClientRect()
      for (const pdfPt of samplePointsAlongLine(pts)) {
        const client = pdfPointToContainerCoords(pdfPt.x, pdfPt.y, pageIndex, vm, containerEl, getPageMeta)
        if (!client) continue
        const screenX = containerRect.left + client.left
        const screenY = containerRect.top + client.top
        collectFromElementsFromPoint(screenX, screenY, candidates, knownMarks)
        collectFromTextLayerSpans(pageEl, screenX, screenY, candidates, knownMarks)
      }
    }
  }

  return pickBestMark(candidates, knownMarks)
}

/** Load per-page PDF.js text items for mark detection ({ 0: items[], 1: items[] }). */
export async function loadPdfTextItemsByPage(pdfDataUrl, pdfjsLib) {
  if (!pdfDataUrl || !pdfjsLib) return {}
  const loadingTask = pdfjsLib.getDocument(pdfDataUrl)
  const pdf = await loadingTask.promise
  const byPage = {}
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()
    byPage[p - 1] = content.items ?? []
  }
  return byPage
}
