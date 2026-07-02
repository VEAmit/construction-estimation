import { useRef, useState } from 'react'
import { drawingService } from '../../services/drawingService'
import { useAppStore } from '../../store/useAppStore'
import { fmtSize } from '../../utils/calculations'
import ConfirmModal from '../common/ConfirmModal'
import toast from 'react-hot-toast'

export default function DrawingSidebar({ drawings, selectedDrawing, onSelect, onUploaded, onDeleted }) {
  const { selectedProject } = useAppStore()
  const fileInputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [search, setSearch] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const list = Array.isArray(drawings) ? drawings : []
  const filtered = list.filter(d => d?.name?.toLowerCase().includes(search.toLowerCase()))

  const handleFiles = async (files) => {
    const file = files[0]
    if (!file) return
    if (file.type !== 'application/pdf') { toast.error('Only PDF files are supported'); return }
    if (!selectedProject) { toast.error('Please select a project first'); return }

    setUploading(true)
    setUploadProgress(0)
    try {
      const drawing = await drawingService.upload(selectedProject.id, file, (pct) => setUploadProgress(pct))
      toast.success(`"${drawing.name}" uploaded successfully`)
      onUploaded(drawing)
    } catch (err) {
      const serverMsg = err?.response?.data?.message ?? err?.response?.data?.Message ?? null
      if (err?.response?.status === 404 || (serverMsg && /not found/i.test(serverMsg))) {
        toast.error('Project not found in database — go back to Dashboard and re-open the project.', { duration: 7000 })
      } else {
        toast.error(serverMsg ?? 'Upload failed — please try again.')
      }
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    handleFiles(e.dataTransfer.files)
  }

  const handleDeleteClick = (e, drawing) => {
    e.stopPropagation()
    setDeleteTarget(drawing)
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await drawingService.delete(deleteTarget.id)
      toast.success('Drawing deleted')
      onDeleted(deleteTarget.id)
      setDeleteTarget(null)
    } catch {
      toast.error('Failed to delete drawing')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div style={{
      width: '240px',
      flexShrink: 0,
      background: '#0B1320',
      borderRight: '1px solid rgba(255,255,255,0.07)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>

      {/* Header */}
      <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <div style={{ width: '2px', height: '14px', background: '#EF233C', borderRadius: '1px' }} />
            <span style={{ fontSize: '10px', fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.1em' }}>
              Drawings
            </span>
          </div>
          <span style={{
            fontSize: '11px', color: '#EF233C', fontWeight: 700,
            background: 'rgba(239,35,60,.1)', padding: '1px 7px', borderRadius: '10px',
            border: '1px solid rgba(239,35,60,.2)',
          }}>
            {list.length}
          </span>
        </div>

        {/* Search */}
        <div style={{ position: 'relative' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2"
            style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search drawings…"
            style={{
              width: '100%', padding: '6px 8px 6px 26px',
              background: 'rgba(255,255,255,.04)',
              border: '1px solid rgba(255,255,255,.07)',
              borderRadius: '6px', fontSize: '12px', color: '#cbd5e1',
              outline: 'none', boxSizing: 'border-box',
              transition: 'border-color .15s',
            }}
            onFocus={e => e.target.style.borderColor = 'rgba(239,35,60,.35)'}
            onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,.07)'}
          />
        </div>
      </div>

      {/* Upload area */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.07)' }}>
        {uploading ? (
          <div style={{ padding: '10px', background: 'rgba(255,255,255,.04)', borderRadius: '8px' }}>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '7px', display: 'flex', justifyContent: 'space-between' }}>
              <span>Uploading…</span>
              <span style={{ color: '#EF233C', fontWeight: 700 }}>{uploadProgress}%</span>
            </div>
            <div style={{ height: '4px', background: 'rgba(255,255,255,.06)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${uploadProgress}%`,
                background: 'linear-gradient(90deg,#EF233C,#D90429)',
                borderRadius: '2px', transition: 'width .2s',
                boxShadow: '0 0 8px rgba(239,35,60,.5)',
              }} />
            </div>
          </div>
        ) : (
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '12px 10px',
              border: `1.5px dashed ${dragOver ? '#EF233C' : 'rgba(255,255,255,.1)'}`,
              borderRadius: '8px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? 'rgba(239,35,60,.06)' : 'transparent',
              transition: 'all .15s',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke={dragOver ? '#EF233C' : '#475569'} strokeWidth="2"
              style={{ marginBottom: '5px' }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <div style={{ fontSize: '11px', color: dragOver ? '#EF233C' : '#EF233C', fontWeight: 600 }}>
              Drop PDF or <span style={{ color: '#EF233C', fontWeight: 700 }}>browse</span>
            </div>
            <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }}
              onChange={e => handleFiles(e.target.files)} />
          </div>
        )}
      </div>

      {/* Drawing list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 12px', color: '#EF233C', fontSize: '12px', fontWeight: 600 }}>
            {list.length === 0 ? 'No drawings yet.\nUpload a PDF to start.' : 'No results found.'}
          </div>
        )}
        {filtered.map(drawing => {
          const active = selectedDrawing?.id === drawing.id
          return (
            <div
              key={drawing.id}
              onClick={() => onSelect(drawing)}
              style={{
                padding: '8px 10px', borderRadius: '7px', marginBottom: '2px',
                cursor: 'pointer', position: 'relative',
                background: active ? 'rgba(239,35,60,.1)' : 'transparent',
                border: `1px solid ${active ? 'rgba(239,35,60,.3)' : 'transparent'}`,
                transition: 'all .15s',
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,.04)' }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                {/* PDF icon */}
                <div style={{
                  width: '28px', height: '34px', flexShrink: 0, borderRadius: '4px',
                  background: active ? 'rgba(239,35,60,.15)' : 'rgba(255,255,255,.04)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `1px solid ${active ? 'rgba(239,35,60,.3)' : 'rgba(255,255,255,.07)'}`,
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke={active ? '#EF233C' : '#475569'} strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '12px', fontWeight: active ? 700 : 400,
                    color: active ? '#f1f5f9' : '#94a3b8',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {drawing.name}
                  </div>
                  <div style={{ fontSize: '10px', color: '#334155', marginTop: '2px' }}>
                    {drawing.fileSize ? fmtSize(drawing.fileSize) : 'PDF'}
                    {drawing.isCalibrated && (
                      <span style={{ marginLeft: '6px', color: '#22c55e', fontWeight: 700 }}>● Calibrated</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Delete button */}
              <button onClick={e => handleDeleteClick(e, drawing)} style={{
                position: 'absolute', top: '6px', right: '6px',
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#EF233C', padding: '2px', borderRadius: '4px',
                opacity: active ? 1 : 0.75, transition: 'opacity .15s, color .15s',
                display: 'flex', alignItems: 'center',
              }}
                onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.opacity = 1 }}
                onMouseLeave={e => { e.currentTarget.style.color = '#EF233C'; e.currentTarget.style.opacity = active ? 1 : 0.75 }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                  <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
                </svg>
              </button>
            </div>
          )
        })}
      </div>

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete drawing"
        message={deleteTarget ? `Delete "${deleteTarget.name}"?` : ''}
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={confirmDelete}
        onCancel={() => !deleting && setDeleteTarget(null)}
        loading={deleting}
        danger
      />
    </div>
  )
}
