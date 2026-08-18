import { useEffect, useMemo, useRef, useState } from 'react'
import { Layers3, X } from 'lucide-react'

export default function SectionMeasurementModal({
  selection,
  existingNames = [],
  saving = false,
  error = '',
  mode = 'create',
  initialName = '',
  onSave,
  onCancel,
}) {
  const inputRef = useRef(null)
  const suggestedName = useMemo(() => {
    let number = 1
    const used = new Set(existingNames.map(name => String(name).trim().toLowerCase()))
    while (used.has(`section ${number}`)) number += 1
    return `Section ${number}`
  }, [existingNames])
  const editing = mode === 'edit'
  const [name, setName] = useState(initialName || suggestedName)

  useEffect(() => {
    setName(initialName || suggestedName)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [initialName, suggestedName])

  const submit = (event) => {
    event?.preventDefault?.()
    const clean = name.trim()
    if (!clean || saving) return
    onSave?.(clean)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="section-measurement-title"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel?.() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10050,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18,
        background: 'rgba(2,6,23,.78)', backdropFilter: 'blur(5px)',
      }}
    >
      <form onSubmit={submit} style={{
        width: 'min(480px, 96vw)', overflow: 'hidden', borderRadius: 10,
        background: '#0D1526', border: '1px solid rgba(239,35,60,.35)',
        boxShadow: '0 24px 70px rgba(0,0,0,.58)',
      }}>
        <div style={{
          height: 48, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
          borderBottom: '1px solid rgba(255,255,255,.08)',
        }}>
          <span style={{
            width: 30, height: 30, borderRadius: 7, display: 'grid', placeItems: 'center',
            color: '#fff', background: 'linear-gradient(135deg,#EF233C,#b5122b)',
          }}><Layers3 size={16} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div id="section-measurement-title" style={{ color: '#f8fafc', fontSize: 13, fontWeight: 800 }}>
              {editing ? 'Update Section Measurements' : 'Save Section Measurements'}
            </div>
            <div style={{ color: '#64748b', fontSize: 10 }}>
              {selection?.annotations?.length ?? 0} measurements selected
            </div>
          </div>
          <button type="button" onClick={onCancel} disabled={saving} aria-label="Close"
            style={{ background: 'transparent', border: 0, color: '#64748b', cursor: 'pointer', padding: 4 }}>
            <X size={17} />
          </button>
        </div>

        <div style={{ padding: 16 }}>
          <div style={{
            padding: '10px 12px', borderRadius: 7, marginBottom: 15,
            color: '#94a3b8', background: 'rgba(59,130,246,.08)',
            border: '1px solid rgba(59,130,246,.18)', fontSize: 11, lineHeight: 1.55,
          }}>
            {editing
              ? 'Confirm the resized boundary. Members inside it will update, while original measurements and counted places remain unchanged.'
              : 'The original measurements remain separate and editable. This saves a reusable project-level count group only.'}
          </div>

          <label style={{ display: 'block', color: '#EF233C', fontSize: 10, fontWeight: 800, letterSpacing: '.06em', marginBottom: 6 }}>
            GROUP / SECTION NAME
          </label>
          <input
            ref={inputRef}
            value={name}
            maxLength={200}
            onChange={event => setName(event.target.value)}
            placeholder="Example: Section L4-S1"
            style={{
              width: '100%', height: 40, boxSizing: 'border-box', borderRadius: 6,
              padding: '0 11px', outline: 'none', color: '#f8fafc', background: '#0B1320',
              border: '1px solid rgba(239,35,60,.45)', fontSize: 13, fontWeight: 650,
            }}
          />

          {error && <div style={{ marginTop: 9, color: '#f87171', fontSize: 11 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
            <button type="button" onClick={onCancel} disabled={saving} style={secondaryButton}>Cancel</button>
            <button type="submit" disabled={saving || !name.trim()} style={{
              ...primaryButton,
              opacity: saving || !name.trim() ? .55 : 1,
              cursor: saving || !name.trim() ? 'not-allowed' : 'pointer',
            }}>
              {saving ? 'Saving...' : editing ? 'Update Section' : 'Save & Start Counting'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

const secondaryButton = {
  height: 34, padding: '0 16px', borderRadius: 6, cursor: 'pointer',
  color: '#94a3b8', background: 'transparent', border: '1px solid rgba(255,255,255,.12)',
  fontSize: 11, fontWeight: 700,
}

const primaryButton = {
  height: 34, padding: '0 17px', borderRadius: 6, color: '#fff',
  background: '#EF233C', border: '1px solid #EF233C', fontSize: 11, fontWeight: 800,
}
