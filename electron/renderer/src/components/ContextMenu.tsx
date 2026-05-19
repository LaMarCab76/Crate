import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - pad),
      y: Math.min(y, window.innerHeight - rect.height - pad),
    })
  }, [x, y, items])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !ref.current?.contains(target)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={event => event.preventDefault()}
    >
      {items.map(item => {
        if ('divider' in item) return <div key={item.id} className="context-menu-divider" />
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
            <span>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
