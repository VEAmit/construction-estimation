import { useState, useCallback, useRef } from 'react'
import { extractionService } from '../../services/extractionService'
import {
  dedupeExactExtractedMembers,
  formatPdfSourceLine,
  sortMembersByMark,
} from '../../utils/extractionNormalize'

const MEMBER_TYPES = ['Beam', 'Column', 'Rafter', 'Purlin', 'Girt', 'Brace', 'Plate', 'Other']

const s = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,.85)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2147483000, backdropFilter: 'blur(6px)',
    pointerEvents: 'auto',
  },
  modal: {
    background: '#111827',
    border: '1px solid rgba(239,35,60,.2)',
    borderRadius: 16,
    width: '96vw', maxWidth: 1100,
    maxHeight: '90vh',
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 25px 80px rgba(0,0,0,.85)',
    overflow: 'hidden',
    position: 'relative',
    zIndex: 1,
    pointerEvents: 'auto',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 24px',
    borderBottom: '1px solid rgba(255,255,255,.07)',
    background: 'linear-gradient(135deg,#0D1526,#111827)',
    flexShrink: 0,
  },
  title: { fontSize: 17, fontWeight: 800, color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: 10, textTransform: 'uppercase', letterSpacing: '.04em' },
  badge: {
    background: 'rgba(239,35,60,.12)', color: '#EF233C',
    border: '1px solid rgba(239,35,60,.3)',
    borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 700,
  },
  closeBtn: {
    background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)', color: '#64748b',
    fontSize: 16, cursor: 'pointer', lineHeight: 1,
    padding: '5px 9px', borderRadius: 6, display: 'flex', alignItems: 'center',
  },
  body: { flex: 1, overflowY: 'auto', padding: '0 24px 24px' },
  statusBar: {
    padding: '12px 16px', margin: '16px 0 8px',
    borderRadius: 8, fontSize: 13, fontWeight: 600,
  },
  tableWrap: { overflowX: 'auto', borderRadius: 8, border: '1px solid rgba(255,255,255,.07)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    background: '#0D1526',
    color: '#475569', fontWeight: 800, fontSize: 10,
    textTransform: 'uppercase', letterSpacing: '.07em',
    padding: '9px 12px', textAlign: 'left',
    borderBottom: '2px solid rgba(239,35,60,.35)',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '6px 8px',
    borderBottom: '1px solid rgba(255,255,255,.04)',
    verticalAlign: 'middle', color: '#94a3b8',
  },
  input: {
    background: 'rgba(255,255,255,.04)',
    border: '1px solid rgba(255,255,255,.1)',
    borderRadius: 6, color: '#e2e8f0',
    padding: '5px 8px', width: '100%', fontSize: 12,
    outline: 'none', transition: 'border-color .15s',
  },
  select: {
    background: '#111827',
    border: '1px solid rgba(255,255,255,.1)',
    borderRadius: 6, color: '#e2e8f0',
    padding: '5px 8px', width: '100%', fontSize: 12,
    outline: 'none',
  },
  deleteBtn: {
    background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.25)', color: '#f87171',
    cursor: 'pointer', padding: '3px 7px', borderRadius: 5,
    fontSize: 13, lineHeight: 1,
  },
  addRowBtn: {
    background: 'rgba(239,35,60,.08)', border: '1px solid rgba(239,35,60,.25)',
    color: '#EF233C', borderRadius: 7, padding: '7px 16px',
    cursor: 'pointer', fontSize: 13, fontWeight: 700, marginTop: 12,
  },
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 24px',
    borderTop: '1px solid rgba(255,255,255,.07)',
    background: '#0D1526',
    flexShrink: 0, gap: 12,
  },
  footerNote: { color: '#475569', fontSize: 12 },
  cancelBtn: {
    background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.1)',
    color: '#94a3b8', borderRadius: 8, padding: '9px 20px',
    cursor: 'pointer', fontSize: 13, fontWeight: 600,
  },
  confirmBtn: (disabled) => ({
    background: disabled ? 'rgba(239,35,60,.15)' : 'linear-gradient(90deg,#EF233C,#D90429)',
    border: '1px solid rgba(239,35,60,.4)',
    color: disabled ? '#475569' : '#fff',
    borderRadius: 8, padding: '9px 24px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13, fontWeight: 700,
    boxShadow: disabled ? 'none' : '0 4px 14px rgba(239,35,60,.35)',
    transition: 'all .15s',
  }),
  emptyMsg: {
    textAlign: 'center', color: '#334155', padding: '40px 0', fontSize: 14,
  },
  rawSection: {
    marginTop: 16,
    background: 'rgba(255,255,255,.02)',
    border: '1px solid rgba(255,255,255,.07)',
    borderRadius: 8, padding: '12px 14px',
  },
  rawTitle: { color: '#475569', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 },
  rawText: { color: '#334155', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' },
}

const COLOR_PALETTE = [
  '#3B82F6', '#22C55E', '#F97316', '#A855F7',
  '#06B6D4', '#EAB308', '#EC4899', '#EF4444',
  '#14B8A6', '#F59E0B', '#6366F1', '#84CC16',
]

function blankRow() {
  return {
    _id: Math.random().toString(36).slice(2),
    mark: '', memberSize: '', memberType: 'Other',
    description: '', color: '',
  }
}

export default function ExtractionModal({ drawingId, drawingName, onClose, onSaved }) {
  const [phase, setPhase] = useState('idle')  // idle | scanning | preview | saving | done
  const [result, setResult] = useState(null)
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  const [showRaw, setShowRaw] = useState(false)
  const [saveResult, setSaveResult] = useState(null)
  const extractionStartedRef = useRef(false)

  const runExtraction = useCallback(async () => {
    if (extractionStartedRef.current || (phase !== 'idle' && phase !== 'preview')) return
    extractionStartedRef.current = true
    setPhase('scanning')
    setError(null)
    setSaveResult(null)
    try {
      const data = await extractionService.extract(drawingId)
      const uniqueMembers = dedupeExactExtractedMembers(data.members ?? [])
      const initialRows = sortMembersByMark(uniqueMembers).map((m, idx) => ({
        _id: Math.random().toString(36).slice(2),
        mark: m.mark ?? '',
        memberSize: m.memberSize ?? '',
        memberType: m.memberType ?? 'Other',
        description: m.description ?? '',
        sourceLine: formatPdfSourceLine(m.description, m.mark),
        color: m.color || COLOR_PALETTE[idx % COLOR_PALETTE.length],
      }))
      setResult(data)
      setRows(initialRows)
      setPhase('preview')
    } catch (err) {
      setError(err?.response?.data?.message ?? err.message ?? 'Extraction failed')
      setPhase('idle')
    } finally {
      extractionStartedRef.current = false
    }
  }, [drawingId, phase])

  const updateRow = (id, field, value) => {
    setRows(prev => prev.map(r => r._id === id ? { ...r, [field]: value } : r))
  }

  const updateSourceLine = (id, value) => {
    setRows(prev => prev.map(r => r._id === id
      ? { ...r, sourceLine: value, description: value }
      : r))
  }

  const deleteRow = (id) => setRows(prev => prev.filter(r => r._id !== id))

  const addRow = () => setRows(prev => [...prev, blankRow()])

  const handleConfirm = async () => {
    if (rows.length === 0) return
    setPhase('saving')
    try {
      const payload = rows.map(({ _id, ...r }) => r)
      const saved = await extractionService.confirm(drawingId, payload)
      setSaveResult(saved)
      setPhase('done')
      onSaved(saved)
    } catch (err) {
      setError(err?.response?.data?.message ?? err.message ?? 'Save failed')
      setPhase('preview')
    }
  }

  const stopProp = e => e.stopPropagation()

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={stopProp}>
        {/* Header */}
        <div style={s.header}>
          <div style={s.title}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#EF233C" strokeWidth="2">
              <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
            </svg>
            Project Member Schedule Extraction
            {result && (
              <span style={s.badge}>{result.pageCount} page{result.pageCount !== 1 ? 's' : ''}</span>
            )}
          </div>
          <button style={s.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>

        {/* Body */}
        <div style={s.body}>

          {/* Idle — scan prompt */}
          {phase === 'idle' && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
              <div style={{ color: '#e2e8f0', fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                Scan and Extract the Shared Member Schedule
              </div>
              <div style={{ color: '#64748b', fontSize: 13, marginBottom: 24, maxWidth: 480, margin: '0 auto 24px' }}>
                Reads <strong style={{ color: '#94a3b8' }}>Mark</strong>, <strong style={{ color: '#94a3b8' }}>Section size</strong>, and <strong style={{ color: '#94a3b8' }}>Type</strong> from{' '}
                <strong style={{ color: '#94a3b8' }}>{drawingName}</strong> (e.g. SC2, 360UB45).
                Length, qty and weight are added later in the Member Schedule panel.
              </div>
              {error && (
                <div style={{ ...s.statusBar, background: 'rgba(239,68,68,.12)', color: '#f87171', border: '1px solid rgba(239,68,68,.3)', marginBottom: 16 }}>
                  {error}
                </div>
              )}
              <button
                style={{ ...s.confirmBtn(false), padding: '12px 32px', fontSize: 15 }}
                onPointerDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  runExtraction()
                }}
                onClick={runExtraction}
              >
                Start Extraction
              </button>
            </div>
          )}

          {/* Scanning */}
          {phase === 'scanning' && (
            <div style={{ textAlign: 'center', padding: '50px 20px' }}>
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                border: '3px solid rgba(239,35,60,.15)', borderTopColor: '#EF233C',
                animation: 'spin 0.8s linear infinite', margin: '0 auto 20px',
              }} />
              <div style={{ color: '#94a3b8', fontSize: 14 }}>Scanning PDF and extracting structural data…</div>
            </div>
          )}

          {/* Preview / Edit */}
          {(phase === 'preview' || phase === 'saving') && (
            <>
              <div style={{
                ...s.statusBar,
                background: rows.length > 0 ? 'rgba(34,197,94,.08)' : 'rgba(245,158,11,.08)',
                color: rows.length > 0 ? '#4ade80' : '#fbbf24',
                border: `1px solid ${rows.length > 0 ? 'rgba(34,197,94,.25)' : 'rgba(245,158,11,.25)'}`,
              }}>
                {rows.length > 0
                  ? `Found ${rows.length} member(s) from the PDF — review Mark, Section & Type, then save`
                  : 'No members detected automatically — add rows manually or try a different drawing'}
              </div>

              {error && (
                <div style={{ ...s.statusBar, background: 'rgba(239,68,68,.12)', color: '#f87171', border: '1px solid rgba(239,68,68,.3)' }}>
                  {error}
                </div>
              )}

              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {[
                        ['Color', 'color'],
                        ['Mark (on drawing)', 'mark'],
                        ['Section size', 'size'],
                        ['Type', 'type'],
                        ['PDF source line', 'desc'],
                        ['', 'del'],
                      ].map(([h]) => (
                        <th key={h || 'x'} style={s.th} title={
                          h === 'Mark (on drawing)' ? 'Member reference from PDF e.g. SC2, C1, B1'
                          : h === 'Section size' ? 'Steel section from PDF e.g. 360UB45 (45 kg/m is part of this, not a separate column)'
                          : undefined
                        }>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr><td colSpan={6} style={{ ...s.td, ...s.emptyMsg }}>No rows — click "+ Add Row" to add manually</td></tr>
                    )}
                    {rows.map((row, idx) => (
                      <tr key={row._id} style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,.02)' }}>
                        <td style={{ ...s.td, width: 40 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <span style={{
                              display: 'inline-block', width: 18, height: 18, borderRadius: 4,
                              background: row.color || '#475569',
                              border: '2px solid rgba(255,255,255,.15)',
                              flexShrink: 0,
                            }} />
                            <input type="color" value={row.color || '#475569'}
                              onChange={e => updateRow(row._id, 'color', e.target.value)}
                              style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }} />
                          </label>
                        </td>
                        <td style={s.td}>
                          <input style={{ ...s.input, width: 60 }} value={row.mark}
                            onChange={e => updateRow(row._id, 'mark', e.target.value)} />
                        </td>
                        <td style={s.td}>
                          <input style={{ ...s.input, width: 130 }} value={row.memberSize}
                            onChange={e => updateRow(row._id, 'memberSize', e.target.value)} />
                        </td>
                        <td style={s.td}>
                          <select className="app-select" style={s.select} value={row.memberType}
                            onChange={e => updateRow(row._id, 'memberType', e.target.value)}>
                            {MEMBER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td style={s.td}>
                          <input style={{ ...s.input, width: 200 }}
                            value={row.sourceLine ?? row.description}
                            onChange={e => updateSourceLine(row._id, e.target.value)} />
                        </td>
                        <td style={s.td}>
                          <button style={s.deleteBtn} onClick={() => deleteRow(row._id)} title="Remove row">✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button style={s.addRowBtn} onClick={addRow}>+ Add Row</button>

              {result?.rawTextSample?.length > 0 && (
                <div style={s.rawSection}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={s.rawTitle}>Raw extracted text (sample)</span>
                    <button style={{ ...s.cancelBtn, padding: '2px 8px', fontSize: 11 }}
                      onClick={() => setShowRaw(v => !v)}>
                      {showRaw ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {showRaw && (
                    <pre style={s.rawText}>{result.rawTextSample.join('\n')}</pre>
                  )}
                </div>
              )}
            </>
          )}

          {/* Done */}
          {phase === 'done' && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
              <div style={{ color: '#4ade80', fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                {saveResult?.savedCount ?? rows.length} member(s) saved to Member Schedule
              </div>
              <div style={{ color: '#64748b', fontSize: 13 }}>
                Add length, qty and unit weight in the Member Schedule panel below.
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div style={s.footer}>
          <span style={s.footerNote}>
            {phase === 'preview' && `${rows.length} row(s) selected for import`}
            {phase === 'done' && 'Member Schedule updated'}
            {phase === 'idle' && 'OCR-based structural member detection'}
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            {phase === 'preview' && (
              <button style={s.cancelBtn} onClick={runExtraction}>← Re-scan</button>
            )}
            <button style={s.cancelBtn} onClick={onClose}>
              {phase === 'done' ? 'Close' : 'Cancel'}
            </button>
            {phase === 'preview' && (
              <button
                style={s.confirmBtn(rows.length === 0 || phase === 'saving')}
                disabled={rows.length === 0 || phase === 'saving'}
                onClick={handleConfirm}
              >
                {phase === 'saving' ? 'Saving…' : `Save ${rows.length} Member(s) →`}
              </button>
            )}
          </div>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
