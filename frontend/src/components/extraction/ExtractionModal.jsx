import { useState, useCallback } from 'react'
import { extractionService } from '../../services/extractionService'

const MEMBER_TYPES = ['Beam', 'Column', 'Rafter', 'Purlin', 'Girt', 'Brace', 'Plate', 'Other']

const s = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,.80)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2000, backdropFilter: 'blur(6px)',
  },
  modal: {
    background: '#0f172a',
    border: '1px solid rgba(59,130,246,.30)',
    borderRadius: 16,
    width: '96vw', maxWidth: 1100,
    maxHeight: '90vh',
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 25px 80px rgba(0,0,0,.7)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '18px 24px',
    borderBottom: '1px solid rgba(255,255,255,.08)',
    flexShrink: 0,
  },
  title: { fontSize: 18, fontWeight: 700, color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: 10 },
  badge: {
    background: 'rgba(59,130,246,.2)', color: '#60a5fa',
    border: '1px solid rgba(59,130,246,.4)',
    borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 600,
  },
  closeBtn: {
    background: 'none', border: 'none', color: '#64748b',
    fontSize: 20, cursor: 'pointer', lineHeight: 1,
    padding: '4px 8px', borderRadius: 6,
  },
  body: { flex: 1, overflowY: 'auto', padding: '0 24px 24px' },
  statusBar: {
    padding: '12px 16px', margin: '16px 0 8px',
    borderRadius: 8, fontSize: 13, fontWeight: 500,
  },
  tableWrap: { overflowX: 'auto', borderRadius: 8, border: '1px solid rgba(255,255,255,.08)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    background: 'rgba(15,23,42,.9)',
    color: '#94a3b8', fontWeight: 600, fontSize: 11,
    textTransform: 'uppercase', letterSpacing: '.05em',
    padding: '10px 12px', textAlign: 'left',
    borderBottom: '1px solid rgba(255,255,255,.08)',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '6px 8px',
    borderBottom: '1px solid rgba(255,255,255,.05)',
    verticalAlign: 'middle',
  },
  input: {
    background: 'rgba(255,255,255,.06)',
    border: '1px solid rgba(255,255,255,.12)',
    borderRadius: 6, color: '#e2e8f0',
    padding: '5px 8px', width: '100%', fontSize: 12,
    outline: 'none',
  },
  select: {
    background: '#1e293b',
    border: '1px solid rgba(255,255,255,.12)',
    borderRadius: 6, color: '#e2e8f0',
    padding: '5px 8px', width: '100%', fontSize: 12,
    outline: 'none',
  },
  confBadge: (c) => ({
    display: 'inline-block',
    padding: '2px 8px', borderRadius: 10, fontSize: 11,
    background: c >= 0.8 ? 'rgba(34,197,94,.15)' : c >= 0.6 ? 'rgba(245,158,11,.15)' : 'rgba(239,68,68,.15)',
    color: c >= 0.8 ? '#4ade80' : c >= 0.6 ? '#fbbf24' : '#f87171',
    border: `1px solid ${c >= 0.8 ? 'rgba(34,197,94,.3)' : c >= 0.6 ? 'rgba(245,158,11,.3)' : 'rgba(239,68,68,.3)'}`,
  }),
  deleteBtn: {
    background: 'none', border: 'none', color: '#ef4444',
    cursor: 'pointer', padding: '3px 6px', borderRadius: 4,
    fontSize: 14, lineHeight: 1,
  },
  addRowBtn: {
    background: 'rgba(59,130,246,.1)', border: '1px solid rgba(59,130,246,.3)',
    color: '#60a5fa', borderRadius: 6, padding: '7px 14px',
    cursor: 'pointer', fontSize: 13, marginTop: 12,
  },
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 24px',
    borderTop: '1px solid rgba(255,255,255,.08)',
    flexShrink: 0, gap: 12,
  },
  footerNote: { color: '#64748b', fontSize: 12 },
  cancelBtn: {
    background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.15)',
    color: '#94a3b8', borderRadius: 8, padding: '9px 20px',
    cursor: 'pointer', fontSize: 14, fontWeight: 500,
  },
  confirmBtn: (disabled) => ({
    background: disabled ? 'rgba(59,130,246,.3)' : 'rgba(59,130,246,.85)',
    border: '1px solid rgba(59,130,246,.5)',
    color: disabled ? '#64748b' : '#fff',
    borderRadius: 8, padding: '9px 24px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 14, fontWeight: 600,
    transition: 'background .15s',
  }),
  emptyMsg: {
    textAlign: 'center', color: '#64748b', padding: '40px 0', fontSize: 14,
  },
  rawSection: {
    marginTop: 16,
    background: 'rgba(255,255,255,.03)',
    border: '1px solid rgba(255,255,255,.08)',
    borderRadius: 8, padding: '12px 14px',
  },
  rawTitle: { color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 },
  rawText: { color: '#475569', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' },
}

function blankRow() {
  return {
    _id: Math.random().toString(36).slice(2),
    mark: '', memberSize: '', memberType: 'Other',
    unitWeight: 0, length: 0, quantity: 1,
    description: '', confidence: 0,
  }
}

export default function ExtractionModal({ drawingId, drawingName, onClose, onSaved }) {
  const [phase, setPhase] = useState('idle')  // idle | scanning | preview | saving | done
  const [result, setResult] = useState(null)
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  const [showRaw, setShowRaw] = useState(false)

  const runExtraction = useCallback(async () => {
    setPhase('scanning')
    setError(null)
    try {
      const data = await extractionService.extract(drawingId)
      const initialRows = (data.members ?? []).map(m => ({
        _id: Math.random().toString(36).slice(2),
        mark: m.mark ?? '',
        memberSize: m.memberSize ?? '',
        memberType: m.memberType ?? 'Other',
        unitWeight: m.unitWeight ?? 0,
        length: m.length ?? 0,
        quantity: m.quantity ?? 1,
        description: m.description ?? '',
        confidence: m.confidence ?? 0,
      }))
      setResult(data)
      setRows(initialRows)
      setPhase('preview')
    } catch (err) {
      setError(err?.response?.data?.message ?? err.message ?? 'Extraction failed')
      setPhase('idle')
    }
  }, [drawingId])

  const updateRow = (id, field, value) => {
    setRows(prev => prev.map(r => r._id === id ? { ...r, [field]: value } : r))
  }

  const deleteRow = (id) => setRows(prev => prev.filter(r => r._id !== id))

  const addRow = () => setRows(prev => [...prev, blankRow()])

  const handleConfirm = async () => {
    if (rows.length === 0) return
    setPhase('saving')
    try {
      const saved = await extractionService.confirm(drawingId, rows)
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
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2">
              <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
            </svg>
            Drawing Schedule Extraction
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
                Scan and Extract Structural Members
              </div>
              <div style={{ color: '#64748b', fontSize: 13, marginBottom: 24, maxWidth: 420, margin: '0 auto 24px' }}>
                Scans <strong style={{ color: '#94a3b8' }}>{drawingName}</strong> for steel section sizes,
                member marks and lengths using OCR pattern recognition.
              </div>
              {error && (
                <div style={{ ...s.statusBar, background: 'rgba(239,68,68,.12)', color: '#f87171', border: '1px solid rgba(239,68,68,.3)', marginBottom: 16 }}>
                  {error}
                </div>
              )}
              <button
                style={{ ...s.confirmBtn(false), padding: '12px 32px', fontSize: 15 }}
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
                border: '3px solid rgba(59,130,246,.2)', borderTopColor: '#3b82f6',
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
                  ? `Found ${rows.length} member(s) — review and edit before saving`
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
                      {['Mark','Section Size','Type','Unit Wt (kg/m)','Length (m)','Qty','Description','Conf',''].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr><td colSpan={9} style={{ ...s.td, ...s.emptyMsg }}>No rows — click "+ Add Row" to add manually</td></tr>
                    )}
                    {rows.map((row, idx) => (
                      <tr key={row._id} style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,.02)' }}>
                        <td style={s.td}>
                          <input style={{ ...s.input, width: 60 }} value={row.mark}
                            onChange={e => updateRow(row._id, 'mark', e.target.value)} />
                        </td>
                        <td style={s.td}>
                          <input style={{ ...s.input, width: 130 }} value={row.memberSize}
                            onChange={e => updateRow(row._id, 'memberSize', e.target.value)} />
                        </td>
                        <td style={s.td}>
                          <select style={s.select} value={row.memberType}
                            onChange={e => updateRow(row._id, 'memberType', e.target.value)}>
                            {MEMBER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td style={s.td}>
                          <input style={{ ...s.input, width: 80 }} type="number" min={0} step={0.1}
                            value={row.unitWeight}
                            onChange={e => updateRow(row._id, 'unitWeight', e.target.value)} />
                        </td>
                        <td style={s.td}>
                          <input style={{ ...s.input, width: 80 }} type="number" min={0} step={0.001}
                            value={row.length}
                            onChange={e => updateRow(row._id, 'length', e.target.value)} />
                        </td>
                        <td style={s.td}>
                          <input style={{ ...s.input, width: 55 }} type="number" min={1} step={1}
                            value={row.quantity}
                            onChange={e => updateRow(row._id, 'quantity', e.target.value)} />
                        </td>
                        <td style={s.td}>
                          <input style={{ ...s.input, width: 160 }} value={row.description}
                            onChange={e => updateRow(row._id, 'description', e.target.value)} />
                        </td>
                        <td style={s.td}>
                          <span style={s.confBadge(row.confidence)}>
                            {row.confidence > 0 ? `${Math.round(row.confidence * 100)}%` : '—'}
                          </span>
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
                {rows.length} member(s) saved to Member Schedule
              </div>
              <div style={{ color: '#64748b', fontSize: 13 }}>
                You can view and edit them in the Member Schedule panel below.
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
              <button style={s.cancelBtn} onClick={() => setPhase('idle')}>← Re-scan</button>
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
