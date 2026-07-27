import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { fmt, getUnitLabel } from './calculations'

/** Returns a measurement's assigned member's section size (e.g. "250UB25.7"), same lookup used by the Measurements grid. */
function getSectionSizeForItem(item, memberScheduleItems) {
  const memberMark = (item.material || item.mark || '').trim().toLowerCase()
  if (!memberMark) return ''
  const msi = (memberScheduleItems ?? []).find(m => (m.mark || '').trim().toLowerCase() === memberMark)
  return msi?.memberSize ?? ''
}

export function exportToExcel(measurements, memberScheduleItems, drawing, project) {
  const wb = XLSX.utils.book_new()
  const unit = drawing?.calibrationUnit ?? 'Mm'
  const unitLabel = getUnitLabel(unit)

  // ── Sheet 0: Project Summary ──────────────────────────────────────────
  const summaryRows = [
    { Field: 'Project', Value: project?.name ?? 'N/A' },
    { Field: 'Project Number', Value: project?.projectNumber ?? 'N/A' },
    { Field: 'Drawing', Value: drawing?.name ?? 'N/A' },
    { Field: 'Scale Unit', Value: drawing?.isCalibrated ? unitLabel : 'Not calibrated' },
    { Field: 'Total Measurements', Value: (measurements ?? []).length },
    { Field: 'Total Length', Value: (measurements ?? []).reduce((s, i) => s + (i.length ?? 0), 0).toFixed(4) + ' ' + unitLabel },
    { Field: 'Total Members', Value: (memberScheduleItems ?? []).length },
    { Field: 'Total Steel Weight (kg)', Value: (memberScheduleItems ?? []).reduce((s, m) => s + (m.totalWeight ?? 0), 0).toFixed(2) },
    { Field: 'Generated', Value: new Date().toLocaleDateString('en-AU') },
  ]
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows)
  wsSummary['!cols'] = [{ wch: 28 }, { wch: 32 }]
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary')

  // ── Sheet 1: Measurements ─────────────────────────────────────────────
  const measRows = (measurements ?? []).map((item, i) => ({
    'No':           i + 1,
    'Mark':         item.mark ?? '',
    'Section Size': getSectionSizeForItem(item, memberScheduleItems) || '',
    'Description':  item.description ?? '',
    [`Length (${unitLabel})`]: item.length != null ? +item.length.toFixed(4) : '',
    'Member Type':  item.material ?? '',
    'Qty':          item.quantity ?? 1,
    'Unit':         getUnitLabel(item.unit ?? unit),
    'Notes':        item.notes ?? '',
  }))

  const ws1 = XLSX.utils.json_to_sheet(measRows)
  ws1['!cols'] = [
    { wch: 5 }, { wch: 10 }, { wch: 14 }, { wch: 36 }, { wch: 16 },
    { wch: 14 }, { wch: 6 }, { wch: 8 }, { wch: 24 },
  ]
  XLSX.utils.book_append_sheet(wb, ws1, 'Measurements')

  // ── Sheet 2: Member Schedule ──────────────────────────────────────────
  const memberRows = (memberScheduleItems ?? []).map((m, i) => ({
    'No':                i + 1,
    'Mark':              m.mark ?? '',
    'Member Size':       m.memberSize ?? '',
    'Member Type':       m.memberType ?? '',
    'Unit Wt (kg/m)':   m.unitWeight != null ? +m.unitWeight.toFixed(3) : '',
    'Length (m)':        m.length != null ? +m.length.toFixed(3) : '',
    'Qty':               m.quantity ?? 1,
    'Total Wt (kg)':     m.totalWeight != null ? +m.totalWeight.toFixed(2) : '',
    'Description':       m.description ?? '',
  }))

  const ws2 = XLSX.utils.json_to_sheet(memberRows)
  ws2['!cols'] = [
    { wch: 5 }, { wch: 10 }, { wch: 14 }, { wch: 14 },
    { wch: 16 }, { wch: 12 }, { wch: 6 }, { wch: 16 }, { wch: 36 },
  ]
  XLSX.utils.book_append_sheet(wb, ws2, 'Member Schedule')

  const filename = drawing?.name
    ? `${drawing.name}_Report.xlsx`
    : 'Takeoff_Report.xlsx'
  XLSX.writeFile(wb, filename)
}

export function exportToPdf(measurements, memberScheduleItems, drawing, project) {
  const doc = new jsPDF({ orientation: 'landscape' })
  const unit     = drawing?.calibrationUnit ?? 'Mm'
  const unitLabel = getUnitLabel(unit)
  const now      = new Date().toLocaleDateString('en-AU')

  // ── Header ────────────────────────────────────────────────────────────
  doc.setFillColor(13, 27, 62)
  doc.rect(0, 0, doc.internal.pageSize.width, 44, 'F')

  doc.setFontSize(17)
  doc.setTextColor(255, 255, 255)
  doc.setFont(undefined, 'bold')
  doc.text('BuildTakeoff Pro — Estimation Report', 14, 16)

  doc.setFontSize(9)
  doc.setFont(undefined, 'normal')
  doc.setTextColor(180, 200, 230)
  const info = [
    project?.name ? `Project: ${project.name}${project.projectNumber ? ` (${project.projectNumber})` : ''}` : null,
    `Drawing: ${drawing?.name ?? 'N/A'}`,
    `Generated: ${now}`,
    drawing?.isCalibrated ? `Scale Unit: ${unitLabel}` : 'Scale: Not calibrated',
  ].filter(Boolean)
  info.forEach((line, i) => doc.text(line, 14 + Math.floor(i / 2) * 120, 28 + (i % 2) * 7))

  // ── Section 1: Measurements ───────────────────────────────────────────
  doc.setFontSize(11)
  doc.setFont(undefined, 'bold')
  doc.setTextColor(28, 43, 74)
  doc.text('Measurements', 14, 54)

  const measBody = (measurements ?? []).map((item, i) => [
    i + 1,
    item.mark ?? '—',
    getSectionSizeForItem(item, memberScheduleItems) || '—',
    item.description ?? '—',
    item.length != null ? fmt(item.length) : '—',
    item.material ?? '—',
    item.quantity ?? 1,
    getUnitLabel(item.unit ?? unit),
    item.notes ?? '',
  ])

  autoTable(doc, {
    startY: 58,
    head: [['No', 'Mark', 'Section Size', 'Description', `Length (${unitLabel})`, 'Member Type', 'Qty', 'Unit', 'Notes']],
    body: measBody.length ? measBody : [['—', '', '', 'No measurements recorded', '', '', '', '', '']],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [29, 111, 219], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [240, 246, 255] },
    columnStyles: {
      0: { cellWidth: 10 },
      3: { cellWidth: 55 },
      8: { cellWidth: 35 },
    },
  })

  // Measurement totals
  const totalLength = (measurements ?? []).reduce((s, i) => s + (i.length ?? 0), 0)
  const y1 = doc.lastAutoTable.finalY + 5
  doc.setFontSize(9)
  doc.setFont(undefined, 'bold')
  doc.setTextColor(29, 111, 219)
  doc.text(
    `Total: ${(measurements ?? []).length} items   |   Total Length: ${fmt(totalLength)} ${unitLabel}`,
    14, y1
  )

  // ── Section 2: Member Schedule ────────────────────────────────────────
  const members = memberScheduleItems ?? []
  const sectionY = y1 + 10

  // Check if we need a new page
  const pageH = doc.internal.pageSize.height
  if (sectionY > pageH - 60) doc.addPage()

  const secY = sectionY > pageH - 60 ? 20 : sectionY

  doc.setFontSize(11)
  doc.setFont(undefined, 'bold')
  doc.setTextColor(28, 43, 74)
  doc.text('Member Schedule', 14, secY)

  const memberBody = members.map((m, i) => [
    i + 1,
    m.mark ?? '—',
    m.memberSize ?? '—',
    m.memberType ?? '—',
    m.unitWeight != null ? m.unitWeight.toFixed(3) : '—',
    m.length != null ? m.length.toFixed(3) : '—',
    m.quantity ?? 1,
    m.totalWeight != null ? m.totalWeight.toFixed(2) : '—',
    m.description ?? '',
  ])

  autoTable(doc, {
    startY: secY + 4,
    head: [['No', 'Mark', 'Size', 'Type', 'Unit Wt\n(kg/m)', 'Length\n(m)', 'Qty', 'Total Wt\n(kg)', 'Description']],
    body: memberBody.length ? memberBody : [['—', '', '', 'No members recorded', '', '', '', '', '']],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [13, 27, 62], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 248, 252] },
    columnStyles: {
      0: { cellWidth: 10 },
      8: { cellWidth: 50 },
    },
  })

  // Member schedule totals
  const totalQty    = members.reduce((s, m) => s + (m.quantity ?? 0), 0)
  const totalWeight = members.reduce((s, m) => s + (m.totalWeight ?? 0), 0)
  const y2 = doc.lastAutoTable.finalY + 5
  doc.setFontSize(9)
  doc.setFont(undefined, 'bold')
  doc.setTextColor(13, 27, 62)
  doc.text(
    `Total: ${members.length} members   |   Total Qty: ${totalQty}   |   Total Weight: ${totalWeight.toFixed(2)} kg`,
    14, y2
  )

  // ── Footer ────────────────────────────────────────────────────────────
  const pages = doc.internal.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFontSize(7)
    doc.setFont(undefined, 'normal')
    doc.setTextColor(160)
    doc.text(
      `BuildTakeoff Pro   |   Page ${p} of ${pages}   |   ${now}`,
      doc.internal.pageSize.width / 2, doc.internal.pageSize.height - 6,
      { align: 'center' }
    )
  }

  const filename = drawing?.name
    ? `${drawing.name}_Estimation.pdf`
    : 'Takeoff_Estimation.pdf'
  doc.save(filename)
}
