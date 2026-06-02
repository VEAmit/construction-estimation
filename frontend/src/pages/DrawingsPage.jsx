import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { drawingService } from '../services/drawingService'
import { takeoffService } from '../services/takeoffService'
import { memberScheduleService } from '../services/memberScheduleService'
import { useAppStore } from '../store/useAppStore'
import DrawingSidebar from '../components/drawings/DrawingSidebar'
import PdfViewer from '../components/drawings/PdfViewer'
import Toolbar from '../components/tools/Toolbar'
import RightPanel from '../components/tools/RightPanel'
import MeasurementTable from '../components/takeoff/TakeoffTable'
import MemberSchedulePanel from '../components/takeoff/MemberSchedulePanel'
import AddMeasurementModal from '../components/takeoff/AddTakeoffModal'
import CalibrationModal from '../components/takeoff/CalibrationModal'
import { exportToExcel, exportToPdf } from '../utils/exportUtils'
import { computeScaleRatio, getUnitLabel } from '../utils/calculations'
import ExtractionModal from '../components/extraction/ExtractionModal'
import toast from 'react-hot-toast'

export default function DrawingsPage() {
  const navigate = useNavigate()
  const {
    selectedProject, setSelectedProject,
    drawings, setDrawings, selectedDrawing, setSelectedDrawing,
    takeoffItems, addTakeoffItem, setTakeoffItems,
    setSummary, activeTool, setActiveTool,
    memberScheduleItems, setMemberScheduleItems, setMemberScheduleSummary,
    triggerPdfCommand,
    _hydrated,
  } = useAppStore()

  const [lastMeasurement, setLastMeasurement]   = useState(null)
  const [showAddModal,    setShowAddModal]       = useState(false)   // manual-add only
  const [pendingMeas,     setPendingMeas]        = useState(null)
  const [showCalModal,    setShowCalModal]       = useState(false)
  const [calSaving,       setCalSaving]          = useState(false)
  const [autoSaving,      setAutoSaving]         = useState(false)
  const [showBottom,      setShowBottom]         = useState(true)
  const [bottomTab,       setBottomTab]          = useState('measurements')
  const [summary,         setSummaryLocal]       = useState(null)
  const [selectedAnnotId, setSelectedAnnotId]    = useState(null)
  const [showExtractModal, setShowExtractModal]  = useState(false)

  // In-memory map from DB item ID → Syncfusion annotation { annotationId, pageNumber }
  // Annotations are ephemeral (lost on page reload) so we only track within-session
  const annotationMapRef = useRef({})

  // Redirect if no project — but wait until the persist store has rehydrated
  // so a page refresh on /drawings doesn't immediately bounce to dashboard
  useEffect(() => {
    if (!_hydrated) return
    if (!selectedProject) navigate('/dashboard')
  }, [_hydrated, selectedProject])

  // Guard: if user activates Measure tool before calibrating, redirect to Calibrate
  useEffect(() => {
    if (!selectedDrawing || activeTool !== 'line') return
    if (selectedDrawing.isCalibrated) return
    setActiveTool('calibrate')
    toast('Calibrate the scale first — draw a line of known length, then enter its real dimension', {
      icon: '📐', duration: 5000,
    })
  }, [activeTool, selectedDrawing?.isCalibrated, selectedDrawing?.id])

  // Load drawings when project changes
  // ── IMPORTANT: clear drawing state immediately (synchronously) before the
  // API call resolves so the PDF viewer goes blank the instant a new project
  // is selected.  Without this, the old project's drawing stays visible while
  // the fetch is in flight, and if the new project has 0 drawings it never clears.
  useEffect(() => {
    if (!selectedProject) return
    // Reset to blank slate for the incoming project right away
    setSelectedDrawing(null)
    setDrawings([])
    drawingService.getByProject(selectedProject.id)
      .then(data => {
        setDrawings(data)
        if (data.length > 0) {
          // Always start from the first drawing of the new project — never
          // carry over a selectedDrawing.id that belonged to another project.
          setSelectedDrawing(data[0])
        }
        // data.length === 0 → selectedDrawing stays null → viewer shows empty state
      })
      .catch(() => toast.error('Failed to load drawings'))
  }, [selectedProject?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // Load measurements + member schedule when drawing changes
  useEffect(() => {
    if (!selectedDrawing) {
      setTakeoffItems([])
      setMemberScheduleItems([])
      setSummaryLocal(null)
      annotationMapRef.current = {}
      return
    }
    Promise.all([
      takeoffService.getByDrawing(selectedDrawing.id),
      takeoffService.getSummary(selectedDrawing.id),
      memberScheduleService.getByDrawing(selectedDrawing.id),
      memberScheduleService.getSummary(selectedDrawing.id),
    ])
      .then(([items, sum, members, memberSum]) => {
        setTakeoffItems(items)
        setSummaryLocal(sum)
        setSummary(sum)
        setMemberScheduleItems(members)
        setMemberScheduleSummary(memberSum)

        // Rebuild annotation map from stored pointsJson so clicking a row
        // highlights the correct line even after a page refresh.
        // Handles both legacy event format (page, annotationId) and
        // current export format (pageIndex, annotationId/uniqueKey).
        const map = {}
        items.forEach(item => {
          if (!item.pointsJson) return
          try {
            const stored = JSON.parse(item.pointsJson)
            // UUID is in annotationId (event format), AnnotName (Syncfusion export), or name/uniqueKey
            const annotId = stored.annotationId ?? stored.AnnotName ?? stored.uniqueKey ?? stored.name
            if (!annotId) return
            // page is 0-based string in event format; pageIndex is 0-based number in export format
            const page0 = stored.page != null
              ? parseInt(stored.page, 10)
              : (stored.pageIndex ?? 0)
            map[item.id] = { annotationId: annotId, pageNumber: page0 + 1 }
          } catch (_) {}
        })
        annotationMapRef.current = map
      })
      .catch(() => toast.error('Failed to load drawing data'))
  }, [selectedDrawing?.id])

  // ── Auto-save helper ────────────────────────────────────────────────────
  const autoSave = useCallback(async (measurement) => {
    // Read from store so we always have the latest drawing even if the closure is stale
    const { selectedDrawing: drw, takeoffItems: current, measureColor: color, measureCategory: category } = useAppStore.getState()
    if (!drw || autoSaving) return
    setAutoSaving(true)
    const unit     = drw.calibrationUnit ?? 'Mm'
    const nextMark = `M${current.length + 1}`
    const desc     = measurement.length != null
      ? `${measurement.length.toFixed(3)} ${getUnitLabel(unit)}`
      : `${Math.round(measurement.pixelLength)} px (not calibrated)`

    try {
      const saved = await takeoffService.create({
        drawingId:   drw.id,
        itemType:    'Line',
        mark:        nextMark,
        description: desc,
        quantity:    1,
        unit,
        material:    '',
        notes:       '',
        length:      measurement.length ?? null,
        area:        null,
        unitWeight:  null,
        totalWeight: null,
        color:       color ?? '#3b82f6',
        category:    category ?? 'General',
        // Store the raw annotation object so it can be re-imported after page refresh
        pointsJson:  measurement.rawAnnotation
          ? JSON.stringify(measurement.rawAnnotation)
          : (measurement.points?.length ? JSON.stringify(measurement.points) : null),
      })

      addTakeoffItem(saved)

      // Track annotation ID in-memory for row→drawing selection
      if (measurement.annotationId) {
        annotationMapRef.current[saved.id] = {
          annotationId: measurement.annotationId,
          pageNumber:   measurement.pageNumber ?? 1,
        }
      }

      // Refresh summary
      takeoffService.getSummary(drw.id)
        .then(sum => { setSummaryLocal(sum); setSummary(sum) })
        .catch(() => {})

      // Result toast
      if (measurement.length != null) {
        toast.success(
          `${nextMark}: ${measurement.length.toFixed(3)} ${getUnitLabel(unit)}`,
          { duration: 2500, icon: '📐' }
        )
      } else {
        toast(
          `${nextMark}: ${Math.round(measurement.pixelLength)} px — calibrate for real length`,
          { duration: 3000, icon: '⚠️' }
        )
      }
    } catch {
      toast.error('Could not save measurement — try again')
    } finally {
      setAutoSaving(false)
    }
  }, [autoSaving, addTakeoffItem])

  // ── Measurement callback from PdfViewer ────────────────────────────────
  const handleMeasure = useCallback((measurement) => {
    setLastMeasurement(measurement)

    // Read activeTool from store directly to avoid stale closure — Syncfusion
    // may hold an older version of this callback after tool switches.
    const { activeTool: currentTool } = useAppStore.getState()
    if (currentTool === 'calibrate') {
      setShowCalModal(true)
      return
    }

    autoSave(measurement)
  }, [autoSave])

  // ── Calibration apply (called by CalibrationModal) ─────────────────────
  const handleCalibrationApply = useCallback(async (realLength, unit) => {
    const pxLen = lastMeasurement?.pixelLength
    if (!pxLen || pxLen === 0) { toast.error('No calibration line found'); return }
    const scaleRatio = computeScaleRatio(realLength, unit, pxLen)
    if (!scaleRatio) { toast.error('Could not compute scale'); return }
    setCalSaving(true)
    try {
      await drawingService.calibrate(selectedDrawing.id, scaleRatio, unit)
      const updated = await drawingService.getById(selectedDrawing.id)
      setSelectedDrawing(updated)
      setDrawings(useAppStore.getState().drawings.map(d => d.id === updated.id ? updated : d))
      setShowCalModal(false)

      // Remove the calibration line from the viewer — it was only used to set the scale
      if (lastMeasurement?.annotationId) {
        triggerPdfCommand({
          type:         'deleteAnnotation',
          annotationId: lastMeasurement.annotationId,
          pageNumber:   lastMeasurement.pageNumber ?? 1,
        })
      }

      setActiveTool('line')  // switch straight to measure so demo flows
      toast.success(
        `Scale set — draw measurement lines now`,
        { duration: 3500, icon: '✅' }
      )
    } catch {
      toast.error('Calibration failed')
    } finally {
      setCalSaving(false)
    }
  }, [lastMeasurement, selectedDrawing, triggerPdfCommand])

  // ── Quick scale (from RightPanel preset) ──────────────────────────────
  const handleQuickScale = useCallback(async (scaleRatio, unit) => {
    if (!selectedDrawing) return
    try {
      await drawingService.calibrate(selectedDrawing.id, scaleRatio, unit)
      const updated = await drawingService.getById(selectedDrawing.id)
      setSelectedDrawing(updated)
      setDrawings(useAppStore.getState().drawings.map(d => d.id === updated.id ? updated : d))
      setActiveTool('line')
      toast.success(`Scale set — ready to measure`, { duration: 3000, icon: '✅' })
    } catch {
      toast.error('Failed to apply quick scale')
    }
  }, [selectedDrawing])

  // ── Row selected in table → highlight annotation on drawing ───────────
  const handleRowSelect = useCallback((dbId) => {
    setSelectedAnnotId(dbId)
    const annot = annotationMapRef.current[dbId]
    if (annot?.annotationId) {
      triggerPdfCommand({ type: 'selectAnnotation', ...annot })
    }
  }, [triggerPdfCommand])

  // ── Drawing management ─────────────────────────────────────────────────
  const handleCalibrated = useCallback(async () => {
    if (!selectedDrawing) return
    try {
      const updated = await drawingService.getById(selectedDrawing.id)
      setSelectedDrawing(updated)
      setDrawings(useAppStore.getState().drawings.map(d => d.id === updated.id ? updated : d))
    } catch { /* ignore */ }
  }, [selectedDrawing])

  const handleDrawingUploaded = (drawing) => {
    setDrawings([...useAppStore.getState().drawings, drawing])
    setSelectedDrawing(drawing)
    setTakeoffItems([])
    setMemberScheduleItems([])
    setSummaryLocal(null)
    annotationMapRef.current = {}
  }

  const handleDrawingDeleted = (id) => {
    const rest = useAppStore.getState().drawings.filter(d => d.id !== id)
    setDrawings(rest)
    if (selectedDrawing?.id === id) {
      setSelectedDrawing(rest[0] ?? null)
      setTakeoffItems([])
      setMemberScheduleItems([])
      setSummaryLocal(null)
      annotationMapRef.current = {}
    }
  }

  // Used by manual Add button in table
  const handleItemAdded = async () => {
    if (!selectedDrawing) return
    try {
      const [items, sum] = await Promise.all([
        takeoffService.getByDrawing(selectedDrawing.id),
        takeoffService.getSummary(selectedDrawing.id),
      ])
      setTakeoffItems(items)
      setSummaryLocal(sum)
      setSummary(sum)
    } catch { /* ignore */ }
  }

  const handleExtractionSaved = useCallback(async (count) => {
    if (!selectedDrawing) return
    try {
      const [members, memberSum] = await Promise.all([
        memberScheduleService.getByDrawing(selectedDrawing.id),
        memberScheduleService.getSummary(selectedDrawing.id),
      ])
      setMemberScheduleItems(members)
      setMemberScheduleSummary(memberSum)
      setBottomTab('members')
      setShowBottom(true)
      toast.success(`${count} member(s) saved to schedule`, { duration: 3000, icon: '🔩' })
    } catch { /* ignore */ }
    setShowExtractModal(false)
  }, [selectedDrawing])

  const handleExport = () =>
    exportToExcel(takeoffItems, memberScheduleItems, selectedDrawing, selectedProject)

  const handleExportPdf = () =>
    exportToPdf(takeoffItems, memberScheduleItems, selectedDrawing, selectedProject)

  const drawingUrl      = selectedDrawing ? drawingService.getFileUrl(selectedDrawing.id) : null
  const selectedAnnotItem = selectedAnnotId ? takeoffItems.find(t => t.id === selectedAnnotId) : null

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* ── Breadcrumb bar ─────────────────────────────────────────── */}
      <div style={{ padding:'5px 16px', background:'#060d1a', borderBottom:'1px solid #1e293b',
        display:'flex', alignItems:'center', gap:'8px', flexShrink:0, minHeight:'36px' }}>

        <button onClick={() => { setSelectedProject(null); navigate('/dashboard') }}
          style={{ background:'none', border:'none', color:'#475569', cursor:'pointer',
            display:'flex', alignItems:'center', gap:'4px', fontSize:'12px',
            padding:'2px 6px', borderRadius:'4px' }}
          onMouseEnter={e => e.currentTarget.style.color='#94a3b8'}
          onMouseLeave={e => e.currentTarget.style.color='#475569'}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Projects
        </button>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <span style={{ fontSize:'12px', fontWeight:600, color:'#94a3b8' }}>
          {selectedProject?.name}
          {selectedProject?.projectNumber && (
            <span style={{ fontSize:'10px', color:'#3b82f6', marginLeft:'6px', fontWeight:700 }}>
              {selectedProject.projectNumber}
            </span>
          )}
        </span>
        {selectedDrawing && (
          <>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
            <span style={{ fontSize:'12px', color:'#64748b' }}>{selectedDrawing.name}</span>
            {selectedDrawing.isCalibrated && (
              <span style={{ fontSize:'10px', color:'#22c55e', fontWeight:700,
                background:'rgba(34,197,94,.1)', padding:'1px 6px', borderRadius:'4px', marginLeft:'2px' }}>
                CALIBRATED
              </span>
            )}
          </>
        )}

        <div style={{ flex:1 }} />

        {/* Auto-saving indicator */}
        {autoSaving && (
          <span style={{ fontSize:'11px', color:'#64748b', display:'flex', alignItems:'center', gap:'5px' }}>
            <svg className="spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            Saving…
          </span>
        )}

        {/* Auto Extract button */}
        {selectedDrawing && (
          <button
            onClick={() => setShowExtractModal(true)}
            style={{
              display:'flex', alignItems:'center', gap:'5px',
              padding:'3px 10px', borderRadius:'5px',
              border:'1px solid rgba(168,85,247,.35)',
              background:'transparent', color:'#c084fc',
              fontSize:'11px', fontWeight:600, cursor:'pointer',
            }}
            title="Auto-extract structural members from drawing using OCR"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
            </svg>
            Schedule Extract
          </button>
        )}

        {/* Export buttons */}
        {takeoffItems.length > 0 && (
          <div style={{ display:'flex', gap:'6px' }}>
            <button onClick={handleExport} style={{ display:'flex', alignItems:'center', gap:'4px',
              padding:'3px 10px', borderRadius:'5px', border:'1px solid rgba(34,197,94,.25)',
              background:'transparent', color:'#22c55e', fontSize:'11px', fontWeight:600, cursor:'pointer' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              Excel
            </button>
            <button onClick={handleExportPdf} style={{ display:'flex', alignItems:'center', gap:'4px',
              padding:'3px 10px', borderRadius:'5px', border:'1px solid rgba(248,113,113,.25)',
              background:'transparent', color:'#f87171', fontSize:'11px', fontWeight:600, cursor:'pointer' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              PDF
            </button>
          </div>
        )}

        {/* Bottom panel toggle */}
        <button onClick={() => setShowBottom(t => !t)} style={{
          display:'flex', alignItems:'center', gap:'6px', padding:'3px 10px',
          borderRadius:'6px', fontSize:'11px', fontWeight:600,
          border:`1px solid ${showBottom ? '#1d6fdb' : '#334155'}`,
          background: showBottom ? 'rgba(29,111,219,.15)' : 'transparent',
          color: showBottom ? '#60a5fa' : '#64748b', cursor:'pointer', transition:'all .15s' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="15" x2="21" y2="15"/>
          </svg>
          {showBottom ? 'Hide' : 'Show'} Data
          {(takeoffItems.length > 0 || memberScheduleItems.length > 0) && (
            <span style={{ background:'#1d6fdb', color:'#fff', borderRadius:'10px',
              padding:'1px 5px', fontSize:'9px' }}>
              {takeoffItems.length + memberScheduleItems.length}
            </span>
          )}
        </button>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────── */}
      <Toolbar />

      {/* ── Main work area ─────────────────────────────────────────── */}
      <div style={{ flex:1, display:'flex', overflow:'hidden', minHeight:0 }}>

        {/* Left: Drawing sidebar */}
        <DrawingSidebar
          drawings={drawings}
          selectedDrawing={selectedDrawing}
          onSelect={(d) => {
            setSelectedDrawing(d)
            setSelectedAnnotId(null)
            annotationMapRef.current = {}
          }}
          onUploaded={handleDrawingUploaded}
          onDeleted={handleDrawingDeleted}
        />

        {/* Center: PDF viewer + bottom panel */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

          {/* PDF Viewer */}
          <div style={{ flex: showBottom ? '1 1 60%' : '1 1 100%',
            overflow:'hidden', display:'flex', flexDirection:'column', minHeight:0 }}>
            <PdfViewer
              key={selectedProject?.id ?? 'no-project'}
              drawingUrl={drawingUrl}
              drawing={selectedDrawing}
              activeTool={activeTool}
              onMeasure={handleMeasure}
              annotations={takeoffItems.filter(t => t.pointsJson)}
              selectedAnnotationId={selectedAnnotId}
              onAnnotationSelect={setSelectedAnnotId}
              onAnnotationsBlob={async (blobBase64) => {
                const { selectedDrawing: drw } = useAppStore.getState()
                if (!drw) return
                try {
                  await drawingService.saveAnnotations(drw.id, blobBase64)
                  const updated = await drawingService.getById(drw.id)
                  setSelectedDrawing(updated)
                  setDrawings(useAppStore.getState().drawings.map(d => d.id === updated.id ? updated : d))
                } catch (_) {
                  // Non-critical: individual measurements are still saved per row
                }
              }}
            />
          </div>

          {/* Bottom data panel */}
          {showBottom && (
            <div style={{ flex:'0 0 280px', borderTop:'2px solid #1d6fdb',
              display:'flex', flexDirection:'column', overflow:'hidden', minHeight:0 }}>

              {/* Tab bar */}
              <div style={{ display:'flex', alignItems:'center', background:'#0c1527',
                borderBottom:'1px solid #1e293b', flexShrink:0 }}>
                <TabBtn
                  active={bottomTab === 'measurements'}
                  onClick={() => setBottomTab('measurements')}
                  icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                    stroke={bottomTab==='measurements' ? '#3b82f6' : '#64748b'} strokeWidth="2">
                    <line x1="5" y1="19" x2="19" y2="5"/>
                    <circle cx="5" cy="19" r="2" fill="currentColor"/>
                    <circle cx="19" cy="5" r="2" fill="currentColor"/>
                  </svg>}
                  label="Measurements"
                  badge={takeoffItems.length}
                />
                <TabBtn
                  active={bottomTab === 'members'}
                  onClick={() => setBottomTab('members')}
                  icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                    stroke={bottomTab==='members' ? '#3b82f6' : '#64748b'} strokeWidth="2">
                    <path d="M3 9h18M3 15h18M3 9V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>
                  </svg>}
                  label="Member Schedule"
                  badge={memberScheduleItems.length}
                />
                <div style={{ flex:1 }} />
                {memberScheduleItems.length > 0 && bottomTab === 'measurements' && (
                  <div style={{ fontSize:'11px', color:'#64748b', padding:'0 12px' }}>
                    {memberScheduleItems.length} members ·{' '}
                    {memberScheduleItems.reduce((s,m)=>s+(m.totalWeight??0),0).toFixed(0)} kg
                  </div>
                )}
              </div>

              {/* Tab content */}
              <div style={{ flex:1, overflow:'hidden' }}>
                {bottomTab === 'measurements' ? (
                  <MeasurementTable
                    drawing={selectedDrawing}
                    selectedId={selectedAnnotId}
                    onRowSelect={handleRowSelect}
                    onAddClick={() => { setPendingMeas(null); setShowAddModal(true) }}
                  />
                ) : (
                  <MemberSchedulePanel
                    drawing={selectedDrawing}
                    onExport={handleExport}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right panel */}
        <RightPanel
          drawing={selectedDrawing}
          lastMeasurement={lastMeasurement}
          selectedItem={selectedAnnotItem}
          summary={summary}
          onCalibrated={handleCalibrated}
          onQuickScale={handleQuickScale}
        />
      </div>

      {/* ── Modals ─────────────────────────────────────────────────── */}

      {/* Calibration modal — triggered by drawing a line in Calibrate mode */}
      {showCalModal && (
        <CalibrationModal
          pixelLength={lastMeasurement?.pixelLength ?? 0}
          saving={calSaving}
          onApply={handleCalibrationApply}
          onClose={() => setShowCalModal(false)}
        />
      )}

      {/* Manual add modal — only via the "+Add" button in the table */}
      {showAddModal && (
        <AddMeasurementModal
          drawing={selectedDrawing}
          measurement={pendingMeas}
          onAdded={handleItemAdded}
          onClose={() => { setShowAddModal(false); setPendingMeas(null) }}
        />
      )}

      {/* AI / OCR extraction modal */}
      {showExtractModal && selectedDrawing && (
        <ExtractionModal
          drawingId={selectedDrawing.id}
          drawingName={selectedDrawing.name}
          onClose={() => setShowExtractModal(false)}
          onSaved={handleExtractionSaved}
        />
      )}
    </div>
  )
}

function TabBtn({ active, onClick, icon, label, badge }) {
  return (
    <button onClick={onClick} style={{
      display:'flex', alignItems:'center', gap:'6px',
      padding:'8px 16px', fontSize:'12px',
      fontWeight: active ? 700 : 400,
      color: active ? '#60a5fa' : '#64748b',
      background:'transparent', border:'none', cursor:'pointer',
      borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent',
      marginBottom:'-1px', transition:'all .15s' }}>
      {icon}
      {label}
      {badge > 0 && (
        <span style={{ background: active ? '#1d6fdb' : '#1e293b',
          color:'#fff', borderRadius:'10px', padding:'0 5px', fontSize:'10px' }}>
          {badge}
        </span>
      )}
    </button>
  )
}
