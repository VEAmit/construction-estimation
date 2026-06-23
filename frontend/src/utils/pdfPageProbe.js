/**
 * Read PDF /MediaBox from raw bytes — no pdf.js worker (avoids conflict with Syncfusion pdfium).
 * Used only for fit-to-width math when page dimensions vary (A4 vs A2 landscape).
 */
export function probeMediaBoxFromBuffer(buffer) {
  try {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
    const sample = bytes.subarray(0, Math.min(bytes.length, 128 * 1024))
    const text = new TextDecoder('latin1').decode(sample)
    const match = text.match(/\/MediaBox\s*\[\s*([-\d.\s]+)\]/i)
    if (!match) return null
    const parts = match[1].trim().split(/\s+/).map(Number).filter(n => Number.isFinite(n))
    if (parts.length < 4) return null
    const width = Math.abs(parts[2] - parts[0])
    const height = Math.abs(parts[3] - parts[1])
    if (width < 10 || height < 10) return null
    return { width, height }
  } catch {
    return null
  }
}

export function probeMediaBoxFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.includes('base64,')) return null
  try {
    const b64 = dataUrl.split(',')[1]
    const head = atob(b64.slice(0, Math.min(b64.length, 64 * 1024)))
    const match = head.match(/\/MediaBox\s*\[\s*([-\d.\s]+)\]/i)
    if (!match) return null
    const parts = match[1].trim().split(/\s+/).map(Number).filter(n => Number.isFinite(n))
    if (parts.length < 4) return null
    const width = Math.abs(parts[2] - parts[0])
    const height = Math.abs(parts[3] - parts[1])
    if (width < 10 || height < 10) return null
    return { width, height }
  } catch {
    return null
  }
}
