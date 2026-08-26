import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { projectService } from '../services/projectService'
import { useAppStore } from '../store/useAppStore'
import { useBreakpoint } from '../utils/useBreakpoint'
import ConfirmModal from '../components/common/ConfirmModal'
import toast from 'react-hot-toast'
import { APP_VERSION } from '../version'

const emptyForm = { name: '', projectNumber: '', clientName: '', description: '' }

export default function DashboardPage() {
  const navigate = useNavigate()
  const { projects, setProjects, setSelectedProject, setSelectedDrawing, setDrawings, userName } = useAppStore()
  const { isMobile, isTablet, isSmallMobile } = useBreakpoint()

  const [loading,    setLoading]    = useState(true)
  const [creating,   setCreating]   = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [form,       setForm]       = useState(emptyForm)
  const [search,       setSearch]       = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting,     setDeleting]     = useState(false)

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
      setProjects([proj, ...projects])
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
    setSelectedDrawing(null)
    setDrawings([])
    setSelectedProject(project)
    navigate('/drawings')
  }

  const handleDeleteClick = (e, project) => {
    e.stopPropagation()
    setDeleteTarget(project)
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await projectService.delete(deleteTarget.id)
      setProjects(projects.filter(p => p.id !== deleteTarget.id))
      toast.success('Project deleted')
      setDeleteTarget(null)
    } catch {
      toast.error('Failed to delete project')
    } finally {
      setDeleting(false)
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

  /* ── Responsive grid columns ─────────────────────────────── */
  const statCols   = isSmallMobile ? '1fr' : 'repeat(2,minmax(0,1fr))'
  const projectCols = isMobile ? '1fr' : isTablet ? 'repeat(2,1fr)' : 'repeat(4,1fr)'
  const pad        = isMobile ? '16px' : '28px 32px'

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: pad, background: '#080B12', minHeight: 0 }}>

      {/* ── Page header ── */}
      <div style={{
        display: 'flex', alignItems: isMobile ? 'flex-start' : 'center',
        flexDirection: isMobile ? 'column' : 'row',
        justifyContent: 'space-between',
        gap: '12px', marginBottom: isMobile ? '16px' : '24px',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
            <div style={{ width: '3px', height: '22px', background: '#EF233C', borderRadius: '2px' }} />
            <h1 style={{ fontSize: isMobile ? '18px' : '20px', fontWeight: 800, color: '#fff', margin: 0, letterSpacing: '-0.4px', textTransform: 'uppercase' }}>
              Projects
            </h1>
          </div>
          <p style={{ fontSize: '12px', color: '#475569', marginTop: '2px', paddingLeft: '13px' }}>
            Welcome back, <span style={{ color: '#94a3b8', fontWeight: 600 }}>{userName ?? 'User'}</span>
            {' '}— {projects.length} project{projects.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Search + New Project */}
        <div style={{
          display: 'flex', gap: '10px', alignItems: 'center',
          width: isMobile ? '100%' : 'auto',
          flexWrap: 'wrap',
        }}>
          <div style={{ position: 'relative', flex: isMobile ? 1 : 'none' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2"
              style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search projects…"
              style={{
                padding: '9px 12px 9px 32px',
                background: '#111827', border: '1px solid rgba(255,255,255,.07)',
                borderRadius: '8px', fontSize: '13px', color: '#cbd5e1',
                outline: 'none', width: isMobile ? '100%' : '220px',
                boxSizing: 'border-box', transition: 'border-color .15s',
              }}
              onFocus={e => e.target.style.borderColor = 'rgba(239,35,60,.35)'}
              onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,.07)'}
            />
          </div>

          <button
            onClick={() => { setForm(emptyForm); setShowCreate(true) }}
            style={{
              display: 'flex', alignItems: 'center', gap: '7px',
              padding: '9px 18px', borderRadius: '8px',
              border: '1px solid rgba(239,35,60,.3)',
              background: 'linear-gradient(90deg,#EF233C,#D90429)',
              color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(239,35,60,.4)',
              whiteSpace: 'nowrap', touchAction: 'manipulation',
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New Project
          </button>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: statCols, gap: isMobile ? '10px' : '12px', marginBottom: isMobile ? '16px' : '24px' }}>
        {[
          { label: 'Total Projects', value: projects.length, color: '#EF233C', detail: 'All projects in your workspace', icon: 'folder' },
          { label: 'Active Projects', value: projects.filter(p => p.status === 'Active').length, color: '#22C55E', detail: 'Available for drawings and takeoff', icon: 'active' },
        ].map(stat => (
          <div key={stat.label} style={{
            background: `linear-gradient(135deg,#111827 55%,${stat.color}0D)`,
            border: '1px solid rgba(255,255,255,.07)',
            borderRadius: '12px', padding: isMobile ? '14px 16px' : '18px 22px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            minHeight: isMobile ? '64px' : '76px', boxSizing: 'border-box',
            boxShadow: '0 4px 18px rgba(0,0,0,.28)',
            borderLeft: `3px solid ${stat.color}`,
          }}>
            <div>
              <div style={{ fontSize: isMobile ? '24px' : '30px', fontWeight: 800, color: '#fff', lineHeight: 1 }}>{stat.value}</div>
              <div style={{ fontSize: isMobile ? '10px' : '11px', color: stat.color, marginTop: '6px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em' }}>{stat.label}</div>
              {!isSmallMobile && (
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>{stat.detail}</div>
              )}
            </div>
            <div style={{
              width: isMobile ? '36px' : '44px', height: isMobile ? '36px' : '44px', borderRadius: '10px',
              background: `${stat.color}15`, border: `1px solid ${stat.color}25`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: stat.color, flexShrink: 0,
            }}>
              {stat.icon === 'folder' ? (
                <svg width={isMobile ? 18 : 21} height={isMobile ? 18 : 21} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>
                </svg>
              ) : (
                <svg width={isMobile ? 18 : 21} height={isMobile ? 18 : 21} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16.5 9"/>
                </svg>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── Projects grid ── */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}>
          <svg className="spin" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#EF233C" strokeWidth="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: isMobile ? '48px 16px' : '80px 24px' }}>
          <div style={{
            width: '56px', height: '56px', borderRadius: '14px', margin: '0 auto 16px',
            background: 'rgba(239,35,60,.08)', border: '1px solid rgba(239,35,60,.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#EF233C" strokeWidth="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          </div>
          <p style={{ fontSize: '15px', color: '#94a3b8', marginBottom: '6px', fontWeight: 600 }}>
            {search ? 'No projects match your search' : 'No projects yet'}
          </p>
          <p style={{ fontSize: '12px', color: '#475569' }}>
            {search ? 'Try a different search term' : 'Click "New Project" to get started'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: projectCols, gap: isMobile ? '12px' : '18px' }}>
          {filtered.map(project => (
            <div
              key={project.id}
              onClick={() => openProject(project)}
              style={{
                background: '#111827', border: '1px solid rgba(255,255,255,.06)',
                borderRadius: '12px', cursor: 'pointer', position: 'relative',
                overflow: 'hidden', transition: 'all .2s',
                boxShadow: '0 2px 10px rgba(0,0,0,.4)',
                touchAction: 'manipulation',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'rgba(239,35,60,.35)'
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = '0 8px 32px rgba(239,35,60,.15)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,.06)'
                e.currentTarget.style.transform = 'none'
                e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,.4)'
              }}
            >
              <div style={{ height: '2px', background: 'linear-gradient(90deg,#EF233C,rgba(239,35,60,.2))' }} />
              <div style={{ padding: isMobile ? '14px 16px' : '20px 22px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                    <div style={{
                      width: '44px', height: '44px', borderRadius: '10px', flexShrink: 0,
                      background: 'rgba(239,35,60,.1)', border: '1px solid rgba(239,35,60,.2)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {(project.drawingCount ?? 0) > 0 ? (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#EF233C" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                          <line x1="16" y1="13" x2="8" y2="13"/>
                          <line x1="16" y1="17" x2="8" y2="17"/>
                        </svg>
                      ) : (
                        <img src="/small-logo.png" alt="BuildTakeoff Pro" style={{ width: '20px', height: '20px', objectFit: 'contain' }} />
                      )}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#f1f5f9', margin: 0, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {project.name}
                      </h3>
                      {project.projectNumber && (
                        <div style={{ fontSize: '12px', color: '#EF233C', fontWeight: 700, marginTop: '3px' }}>
                          {project.projectNumber}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '5px', alignItems: 'center', flexShrink: 0, marginLeft: '8px' }}>
                    <span style={{
                      fontSize: '10px', fontWeight: 700, padding: '3px 7px', borderRadius: '20px',
                      background: project.status === 'Active' ? 'rgba(34,197,94,.12)' : 'rgba(100,116,139,.12)',
                      color: project.status === 'Active' ? '#4ade80' : '#94a3b8',
                      border: `1px solid ${project.status === 'Active' ? 'rgba(34,197,94,.25)' : 'rgba(100,116,139,.2)'}`,
                      whiteSpace: 'nowrap',
                    }}>
                      ● {project.status ?? 'Active'}
                    </span>
                    <button
                      onClick={e => handleDeleteClick(e, project)}
                      title="Delete project"
                      style={{
                        display: 'flex', alignItems: 'center', gap: '5px',
                        fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '20px',
                        background: 'rgba(239,35,60,.12)', color: '#EF233C',
                        border: '1px solid rgba(239,35,60,.25)',
                        cursor: 'pointer', transition: 'all .15s', whiteSpace: 'nowrap',
                        touchAction: 'manipulation',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = 'rgba(239,35,60,.2)'
                        e.currentTarget.style.borderColor = 'rgba(239,35,60,.45)'
                        e.currentTarget.style.color = '#ff6b6b'
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'rgba(239,35,60,.12)'
                        e.currentTarget.style.borderColor = 'rgba(239,35,60,.25)'
                        e.currentTarget.style.color = '#EF233C'
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                        <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
                      </svg>
                      {!isMobile && 'Delete'}
                    </button>
                  </div>
                </div>

                {project.clientName && (
                  <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                      <circle cx="12" cy="7" r="4"/>
                    </svg>
                    {project.clientName}
                  </div>
                )}

                {project.description && (
                  <p style={{ fontSize: '12px', color: '#475569', margin: '0 0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {project.description}
                  </p>
                )}

                <div style={{
                  marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.05)',
                }}>
                  <div style={{ fontSize: '15px', color: '#EF233C', fontWeight: 700 }}>
                    {project.drawingCount ?? 0} drawing{(project.drawingCount ?? 0) !== 1 ? 's' : ''}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Create Project Modal ── */}
      {showCreate && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)',
            display: 'flex', alignItems: isMobile ? 'flex-end' : 'center',
            justifyContent: 'center', zIndex: 1000,
            backdropFilter: 'blur(6px)', padding: isMobile ? 0 : '16px',
          }}
          onClick={e => { if (e.target === e.currentTarget) setShowCreate(false) }}
        >
          <div style={{
            background: '#111827', border: '1px solid rgba(255,255,255,.08)',
            borderRadius: isMobile ? '16px 16px 0 0' : '14px',
            width: '100%', maxWidth: isMobile ? '100%' : '480px',
            boxShadow: '0 32px 80px rgba(0,0,0,.9)', overflow: 'hidden',
          }}>
            {/* Modal header */}
            <div style={{
              padding: '18px 20px 14px',
              borderBottom: '1px solid rgba(255,255,255,.07)',
              background: 'linear-gradient(135deg,#0D1526,#111827)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '3px', height: '28px', background: '#EF233C', borderRadius: '2px' }} />
                <div>
                  <h2 style={{ fontSize: '15px', fontWeight: 800, color: '#f1f5f9', margin: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    New Project
                  </h2>
                  <p style={{ fontSize: '11px', color: '#475569', margin: '2px 0 0' }}>
                    Create a new construction project
                  </p>
                </div>
              </div>
              <button onClick={() => setShowCreate(false)} style={{
                background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.1)',
                color: '#94a3b8', cursor: 'pointer', padding: '7px', borderRadius: '6px',
                display: 'flex', alignItems: 'center', touchAction: 'manipulation',
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreate} style={{ padding: '20px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '14px', marginBottom: '14px' }}>
                <div style={{ gridColumn: isMobile ? '1' : '1/-1' }}>
                  <FieldLabel required>Project Name</FieldLabel>
                  <input autoFocus value={form.name} onChange={e => setField('name', e.target.value)}
                    required placeholder="e.g. Commercial Building Level 1"
                    style={inputStyle}
                    onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.12)' }}
                    onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
                  />
                </div>
                <div>
                  <FieldLabel>Project Number</FieldLabel>
                  <input value={form.projectNumber} onChange={e => setField('projectNumber', e.target.value)}
                    placeholder="e.g. PRJ-2026-001" style={inputStyle}
                    onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.12)' }}
                    onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
                  />
                </div>
                <div>
                  <FieldLabel>Client Name</FieldLabel>
                  <input value={form.clientName} onChange={e => setField('clientName', e.target.value)}
                    placeholder="e.g. ABC Construction Ltd" style={inputStyle}
                    onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.12)' }}
                    onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
                  />
                </div>
                <div style={{ gridColumn: isMobile ? '1' : '1/-1' }}>
                  <FieldLabel>Description</FieldLabel>
                  <textarea value={form.description} onChange={e => setField('description', e.target.value)}
                    placeholder="Brief project description…" rows={3}
                    style={{ ...inputStyle, resize: 'none' }}
                    onFocus={e => { e.target.style.borderColor = '#EF233C'; e.target.style.boxShadow = '0 0 0 3px rgba(239,35,60,.12)' }}
                    onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,.1)'; e.target.style.boxShadow = 'none' }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowCreate(false)} style={{
                  padding: '11px 18px', borderRadius: '8px', border: '1px solid rgba(255,255,255,.1)',
                  background: 'transparent', color: '#94a3b8', fontSize: '13px', cursor: 'pointer',
                  touchAction: 'manipulation', flex: isMobile ? 1 : 'none',
                }}>Cancel</button>
                <button type="submit" disabled={creating || !form.name.trim()} style={{
                  padding: '11px 22px', borderRadius: '8px', border: 'none',
                  background: creating || !form.name.trim() ? 'rgba(239,35,60,.15)' : 'linear-gradient(90deg,#EF233C,#D90429)',
                  color: creating || !form.name.trim() ? '#475569' : '#fff',
                  fontSize: '13px', fontWeight: 700,
                  cursor: creating ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', gap: '7px',
                  boxShadow: creating || !form.name.trim() ? 'none' : '0 4px 14px rgba(239,35,60,.35)',
                  touchAction: 'manipulation', flex: isMobile ? 1 : 'none',
                  justifyContent: 'center',
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
      )}

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete project"
        message={deleteTarget
          ? `Delete project "${deleteTarget.name}"? This will also delete all drawings.`
          : ''}
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={confirmDelete}
        onCancel={() => !deleting && setDeleteTarget(null)}
        loading={deleting}
        danger
      />

      <p style={{ textAlign: 'center', color: '#EF233C', fontWeight: 700, fontSize: '11px', marginTop: '32px' }}>
        v{APP_VERSION}
      </p>
    </div>
  )
}

function FieldLabel({ children, required }) {
  return (
    <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: '#475569', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '.06em' }}>
      {children}{required && <span style={{ color: '#EF233C', marginLeft: '2px' }}>*</span>}
    </label>
  )
}

const inputStyle = {
  width: '100%', padding: '11px 12px',
  background: 'rgba(255,255,255,.04)',
  border: '1px solid rgba(255,255,255,.1)',
  borderRadius: '7px', fontSize: '14px', color: '#f1f5f9',
  outline: 'none', boxSizing: 'border-box',
  transition: 'border-color .15s, box-shadow .15s',
}
