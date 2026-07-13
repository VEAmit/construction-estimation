import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GripHorizontal,
  GripVertical,
  PanelLeft,
  PanelRight,
  Pin,
  PinOff,
} from 'lucide-react'

const RAIL_WIDTH = 34
const EASE = '220ms cubic-bezier(0.4,0,0.2,1)'

function beginPointerResize(event, { axis, value, min, max, direction = 1, onChange, onEnd }) {
  event.preventDefault()
  event.stopPropagation()

  const start = axis === 'x' ? event.clientX : event.clientY
  let latest = start
  let frame = null
  const previousCursor = document.body.style.cursor
  const previousSelect = document.body.style.userSelect

  document.body.style.cursor = axis === 'x' ? 'ew-resize' : 'ns-resize'
  document.body.style.userSelect = 'none'

  const apply = () => {
    frame = null
    const delta = (latest - start) * direction
    onChange(Math.max(min, Math.min(max, Math.round(value + delta))))
  }

  const move = (moveEvent) => {
    latest = axis === 'x' ? moveEvent.clientX : moveEvent.clientY
    if (frame == null) frame = requestAnimationFrame(apply)
  }

  const stop = () => {
    if (frame != null) {
      cancelAnimationFrame(frame)
      apply()
    }
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousSelect
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    onEnd?.()
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}

function IconButton({ title, active = false, onClick, children }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        padding: 0,
        borderRadius: 4,
        border: `1px solid ${active ? 'rgba(239,35,60,.35)' : 'transparent'}`,
        background: active ? 'rgba(239,35,60,.12)' : 'transparent',
        color: active ? '#EF233C' : '#64748b',
        cursor: 'pointer',
        transition: 'color .15s, background .15s, border-color .15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = '#EF233C'
        e.currentTarget.style.background = 'rgba(239,35,60,.10)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active ? '#EF233C' : '#64748b'
        e.currentTarget.style.background = active ? 'rgba(239,35,60,.12)' : 'transparent'
      }}
    >
      {children}
    </button>
  )
}

function DockHeader({ title, side, pinned, onPinnedChange, onCollapse }) {
  const CollapseIcon = side === 'right' ? ChevronRight : ChevronLeft
  return (
    <div style={{
      height: 38,
      padding: '0 6px 0 10px',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexShrink: 0,
      background: '#0D1526',
      borderBottom: '1px solid rgba(255,255,255,.07)',
    }}>
      <span style={{
        minWidth: 0,
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: '#94a3b8',
        fontSize: 10,
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: '.08em',
      }}>
        {title}
      </span>
      <IconButton
        title={pinned ? 'Unpin panel (auto hide)' : 'Pin panel open'}
        active={pinned}
        onClick={() => onPinnedChange(!pinned)}
      >
        {pinned ? <Pin size={14} /> : <PinOff size={14} />}
      </IconButton>
      <IconButton title="Collapse panel" onClick={onCollapse}>
        <CollapseIcon size={15} />
      </IconButton>
    </div>
  )
}

function DockTabs({ tabs, activeTab, onTabChange }) {
  return (
    <div style={{
      minHeight: 36,
      display: 'flex',
      alignItems: 'stretch',
      flexShrink: 0,
      overflowX: 'auto',
      background: '#0B1320',
      borderBottom: '1px solid rgba(255,255,255,.07)',
    }}>
      {tabs.map(({ id, label, icon: TabIcon, badge }) => {
        const active = id === activeTab
        return (
          <button
            type="button"
            key={id}
            title={label}
            onClick={() => onTabChange(id)}
            style={{
              minWidth: 0,
              flex: 1,
              padding: '0 8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              color: active ? '#EF233C' : '#64748b',
              background: active ? 'rgba(239,35,60,.07)' : 'transparent',
              border: 'none',
              borderBottom: active ? '2px solid #EF233C' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: active ? 700 : 500,
              whiteSpace: 'nowrap',
            }}
          >
            <TabIcon size={14} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
            {badge > 0 && (
              <span style={{
                minWidth: 17,
                height: 17,
                padding: '0 4px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 9,
                background: active ? '#EF233C' : 'rgba(255,255,255,.08)',
                color: '#fff',
                fontSize: 9,
                fontWeight: 800,
              }}>
                {badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function DockRail({ side, tabs, activeTab, pinned, onActivate }) {
  const PanelIcon = side === 'right' ? PanelRight : PanelLeft
  const railTabs = tabs?.length ? tabs : [{ id: 'panel', label: 'Open panel', icon: PanelIcon }]
  return (
    <div style={{
      width: RAIL_WIDTH,
      flex: `0 0 ${RAIL_WIDTH}px`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      paddingTop: 5,
      background: '#0D1526',
      borderLeft: side === 'right' ? '1px solid rgba(255,255,255,.07)' : 'none',
      borderRight: side === 'left' ? '1px solid rgba(255,255,255,.07)' : 'none',
    }}>
      {railTabs.map(({ id, label, icon: RailIcon = PanelIcon }) => (
        <IconButton
          key={id}
          title={label}
          active={id === activeTab}
          onClick={() => onActivate(id)}
        >
          <RailIcon size={15} />
        </IconButton>
      ))}
      <div style={{ flex: 1 }} />
      <div
        title={pinned ? 'Panel pinned' : 'Panel auto hides'}
        style={{ color: pinned ? '#EF233C' : '#475569', paddingBottom: 8 }}
      >
        {pinned ? <Pin size={12} /> : <PinOff size={12} />}
      </div>
    </div>
  )
}

export function SideDock({
  side = 'left',
  title,
  width,
  minWidth,
  maxWidth,
  open,
  pinned,
  hovered,
  resizing = false,
  tabs = [],
  activeTab,
  onOpenChange,
  onPinnedChange,
  onHoveredChange,
  onActiveTabChange,
  onWidthChange,
  onResizeStart,
  onResizeEnd,
  children,
}) {
  const visible = pinned ? open : hovered
  const panelWidth = Math.max(0, width - RAIL_WIDTH)
  const content = (
    <div style={{
      width: panelWidth,
      flex: `0 0 ${panelWidth}px`,
      minWidth: 0,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: '#0B1320',
    }}>
      <DockHeader
        title={title}
        side={side}
        pinned={pinned}
        onPinnedChange={onPinnedChange}
        onCollapse={() => {
          onOpenChange(false)
          onHoveredChange(false)
        }}
      />
      {tabs.length > 0 && (
        <DockTabs tabs={tabs} activeTab={activeTab} onTabChange={onActiveTabChange} />
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{children}</div>
    </div>
  )

  return (
    <div
      data-bt-dock={side}
      data-bt-dock-open={visible ? 'true' : 'false'}
      onPointerEnter={() => onHoveredChange(true)}
      onPointerLeave={() => onHoveredChange(false)}
      style={{
        position: 'relative',
        width: visible ? width : RAIL_WIDTH,
        flex: `0 0 ${visible ? width : RAIL_WIDTH}px`,
        minWidth: 0,
        height: '100%',
        display: 'flex',
        overflow: 'hidden',
        background: '#0B1320',
        transition: resizing ? 'none' : `width ${EASE}, flex-basis ${EASE}`,
        willChange: 'width, flex-basis',
      }}
    >
      {side === 'left' ? (
        <>
          <DockRail
            side={side}
            tabs={tabs}
            activeTab={activeTab}
            pinned={pinned}
            onActivate={(tab) => {
              onActiveTabChange?.(tab)
              onOpenChange(true)
              onHoveredChange(true)
            }}
          />
          {content}
        </>
      ) : (
        <>
          <DockRail
            side={side}
            tabs={tabs}
            activeTab={activeTab}
            pinned={pinned}
            onActivate={() => {
              onOpenChange(true)
              onHoveredChange(true)
            }}
          />
          {content}
        </>
      )}

      {visible && (
        <div
          role="separator"
          aria-orientation="vertical"
          title={`Resize ${side} panel`}
          onPointerDown={(event) => {
            onResizeStart?.()
            beginPointerResize(event, {
              axis: 'x',
              value: width,
              min: minWidth,
              max: maxWidth,
              direction: side === 'left' ? 1 : -1,
              onChange: onWidthChange,
              onEnd: onResizeEnd,
            })
          }}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            [side === 'left' ? 'right' : 'left']: 0,
            width: 7,
            zIndex: 5,
            cursor: 'ew-resize',
            touchAction: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(239,35,60,.25)',
          }}
        >
          <GripVertical size={12} />
        </div>
      )}
    </div>
  )
}

export function BottomDock({
  height,
  minHeight,
  maxHeight,
  open,
  pinned,
  hovered,
  resizing = false,
  count = 0,
  summary,
  onOpenChange,
  onPinnedChange,
  onHoveredChange,
  onHeightChange,
  onResizeStart,
  onResizeEnd,
  children,
}) {
  const visible = pinned ? open : hovered
  return (
    <div
      data-bt-dock="bottom"
      data-bt-dock-open={visible ? 'true' : 'false'}
      onPointerEnter={() => onHoveredChange(true)}
      onPointerLeave={() => onHoveredChange(false)}
      style={{
        position: 'relative',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#080B12',
        borderTop: '1px solid rgba(239,35,60,.28)',
      }}
    >
      {visible && (
        <div
          role="separator"
          aria-orientation="horizontal"
          title="Resize measurements panel"
          onPointerDown={(event) => {
            onResizeStart?.()
            beginPointerResize(event, {
              axis: 'y',
              value: height,
              min: minHeight,
              max: maxHeight,
              direction: -1,
              onChange: onHeightChange,
              onEnd: onResizeEnd,
            })
          }}
          style={{
            position: 'absolute',
            top: -5,
            left: 0,
            right: 0,
            height: 10,
            zIndex: 6,
            cursor: 'ns-resize',
            touchAction: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(239,35,60,.32)',
          }}
        >
          <GripHorizontal size={18} />
        </div>
      )}

      <div style={{
        height: 38,
        minHeight: 38,
        padding: '0 6px 0 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: '#0D1526',
        borderBottom: visible ? '1px solid rgba(255,255,255,.07)' : 'none',
      }}>
        <button
          type="button"
          onClick={() => {
            if (!pinned) {
              onPinnedChange(true)
              onOpenChange(true)
            } else {
              onOpenChange(!open)
            }
          }}
          style={{
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: 0,
            color: visible ? '#EF233C' : '#94a3b8',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          <span style={{ width: 2, height: 15, borderRadius: 1, background: '#EF233C' }} />
          Measurements
          {count > 0 && (
            <span style={{
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 9,
              color: '#fff',
              background: '#EF233C',
              fontSize: 9,
              fontWeight: 800,
            }}>
              {count}
            </span>
          )}
        </button>
        <div style={{ flex: 1 }} />
        {summary && <div style={{ color: '#475569', fontSize: 10, whiteSpace: 'nowrap' }}>{summary}</div>}
        <IconButton
          title={pinned ? 'Unpin panel (auto hide)' : 'Pin panel open'}
          active={pinned}
          onClick={() => {
            onPinnedChange(!pinned)
            if (!pinned) onOpenChange(true)
          }}
        >
          {pinned ? <Pin size={14} /> : <PinOff size={14} />}
        </IconButton>
        <IconButton
          title={visible ? 'Collapse measurements' : 'Expand measurements'}
          onClick={() => {
            if (!pinned) {
              onPinnedChange(true)
              onOpenChange(true)
            } else {
              onOpenChange(!open)
            }
          }}
        >
          {visible ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </IconButton>
      </div>

      <div style={{
        height: visible ? height : 0,
        overflow: 'hidden',
        transition: resizing ? 'none' : `height ${EASE}`,
        willChange: 'height',
      }}>
        <div style={{ height, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {children}
        </div>
      </div>
    </div>
  )
}
