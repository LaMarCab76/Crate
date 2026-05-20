import { useEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/components/Icon'

interface ListPrefsMenuProps {
  buttonLabel?: string
  buttonIcon?: 'filter' | 'sliders'
  menuTitle?: string
  onReset: () => void
  children: React.ReactNode
}

export function ListPrefsMenu({
  buttonLabel = 'Filtro',
  buttonIcon = 'filter',
  menuTitle = 'Filtros y orden',
  onReset,
  children,
}: ListPrefsMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || rootRef.current == null) return
      if (!rootRef.current.contains(target)) setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const reset = () => {
    onReset()
  }

  return (
    <div className="list-prefs-wrap" ref={rootRef}>
      <button
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        onClick={() => setOpen(value => !value)}
      >
        <Icon name={buttonIcon} size={13} />
        {buttonLabel}
      </button>
      {open && (
        <div className="list-prefs-menu" role="menu">
          <div className="list-prefs-title">{menuTitle}</div>
          <div className="list-prefs-content">
            {children}
          </div>
          <div className="list-prefs-actions">
            <button className="btn sm" onClick={reset}>Restablecer</button>
          </div>
        </div>
      )}
    </div>
  )
}

