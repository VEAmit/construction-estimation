export default function ProjectExportModal({
  project,
  drawings,
  loadingFormat,
  onExport,
  onClose,
}) {
  const drawingCount = drawings?.length ?? 0
  const loading = Boolean(loadingFormat)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-export-title"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !loading) onClose?.()
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 5000, padding: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(2,6,23,.82)', backdropFilter: 'blur(4px)',
      }}>
      <div style={{
        width: 'min(680px, 100%)', maxHeight: 'min(760px, calc(100vh - 32px))', overflow: 'auto',
        background: '#0D1526', border: '1px solid rgba(96,165,250,.28)', borderRadius: 12,
        boxShadow: '0 24px 70px rgba(0,0,0,.55)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, padding: '17px 18px 14px',
          borderBottom: '1px solid rgba(255,255,255,.07)',
        }}>
          <span style={{
            width: 36, height: 36, flexShrink: 0, borderRadius: 9,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#60a5fa', background: 'rgba(59,130,246,.12)', border: '1px solid rgba(59,130,246,.28)',
          }}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/>
            </svg>
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 id="project-export-title" style={{ margin: 0, color: '#f8fafc', fontSize: 16, fontWeight: 800 }}>
              Project Measurements Export
            </h2>
            <p style={{ margin: '5px 0 0', color: '#94a3b8', fontSize: 11.5, lineHeight: 1.5 }}>
              Export every saved measurement from all PDFs and pages in{' '}
              <strong style={{ color: '#e2e8f0' }}>{project?.name ?? 'this project'}</strong>.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            aria-label="Close project export"
            style={{
              width: 28, height: 28, flexShrink: 0, borderRadius: 6,
              border: '1px solid rgba(255,255,255,.1)', background: 'transparent',
              color: '#64748b', fontSize: 17, cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? .4 : 1,
            }}>
            ×
          </button>
        </div>

        <div style={{ padding: 18 }}>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 9, marginBottom: 15,
          }}>
            <SummaryCard label="PDFs / Drawings" value={drawingCount} />
            <SummaryCard label="Export Scope" value="All pages" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
            <ExportButton
              format="excel"
              title="Export Complete Excel"
              detail="Workbook with summary, measurements, section placements and member schedule"
              color="#22c55e"
              loading={loadingFormat === 'excel'}
              disabled={loading || drawingCount === 0}
              onClick={() => onExport?.('excel')}
            />
            <ExportButton
              format="pdf"
              title="Export Complete PDF"
              detail="Consolidated printable report covering the entire project"
              color="#f87171"
              loading={loadingFormat === 'pdf'}
              disabled={loading || drawingCount === 0}
              onClick={() => onExport?.('pdf')}
            />
          </div>

          {loading && (
            <div role="status" style={{
              marginTop: 13, color: '#60a5fa', fontSize: 11, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            }}>
              <span className="spin" style={{
                width: 11, height: 11, display: 'inline-block', borderRadius: '50%',
                border: '2px solid rgba(96,165,250,.25)', borderTopColor: '#60a5fa',
              }} />
              Collecting measurements from every drawing…
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ label, value }) {
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8, background: 'rgba(59,130,246,.07)',
      border: '1px solid rgba(59,130,246,.16)',
    }}>
      <div style={{ color: '#64748b', fontSize: 9.5, fontWeight: 750, textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {label}
      </div>
      <div style={{ marginTop: 3, color: '#e2e8f0', fontSize: 17, fontWeight: 850 }}>{value}</div>
    </div>
  )
}

function ExportButton({ format, title, detail, color, loading, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      style={{
        minWidth: 0, minHeight: 108, padding: 13, textAlign: 'left', borderRadius: 9,
        border: `1px solid ${color}45`, background: `${color}0D`, color,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled && !loading ? .42 : 1,
      }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 850 }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <path d="M14 2v6h6"/><path d="M8 13h8M8 17h8"/>
        </svg>
        {loading ? `Preparing ${format === 'excel' ? 'Excel' : 'PDF'}…` : title}
      </span>
      <span style={{ display: 'block', marginTop: 8, color: '#64748b', fontSize: 10, lineHeight: 1.45, fontWeight: 500 }}>
        {detail}
      </span>
    </button>
  )
}
