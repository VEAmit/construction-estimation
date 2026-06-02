import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { projectService } from '../services/projectService'
import { useAppStore } from '../store/useAppStore'
import toast from 'react-hot-toast'

const emptyForm = { name: '', projectNumber: '', clientName: '', description: '' }

export default function DashboardPage() {
  const navigate = useNavigate()
  const { projects, setProjects, setSelectedProject, setSelectedDrawing, setDrawings, userName } = useAppStore()
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [search, setSearch] = useState('')

  // Escape key closes the modal
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setShowCreate(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    projectService.getAll()
      .then(setProjects)
      .catch(() => toast.error('Failed to load projects'))
      .finally(() => setLoading(false))
  }, [])

  const setField = (f, v) => setForm(p => ({ ...p, [f]: v }))

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setCreating(true)
    try {
      const proj = await projectService.create(form)
      setProjects([...projects, proj])
      setForm(emptyForm)
      setShowCreate(false)
      toast.success(`Project "${proj.name}" created`)
    } catch {
      toast.error('Failed to create project')
    } finally {
      setCreating(false)
    }
  }

  const openProject = (project) => {
    // Clear stale drawing state BEFORE navigating so DrawingsPage's very first
    // render never sees a drawing that belongs to the previously-opened project.
    setSelectedDrawing(null)
    setDrawings([])
    setSelectedProject(project)
    navigate('/drawings')
  }

  const handleDelete = async (e, project) => {
    e.stopPropagation()
    if (!confirm(`Delete project "${project.name}"? This will also delete all drawings.`)) return
    try {
      await projectService.delete(project.id)
      setProjects(projects.filter(p => p.id !== project.id))
      toast.success('Project deleted')
    } catch {
      toast.error('Failed to delete project')
    }
  }

  const timeAgo = (dateStr) => {
    if (!dateStr) return ''
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  const filtered = projects.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.projectNumber ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (p.clientName ?? '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div style={{ flex:1, overflow:'auto', padding:'32px',
      background:'#0b1120', minHeight:0 }}>

      {/* Page header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'28px' }}>
        <div>
          <h1 style={{ fontSize:'22px', fontWeight:700, color:'#f1f5f9', margin:0, letterSpacing:'-0.5px' }}>
            Projects
          </h1>
          <p style={{ fontSize:'13px', color:'#94a3b8', marginTop:'4px' }}>
            Welcome back, {userName ?? 'User'} — {projects.length} project{projects.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div style={{ display:'flex', gap:'10px', alignItems:'center' }}>
          <div style={{ position:'relative' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2"
              style={{ position:'absolute', left:'10px', top:'50%', transform:'translateY(-50%)' }}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search projects…"
              style={{ padding:'8px 12px 8px 32px', background:'#162032', border:'1px solid #253a52',
                borderRadius:'8px', fontSize:'13px', color:'#cbd5e1', outline:'none', width:'220px' }} />
          </div>
          <button onClick={() => { setForm(emptyForm); setShowCreate(true) }} style={{
            display:'flex', alignItems:'center', gap:'7px', padding:'9px 18px',
            borderRadius:'9px', border:'none',
            background:'linear-gradient(90deg,#1d6fdb,#1558b0)',
            color:'#fff', fontSize:'13px', fontWeight:600, cursor:'pointer',
            boxShadow:'0 4px 16px rgba(29,111,219,.4)',
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New Project
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:'14px', marginBottom:'28px' }}>
        {[
          { label:'Total Projects', value: projects.length, color:'#3b82f6' },
          { label:'Active', value: projects.filter(p => p.status === 'Active').length, color:'#22c55e' },
          { label:'Completed', value: projects.filter(p => p.status === 'Completed').length, color:'#f59e0b' },
        ].map(stat => (
          <div key={stat.label} style={{
            background:'#162032', border:'1px solid #253a52', borderRadius:'10px',
            padding:'18px 20px', display:'flex', justifyContent:'space-between', alignItems:'center',
            boxShadow:'0 2px 8px rgba(0,0,0,.25)',
          }}>
            <div>
              <div style={{ fontSize:'28px', fontWeight:700, color:'#f1f5f9', lineHeight:1 }}>{stat.value}</div>
              <div style={{ fontSize:'11px', color:'#94a3b8', marginTop:'4px', fontWeight:500 }}>{stat.label}</div>
            </div>
            <div style={{ width:'10px', height:'10px', borderRadius:'50%', background: stat.color,
              boxShadow: `0 0 8px ${stat.color}80` }} />
          </div>
        ))}
      </div>

      {/* Projects grid */}
      {loading ? (
        <div style={{ display:'flex', justifyContent:'center', padding:'60px' }}>
          <svg className="spin" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:'80px 24px' }}>
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.5"
            style={{ marginBottom:'16px' }}>
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <p style={{ fontSize:'15px', color:'#94a3b8', marginBottom:'6px' }}>
            {search ? 'No projects match your search' : 'No projects yet'}
          </p>
          <p style={{ fontSize:'12px', color:'#64748b' }}>
            {search ? 'Try a different search term' : 'Click "New Project" to create your first project'}
          </p>
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))', gap:'16px' }}>
          {filtered.map(project => (
            <div key={project.id} onClick={() => openProject(project)} style={{
              background:'#162032', border:'1px solid #253a52', borderRadius:'12px',
              padding:'0', cursor:'pointer', position:'relative', overflow:'hidden',
              transition:'all .2s', boxShadow:'0 2px 8px rgba(0,0,0,.3)',
            }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = '#1d6fdb'
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = '0 8px 28px rgba(29,111,219,.2)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = '#253a52'
                e.currentTarget.style.transform = 'none'
                e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,.3)'
              }}
            >
              {/* Top accent */}
              <div style={{ height:'3px', background:'linear-gradient(90deg,#1d6fdb,#7c3aed)' }} />

              <div style={{ padding:'18px 20px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'12px' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
                    <div style={{ width:'38px', height:'38px', borderRadius:'9px',
                      background:'rgba(29,111,219,.2)', border:'1px solid rgba(29,111,219,.25)',
                      display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                        <polyline points="9 22 9 12 15 12 15 22"/>
                      </svg>
                    </div>
                    <div>
                      <h3 style={{ fontSize:'14px', fontWeight:600, color:'#f1f5f9', margin:0, lineHeight:1.3 }}>
                        {project.name}
                      </h3>
                      {project.projectNumber && (
                        <div style={{ fontSize:'11px', color:'#60a5fa', fontWeight:600, marginTop:'2px' }}>
                          {project.projectNumber}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:'5px', alignItems:'center' }}>
                    <span style={{
                      fontSize:'10px', fontWeight:700, padding:'3px 7px', borderRadius:'4px',
                      background: project.status === 'Active' ? 'rgba(34,197,94,.18)' : 'rgba(100,116,139,.18)',
                      color: project.status === 'Active' ? '#4ade80' : '#94a3b8',
                      border: `1px solid ${project.status === 'Active' ? 'rgba(34,197,94,.25)' : 'rgba(100,116,139,.25)'}`,
                    }}>
                      {project.status ?? 'Active'}
                    </span>
                    <button onClick={e => handleDelete(e, project)} style={{
                      background:'none', border:'none', cursor:'pointer', color:'#475569',
                      padding:'3px', borderRadius:'4px', transition:'color .15s',
                      display:'flex', alignItems:'center',
                    }}
                      onMouseEnter={e => { e.currentTarget.style.color = '#f87171' }}
                      onMouseLeave={e => { e.currentTarget.style.color = '#475569' }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                      </svg>
                    </button>
                  </div>
                </div>

                {project.clientName && (
                  <div style={{ fontSize:'12px', color:'#94a3b8', marginBottom:'4px', display:'flex', alignItems:'center', gap:'5px' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                      <circle cx="12" cy="7" r="4"/>
                    </svg>
                    {project.clientName}
                  </div>
                )}

                {project.description && (
                  <p style={{ fontSize:'11px', color:'#7c8fa6', margin:'0 0 10px',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {project.description}
                  </p>
                )}

                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:'10px',
                  paddingTop:'10px', borderTop:'1px solid #1e3050' }}>
                  <div style={{ fontSize:'10px', color:'#64748b', fontWeight:500 }}>
                    {project.drawingCount ?? 0} drawing{(project.drawingCount ?? 0) !== 1 ? 's' : ''}
                  </div>
                  <div style={{ fontSize:'10px', color:'#64748b' }}>
                    Updated {timeAgo(project.updatedAt ?? project.createdAt)}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Project Modal */}
      {showCreate && (
        <>
          {/* Always-visible close bar at top — impossible to miss */}
          <div style={{ position:'fixed', top:0, left:0, right:0, zIndex:1001,
            background:'#dc2626', color:'#fff', padding:'10px 20px',
            display:'flex', alignItems:'center', justifyContent:'space-between',
            fontWeight:700, fontSize:'14px' }}>
            <span>New Project form is open — click X or press Escape to close</span>
            <button onClick={() => setShowCreate(false)} style={{
              background:'#fff', color:'#dc2626', border:'none', borderRadius:'6px',
              padding:'4px 14px', fontWeight:700, fontSize:'14px', cursor:'pointer' }}>
              ✕ CLOSE
            </button>
          </div>
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)',
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}
          onClick={e => { if (e.target === e.currentTarget) setShowCreate(false) }}>
          <div style={{ background:'#1a2540', border:'2px solid #2d4a7a', borderRadius:'14px',
            padding:'0', width:'100%', maxWidth:'480px', boxShadow:'0 32px 80px rgba(0,0,0,.9)',
            overflow:'hidden' }}>

            {/* Modal header */}
            <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid #2d4a7a',
              background:'linear-gradient(135deg,#1a2e56,#152344)',
              display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div>
                <h2 style={{ fontSize:'16px', fontWeight:700, color:'#f1f5f9', margin:0 }}>
                  New Project
                </h2>
                <p style={{ fontSize:'11px', color:'#475569', margin:'3px 0 0' }}>
                  Create a new construction project
                </p>
              </div>
              <button onClick={() => setShowCreate(false)} style={{
                background:'rgba(255,255,255,.1)', border:'1px solid rgba(255,255,255,.2)',
                color:'#cbd5e1', cursor:'pointer', padding:'6px', borderRadius:'6px' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreate} style={{ padding:'22px 24px 24px', background:'#1a2540' }}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'14px', marginBottom:'14px' }}>
                <div style={{ gridColumn:'1/-1' }}>
                  <FieldLabel required>Project Name</FieldLabel>
                  <input autoFocus value={form.name} onChange={e => setField('name', e.target.value)}
                    required placeholder="e.g. Commercial Building Level 1"
                    style={inputStyle} />
                </div>
                <div>
                  <FieldLabel>Project Number</FieldLabel>
                  <input value={form.projectNumber} onChange={e => setField('projectNumber', e.target.value)}
                    placeholder="e.g. PRJ-2026-001"
                    style={inputStyle} />
                </div>
                <div>
                  <FieldLabel>Client Name</FieldLabel>
                  <input value={form.clientName} onChange={e => setField('clientName', e.target.value)}
                    placeholder="e.g. ABC Construction Ltd"
                    style={inputStyle} />
                </div>
                <div style={{ gridColumn:'1/-1' }}>
                  <FieldLabel>Description</FieldLabel>
                  <textarea value={form.description} onChange={e => setField('description', e.target.value)}
                    placeholder="Brief project description…" rows={3}
                    style={{ ...inputStyle, resize:'none' }} />
                </div>
              </div>

              <div style={{ display:'flex', gap:'10px', justifyContent:'flex-end', marginTop:'6px' }}>
                <button type="button" onClick={() => setShowCreate(false)} style={{
                  padding:'9px 18px', borderRadius:'8px', border:'1px solid #334155',
                  background:'transparent', color:'#94a3b8', fontSize:'13px', cursor:'pointer',
                }}>Cancel</button>
                <button type="submit" disabled={creating || !form.name.trim()} style={{
                  padding:'9px 22px', borderRadius:'8px', border:'none',
                  background: creating || !form.name.trim() ? '#1e293b' : 'linear-gradient(90deg,#1d6fdb,#1558b0)',
                  color: creating || !form.name.trim() ? '#475569' : '#fff',
                  fontSize:'13px', fontWeight:600, cursor: creating ? 'not-allowed' : 'pointer',
                  display:'flex', alignItems:'center', gap:'7px',
                }}>
                  {creating && (
                    <svg className="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                    </svg>
                  )}
                  {creating ? 'Creating…' : 'Create Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </>
      )}
    </div>
  )
}

function FieldLabel({ children, required }) {
  return (
    <label style={{ display:'block', fontSize:'11px', fontWeight:600, color:'#64748b',
      marginBottom:'5px', textTransform:'uppercase', letterSpacing:'.05em' }}>
      {children}{required && <span style={{ color:'#f87171', marginLeft:'2px' }}>*</span>}
    </label>
  )
}

const inputStyle = {
  width:'100%', padding:'9px 11px', background:'#1e293b', border:'1px solid #334155',
  borderRadius:'7px', fontSize:'13px', color:'#f1f5f9', outline:'none', boxSizing:'border-box',
}
