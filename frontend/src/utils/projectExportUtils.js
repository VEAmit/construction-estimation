import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { getAreaUnitLabel, getUnitLabel, toMeters } from './calculations'
import { getMeasurementMemberMark } from './memberMeasureLink'
import {
  buildSectionMembershipByTakeoffItem,
  buildSectionQuantityByTakeoffItem,
  getSectionGroupQuantity,
  getSectionPlacementCount,
} from './sectionQuantity'

function readPointsJson(pointsJson) {
  if (!pointsJson) return null
  try {
    return typeof pointsJson === 'string' ? JSON.parse(pointsJson) : pointsJson
  } catch {
    return null
  }
}

function positivePage(value) {
  const page = Number(value)
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : null
}

function pageFromGeometry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const direct = positivePage(raw.pageNumber ?? raw.PageNumber)
  if (direct) return direct

  const zeroBased = Number(raw.page ?? raw.pageIndex)
  return Number.isFinite(zeroBased) && zeroBased >= 0 ? Math.floor(zeroBased) + 1 : null
}

function occurrenceGeometry(occurrence) {
  return occurrence?.geometry ?? occurrence?.rawAnnotation ?? occurrence
}

export function getProjectMeasurementPages(item) {
  const raw = readPointsJson(item?.pointsJson)
  if (!raw) return ''

  const pages = Array.isArray(raw.occurrences) && raw.occurrences.length
    ? raw.occurrences.map(occurrence => (
        positivePage(occurrence?.pageNumber ?? occurrence?.PageNumber)
        ?? pageFromGeometry(occurrenceGeometry(occurrence))
      ))
    : [pageFromGeometry(raw)]

  return [...new Set(pages.filter(Boolean))]
    .sort((left, right) => left - right)
    .join(', ')
}

function getThicknessValue(item) {
  const raw = readPointsJson(item?.pointsJson)
  if (!raw) return ''

  const geometries = Array.isArray(raw.occurrences) && raw.occurrences.length
    ? raw.occurrences.map(occurrenceGeometry)
    : [raw]
  const values = [...new Set(geometries
    .map(geometry => Number(geometry?.thickness ?? geometry?.Thickness))
    .filter(value => Number.isFinite(value) && value > 0))]

  if (values.length === 0) return ''
  return values.length === 1 ? values[0] : values.join(', ')
}

function normalizedQuantity(item) {
  const value = Number(item?.quantity)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1
}

function findScheduleMember(item, memberScheduleItems) {
  const schedule = Array.isArray(memberScheduleItems) ? memberScheduleItems : []
  const memberMark = getMeasurementMemberMark(item, schedule).trim().toLocaleLowerCase()
  if (!memberMark) return null
  return schedule.find(member =>
    String(member?.mark ?? '').trim().toLocaleLowerCase() === memberMark) ?? null
}

function formatSectionMemberships(memberships, sectionsById) {
  return memberships.map(membership => {
    const section = sectionsById.get(Number(membership.id))
    const places = section ? getSectionPlacementCount(section) : 0
    return places > 0
      ? `${membership.name} (${places} place${places === 1 ? '' : 's'})`
      : membership.name
  }).join(', ')
}

function measurementValue(item) {
  if (String(item?.itemType ?? '').toLocaleLowerCase() === 'area') return item?.area ?? ''
  if (String(item?.itemType ?? '').toLocaleLowerCase() === 'count') return ''
  return item?.length ?? ''
}

function measurementUnit(item, drawing) {
  const unit = item?.unit ?? drawing?.calibrationUnit ?? 'Mm'
  return String(item?.itemType ?? '').toLocaleLowerCase() === 'area'
    ? getAreaUnitLabel(unit)
    : getUnitLabel(unit)
}

function numericOrBlank(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : ''
}

function effectiveTotalWeight(item, quantity) {
  const unitWeight = Number(item?.unitWeight)
  const length = Number(item?.length)
  if (Number.isFinite(unitWeight) && Number.isFinite(length) && length >= 0) {
    const total = unitWeight * toMeters(length, item?.unit ?? 'Mm') * quantity
    if (Number.isFinite(total)) return total
  }
  return numericOrBlank(item?.totalWeight)
}

/**
 * Produces the consolidated, read-only measurement rows used by both project
 * export formats. Existing drawing exports continue to use exportUtils.js.
 */
export function buildProjectMeasurementRows(drawingMeasurements, memberScheduleItems, sections) {
  const schedule = Array.isArray(memberScheduleItems) ? memberScheduleItems : []
  const projectSections = Array.isArray(sections) ? sections : []
  const sectionsById = new Map(projectSections.map(section => [Number(section.id), section]))
  let rowNumber = 0

  return (drawingMeasurements ?? []).flatMap(entry => {
    const drawing = entry?.drawing ?? {}
    const membershipsByItem = buildSectionMembershipByTakeoffItem(projectSections, drawing.id)
    const quantityIncreaseByItem = buildSectionQuantityByTakeoffItem(projectSections, drawing.id)

    const measurements = Array.isArray(entry?.measurements) ? entry.measurements : []
    return measurements.map(item => {
      const scheduleMember = findScheduleMember(item, schedule)
      const memberships = membershipsByItem.get(Number(item.id)) ?? []
      const quantityIncrease = Number(quantityIncreaseByItem.get(Number(item.id)) ?? 0)
      const quantity = normalizedQuantity(item) + (Number.isFinite(quantityIncrease) ? quantityIncrease : 0)
      rowNumber += 1

      return {
        'No': rowNumber,
        'Drawing / PDF Name': drawing.name ?? drawing.fileName ?? `Drawing ${drawing.id ?? ''}`.trim(),
        'Page Number': getProjectMeasurementPages(item),
        'Measurement Type': item.itemType ?? 'Line',
        'Mark': item.mark ?? '',
        'Member': getMeasurementMemberMark(item, schedule),
        'Section Size': scheduleMember?.memberSize ?? '',
        'Description': item.description ?? '',
        'Member Type': item.category || scheduleMember?.memberType || 'General',
        'Length / Area': numericOrBlank(measurementValue(item)),
        'Unit': measurementUnit(item, drawing),
        'Thickness': getThicknessValue(item),
        'WT/M': numericOrBlank(item.unitWeight),
        'Total Weight': effectiveTotalWeight(item, quantity),
        'Quantity': quantity,
        'Section / Group': formatSectionMemberships(memberships, sectionsById),
      }
    })
  })
}

export function buildProjectSectionRows(sections, drawings) {
  const drawingNames = new Map((drawings ?? []).map(drawing => [
    Number(drawing.id),
    drawing.name ?? drawing.fileName ?? `Drawing ${drawing.id}`,
  ]))
  const rows = []

  ;(sections ?? []).forEach(section => {
    const placements = Array.isArray(section?.placements) ? section.placements : []
    const usedPlaces = getSectionPlacementCount(section)
    const groupQuantity = getSectionGroupQuantity(section)
    const sourceDrawingName = drawingNames.get(Number(section.sourceDrawingId)) ?? `Drawing ${section.sourceDrawingId}`
    const visiblePlacements = placements.filter(placement => (
      placement?.isDeleted !== true && placement?.IsDeleted !== true
    ))

    if (visiblePlacements.length === 0) {
      rows.push({
        'Section / Group': section.name ?? 'Section',
        'Type': 'Source template',
        'Drawing / PDF Name': sourceDrawingName,
        'Page Number': positivePage(section.sourcePageNumber) ?? '',
        'Measurement Count': Number(section.measurementCount ?? 0),
        'Used Places': usedPlaces,
        'Group Quantity': groupQuantity,
      })
      return
    }

    visiblePlacements.forEach(placement => {
      const isSource = placement?.isSource === true || placement?.IsSource === true
      rows.push({
        'Section / Group': section.name ?? 'Section',
        'Type': isSource ? 'Source template' : 'Counted placement',
        'Drawing / PDF Name': drawingNames.get(Number(placement.drawingId)) ?? `Drawing ${placement.drawingId}`,
        'Page Number': positivePage(placement.pageNumber) ?? '',
        'Measurement Count': Number(section.measurementCount ?? 0),
        'Used Places': usedPlaces,
        'Group Quantity': groupQuantity,
      })
    })
  })

  return rows
}

function buildProjectMemberRows(memberScheduleItems) {
  return (memberScheduleItems ?? []).map((member, index) => ({
    'No': index + 1,
    'Mark': member.mark ?? '',
    'Section Size': member.memberSize ?? '',
    'Member Type': member.memberType ?? '',
    'WT/M (kg/m)': numericOrBlank(member.unitWeight),
    'Length (m)': numericOrBlank(member.length),
    'Quantity': numericOrBlank(member.quantity),
    'Total Weight (kg)': numericOrBlank(member.totalWeight),
    'Description': member.description ?? '',
  }))
}

function safeFilename(value, fallback) {
  const safe = String(value ?? '').trim().replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ')
  return safe || fallback
}

function setWorksheetWidths(worksheet, widths) {
  worksheet['!cols'] = widths.map(width => ({ wch: width }))
}

function countMeasurementPages(measurementRows) {
  const pages = new Set()
  ;(measurementRows ?? []).forEach(row => {
    String(row?.['Page Number'] ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .forEach(page => pages.add(`${row?.['Drawing / PDF Name'] ?? ''}:${page}`))
  })
  return pages.size
}

export function exportProjectToExcel(drawingMeasurements, memberScheduleItems, sections, project) {
  const drawings = (drawingMeasurements ?? []).map(entry => entry.drawing).filter(Boolean)
  const measurementRows = buildProjectMeasurementRows(drawingMeasurements, memberScheduleItems, sections)
  const sectionRows = buildProjectSectionRows(sections, drawings)
  const memberRows = buildProjectMemberRows(memberScheduleItems)
  const workbook = XLSX.utils.book_new()
  const measuredPages = countMeasurementPages(measurementRows)
  const summaryRows = [
    { Field: 'Project', Value: project?.name ?? 'N/A' },
    { Field: 'Drawings / PDFs', Value: drawings.length },
    { Field: 'Pages With Measurements', Value: measuredPages },
    { Field: 'Measurement Rows', Value: measurementRows.length },
    { Field: 'Total Measurement Quantity', Value: measurementRows.reduce((total, row) => total + (Number(row.Quantity) || 0), 0) },
    { Field: 'Section Groups', Value: (sections ?? []).length },
    { Field: 'Generated', Value: new Date().toLocaleString('en-AU') },
  ]

  const summarySheet = XLSX.utils.json_to_sheet(summaryRows)
  setWorksheetWidths(summarySheet, [30, 38])
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Project Summary')

  const measurementSheet = XLSX.utils.json_to_sheet(measurementRows)
  setWorksheetWidths(measurementSheet, [6, 28, 14, 17, 14, 14, 18, 38, 18, 16, 10, 12, 12, 16, 10, 34])
  XLSX.utils.book_append_sheet(workbook, measurementSheet, 'Project Measurements')

  const sectionSheet = XLSX.utils.json_to_sheet(sectionRows)
  setWorksheetWidths(sectionSheet, [22, 18, 28, 14, 20, 14, 16])
  XLSX.utils.book_append_sheet(workbook, sectionSheet, 'Section Placements')

  const memberSheet = XLSX.utils.json_to_sheet(memberRows)
  setWorksheetWidths(memberSheet, [6, 14, 20, 18, 16, 14, 12, 20, 38])
  XLSX.utils.book_append_sheet(workbook, memberSheet, 'Member Schedule')

  XLSX.writeFile(workbook, `${safeFilename(project?.name, 'Project')}_Measurements.xlsx`)
  return { measurements: measurementRows.length, drawings: drawings.length, pages: measuredPages }
}

function addPdfFooter(doc, generated) {
  const pages = doc.internal.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page)
    doc.setFontSize(7)
    doc.setFont(undefined, 'normal')
    doc.setTextColor(140)
    doc.text(
      `BuildTakeoff Pro | Complete Project Measurements | Page ${page} of ${pages} | ${generated}`,
      doc.internal.pageSize.width / 2,
      doc.internal.pageSize.height - 6,
      { align: 'center' },
    )
  }
}

export function exportProjectToPdf(drawingMeasurements, memberScheduleItems, sections, project) {
  const drawings = (drawingMeasurements ?? []).map(entry => entry.drawing).filter(Boolean)
  const measurementRows = buildProjectMeasurementRows(drawingMeasurements, memberScheduleItems, sections)
  const sectionRows = buildProjectSectionRows(sections, drawings)
  const generated = new Date().toLocaleString('en-AU')
  const measuredPages = countMeasurementPages(measurementRows)
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' })

  doc.setFillColor(13, 27, 62)
  doc.rect(0, 0, doc.internal.pageSize.width, 34, 'F')
  doc.setFont(undefined, 'bold')
  doc.setFontSize(17)
  doc.setTextColor(255, 255, 255)
  doc.text('BuildTakeoff Pro — Complete Project Measurements', 14, 15)
  doc.setFont(undefined, 'normal')
  doc.setFontSize(9)
  doc.setTextColor(180, 200, 230)
  doc.text(`Project: ${project?.name ?? 'N/A'}`, 14, 25)
  doc.text(`Drawings: ${drawings.length}  |  Pages with measurements: ${measuredPages}  |  Measurements: ${measurementRows.length}`, 155, 25)
  doc.text(`Generated: ${generated}`, 330, 25)

  autoTable(doc, {
    startY: 40,
    margin: { left: 8, right: 8, bottom: 12 },
    head: [[
      'No', 'Drawing / PDF', 'Page', 'Meas.', 'Mark', 'Member', 'Section Size',
      'Description', 'Member Type', 'Length / Area', 'Unit', 'Thk', 'WT/M',
      'Total Wt', 'Qty', 'Section / Group',
    ]],
    body: measurementRows.length ? measurementRows.map(row => [
      row.No,
      row['Drawing / PDF Name'] || '—',
      row['Page Number'] || '—',
      row['Measurement Type'] || '—',
      row.Mark || '—',
      row.Member || '—',
      row['Section Size'] || '—',
      row.Description || '—',
      row['Member Type'] || '—',
      row['Length / Area'] === '' ? '—' : row['Length / Area'],
      row.Unit || '—',
      row.Thickness === '' ? '—' : row.Thickness,
      row['WT/M'] === '' ? '—' : row['WT/M'],
      row['Total Weight'] === '' ? '—' : row['Total Weight'],
      row.Quantity,
      row['Section / Group'] || '—',
    ]) : [['—', '', '', '', '', '', '', 'No measurements recorded in this project', '', '', '', '', '', '', '', '']],
    styles: { fontSize: 6.5, cellPadding: 1.35, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: [29, 111, 219], textColor: 255, fontStyle: 'bold', fontSize: 6.5 },
    alternateRowStyles: { fillColor: [240, 246, 255] },
    columnStyles: {
      0: { cellWidth: 8 },
      1: { cellWidth: 32 },
      2: { cellWidth: 13 },
      3: { cellWidth: 15 },
      4: { cellWidth: 16 },
      5: { cellWidth: 16 },
      6: { cellWidth: 23 },
      7: { cellWidth: 38 },
      8: { cellWidth: 20 },
      9: { cellWidth: 19 },
      10: { cellWidth: 11 },
      11: { cellWidth: 11 },
      12: { cellWidth: 13 },
      13: { cellWidth: 16 },
      14: { cellWidth: 9 },
      15: { cellWidth: 34 },
    },
  })

  doc.addPage()
  doc.setFont(undefined, 'bold')
  doc.setFontSize(14)
  doc.setTextColor(28, 43, 74)
  doc.text('Section / Group Placements', 14, 18)
  autoTable(doc, {
    startY: 24,
    margin: { left: 14, right: 14, bottom: 12 },
    head: [['Section / Group', 'Type', 'Drawing / PDF', 'Page', 'Measurements', 'Used Places', 'Group Qty']],
    body: sectionRows.length ? sectionRows.map(row => [
      row['Section / Group'], row.Type, row['Drawing / PDF Name'], row['Page Number'],
      row['Measurement Count'], row['Used Places'], row['Group Quantity'],
    ]) : [['—', 'No section groups recorded', '', '', '', '', '']],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [13, 27, 62], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 248, 252] },
  })

  const memberRows = buildProjectMemberRows(memberScheduleItems)
  const memberStartY = doc.lastAutoTable.finalY + 14
  if (memberStartY > doc.internal.pageSize.height - 70) doc.addPage()
  const scheduleY = memberStartY > doc.internal.pageSize.height - 70 ? 18 : memberStartY
  doc.setFont(undefined, 'bold')
  doc.setFontSize(14)
  doc.setTextColor(28, 43, 74)
  doc.text('Project Member Schedule', 14, scheduleY)
  autoTable(doc, {
    startY: scheduleY + 6,
    margin: { left: 14, right: 14, bottom: 12 },
    head: [['No', 'Mark', 'Section Size', 'Member Type', 'WT/M', 'Length (m)', 'Qty', 'Total Weight', 'Description']],
    body: memberRows.length ? memberRows.map(row => [
      row.No, row.Mark, row['Section Size'], row['Member Type'], row['WT/M (kg/m)'],
      row['Length (m)'], row.Quantity, row['Total Weight (kg)'], row.Description,
    ]) : [['—', '', '', 'No members recorded', '', '', '', '', '']],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [13, 27, 62], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 248, 252] },
  })

  addPdfFooter(doc, generated)
  doc.save(`${safeFilename(project?.name, 'Project')}_Measurements.pdf`)
  return { measurements: measurementRows.length, drawings: drawings.length, pages: measuredPages }
}
