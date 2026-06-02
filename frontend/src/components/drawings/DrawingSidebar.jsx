import { useRef, useState } from 'react'
import { drawingService } from '../../services/drawingService'
import { useAppStore } from '../../store/useAppStore'
import { fmtSize } from '../../utils/calculations'
import toast from 'react-hot-toast'

export default function DrawingSidebar({ drawings, selectedDrawing, onSelect, onUploaded, onDeleted }) {
  const { selectedProject } = useAppStore()
  const fileInputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [search, setSearch] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const filtered = drawings.filter(d => d.name.toLowerCase().includes(search.toLowerCase()))

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
    } catch {
      toast.error('Upload failed. Please try again.')
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

  const handleDelete = async (e, drawing) => {
    e.stopPropagation()
    if (!confirm(`Delete "${drawing.name}"?`)) return
    try {
      await drawingService.delete(drawing.id)
      toast.success('Drawing deleted')
      onDeleted(drawing.id)
    } catch {
      toast.error('Failed to delete drawing')
    }
  }

  return (
    <div style={{
      width: '240px',
      flexShrink: 0,
      background: '#0f172a',
      borderRight: '1px solid #1e293b',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding:'12px 12px 8px', borderBottom:'1px solid #1e293b' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'8px' }}>
          <span style={{ fontSize:'11px', fontWeight:700, color:'#64748b', textTransform:'uppercase', letterSpacing:'.08em' }}>
            Drawings
          </span>
          <span style={{ fontSize:'11px', color:'#475569', background:'#1e293b', padding:'2px 6px', borderRadius:'4px' }}>
            {drawings.length}
          </span>
        </div>

        {/* Search */}
        <div style={{ position:'relative' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2"
            style={{ position:'absolute', left:'8px', top:'50%', transform:'translateY(-50%)' }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search drawings…"
            style={{
              width:'100%', padding:'6px 8px 6px 26px',
              background:'#1e293b', border:'1px solid #334155', borderRadius:'6px',
              fontSize:'12px', color:'#cbd5e1', outline:'none', boxSizing:'border-box',
            }}
          />
        </div>
      </div>

      {/* Upload area */}
      <div style={{ padding:'8px 12px', borderBottom:'1px solid #1e293b' }}>
        {uploading ? (
          <div style={{ padding:'8px', background:'#1e293b', borderRadius:'8px' }}>
            <div style={{ fontSize:'11px', color:'#94a3b8', marginBottom:'6px' }}>
              Uploading… {uploadProgress}%
            </div>
            <div style={{ height:'4px', background:'#334155', borderRadius:'2px', overflow:'hidden' }}>
              <div style={{
                height:'100%', width:`${uploadProgress}%`,
                background:'linear-gradient(90deg,#1d6fdb,#3b82f6)',
                borderRadius:'2px', transition:'width .2s',
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
              padding:'10px',
              border:`1.5px dashed ${dragOver ? '#3b82f6' : '#334155'}`,
              borderRadius:'8px',
              textAlign:'center',
              cursor:'pointer',
              background: dragOver ? 'rgba(59,130,246,.08)' : 'transparent',
              transition:'all .15s',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={dragOver ? '#3b82f6' : '#475569'} strokeWidth="2"
              style={{ marginBottom:'4px' }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <div style={{ fontSize:'11px', color: dragOver ? '#60a5fa' : '#64748b' }}>
              Drop PDF or <span style={{ color:'#3b82f6', fontWeight:600 }}>browse</span>
            </div>
            <input ref={fileInputRef} type="file" accept=".pdf" style={{ display:'none' }}
              onChange={e => handleFiles(e.target.files)} />
          </div>
        )}
      </div>

      {/* Drawing list */}
      <div style={{ flex:1, overflowY:'auto', padding:'6px' }}>
        {filtered.length === 0 && (
          <div style={{ textAlign:'center', padding:'24px 12px', color:'#475569', fontSize:'12px' }}>
            {drawings.length === 0 ? 'No drawings yet.\nUpload a PDF to start.' : 'No results found.'}
          </div>
        )}
        {filtered.map(drawing => {
          const active = selectedDrawing?.id === drawing.id
          return (
            <div key={drawing.id}
              onClick={() => onSelect(drawing)}
              style={{
                padding:'8px 10px', borderRadius:'7px', marginBottom:'2px',
                cursor:'pointer', position:'relative',
                background: active ? '#1e3a5f' : 'transparent',
                border:`1px solid ${active ? '#1d6fdb' : 'transparent'}`,
                transition:'all .15s',
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#1e293b' }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ display:'flex', alignItems:'flex-start', gap:'8px' }}>
                <div style={{
                  width:'28px', height:'34px', flexShrink:0, borderRadius:'4px',
                  background: active ? 'rgba(29,111,219,.3)' : '#1e293b',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  border:`1px solid ${active ? '#1d6fdb' : '#334155'}`,
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke={active ? '#3b82f6' : '#475569'} strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{
                    fontSize:'12px', fontWeight: active ? 600 : 400,
                    color: active ? '#e2e8f0' : '#94a3b8',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                  }}>
                    {drawing.name}
                  </div>
                  <div style={{ fontSize:'10px', color:'#475569', marginTop:'2px' }}>
                    {drawing.fileSize ? fmtSize(drawing.fileSize) : 'PDF'}
                    {drawing.isCalibrated && (
                      <span style={{ marginLeft:'6px', color:'#22c55e', fontWeight:600 }}>● Calibrated</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Delete button — shown on hover */}
              <button onClick={e => handleDelete(e, drawing)} style={{
                position:'absolute', top:'6px', right:'6px',
                background:'none', border:'none', cursor:'pointer',
                color:'#475569', padding:'2px', borderRadius:'4px',
                opacity: active ? 1 : 0, transition:'opacity .15s',
                display:'flex', alignItems:'center',
              }}
                onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.opacity = 1 }}
                onMouseLeave={e => { e.currentTarget.style.color = '#475569' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                  <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
                </svg>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
