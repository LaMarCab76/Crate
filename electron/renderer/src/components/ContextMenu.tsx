import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

export interface ContextMenuAction {
  id: string
  label: string
  icon?: IconName
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export interface ContextMenuDivider {
  id: string
  divider: true
}

export type ContextMenuItem = ContextMenuAction | ContextMenuDivider

// Optional identity row above the actions (cover + title + subtitle).
export interface ContextMenuHeader {
  title: string
  subtitle?: string
  art?: ReactNode
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  header?: ContextMenuHeader
  onClose: () => void
}

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End'])

export function ContextMenu({ x, y, items, header, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // offsetWidth/offsetHeight ignore the open animation's scale.
    const pad = 8
    const next = {
      x: Math.max(pad, Math.min(x, window.innerWidth - el.offsetWidth - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - el.offsetHeight - pad)),
    }
    setPos(prev => (prev.x === next.x && prev.y === next.y ? prev : next))
  }, [x, y, items, header])

  // Arrow-key navigation moves focus into the menu; hand it back on close.
  // Layout effect so the cleanup runs before the menu's DOM is removed.
  useLayoutEffect(() => {
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const menu = ref.current
    return () => {
      if (menu?.contains(document.activeElement) && restoreFocus?.isConnected) restoreFocus.focus()
    }
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !ref.current?.contains(target)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (!NAV_KEYS.has(event.key) || !ref.current) return
      // Arrow keys walk the enabled actions, like a native menu.
      const actions = Array.from(ref.current.querySelectorAll<HTMLButtonElement>('.context-menu-item:not(:disabled)'))
      if (actions.length === 0) return
      event.preventDefault()
      const current = actions.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? actions.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % actions.length
        : current <= 0 ? actions.length - 1 : current - 1
      actions[next].focus()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  // Portaled so the floating glass cards (transformed / backdrop-filtered
  // ancestors) can't become the containing block of the fixed menu.
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={header?.title}
      style={{
        left: pos.x,
        top: pos.y,
        transformOrigin: `${pos.x < x ? 'right' : 'left'} ${pos.y < y ? 'bottom' : 'top'}`,
      }}
      onContextMenu={event => event.preventDefault()}
    >
      {header && (
        <>
          <div className="context-menu-header" aria-hidden="true">
            {header.art && <span className="context-menu-art">{header.art}</span>}
            <span className="context-menu-heading">
              <strong>{header.title}</strong>
              {header.subtitle && <span>{header.subtitle}</span>}
            </span>
          </div>
          <div className="context-menu-divider" role="separator" />
        </>
      )}
      {items.map(item => {
        if ('divider' in item) return <div key={item.id} className="context-menu-divider" role="separator" />
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`context-menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onSelect()
            }}
          >
            <span className="context-menu-icon">
              {item.icon && <Icon name={item.icon} size={14} />}
            </span>
            <span className="context-menu-label">{item.label}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
