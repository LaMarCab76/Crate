import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '@renderer/components/Icon'

interface ListPrefsMenuProps {
  buttonLabel?: string
  buttonIcon?: 'filter' | 'sliders'
  // Accessible name of the popover (the glass popover has no visible title).
  menuTitle?: string
  onReset: () => void
  children: React.ReactNode
}

interface SortDirectionButtonProps {
  direction: 'asc' | 'desc'
  onToggle: () => void
  label?: string
}

interface ListPrefsOptionsProps<T extends string> {
  label: string
  // Overrides the visible label as the group's accessible name.
  ariaLabel?: string
  value: T
  options: ReadonlyArray<{ value: T, label: string }>
  onChange: (value: T) => void
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
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverId = useId()

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || rootRef.current == null) return
      if (!rootRef.current.contains(target)) setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Closing unmounts the popover; keep keyboard focus on its button
      // instead of dropping it to <body>.
      if (rootRef.current?.contains(document.activeElement)) buttonRef.current?.focus()
      setOpen(false)
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
        ref={buttonRef}
        type="button"
        className="list-prefs-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={buttonLabel}
        onClick={() => setOpen(value => !value)}
      >
        <Icon name={buttonIcon} size={13} stroke={1.6} />
        {buttonLabel}
      </button>
      {open && (
        // Non-modal popover of mixed form controls (radio rows, switches,
        // inputs), so it is a dialog rather than an ARIA menu.
        <div className="list-prefs-menu" id={popoverId} role="dialog" aria-label={menuTitle}>
          <div className="list-prefs-content">
            {children}
          </div>
          <div className="list-prefs-actions">
            <button type="button" className="list-prefs-reset" onClick={reset}>Restablecer</button>
          </div>
        </div>
      )}
    </div>
  )
}

// Single-choice list for the popover ("Ordenar por"): one row per option, the
// active one marked with a check. It behaves like a native radio group (and
// like the <select> it replaced): one Tab stop on the checked row, and the
// arrow keys / Home / End move focus and select.
export function ListPrefsOptions<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: ListPrefsOptionsProps<T>) {
  const labelId = useId()
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const checkedIndex = options.findIndex(option => option.value === value)
  const tabStopIndex = checkedIndex >= 0 ? checkedIndex : 0

  const onOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1
    let next: number
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = index === last ? 0 : index + 1
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        next = index === 0 ? last : index - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = last
        break
      default:
        return
    }
    event.preventDefault()
    optionRefs.current[next]?.focus()
    if (options[next].value !== value) onChange(options[next].value)
  }

  return (
    <div
      className="list-prefs-group"
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : labelId}
    >
      <div className="list-prefs-label" id={labelId}>{label}</div>
      {options.map((option, index) => {
        const active = index === checkedIndex
        return (
          <button
            key={option.value}
            ref={element => { optionRefs.current[index] = element }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={index === tabStopIndex ? 0 : -1}
            className={`list-prefs-option${active ? ' active' : ''}`}
            onClick={() => onChange(option.value)}
            onKeyDown={event => onOptionKeyDown(event, index)}
          >
            <span className="list-prefs-check" aria-hidden>
              {active && <Icon name="check" size={14} stroke={2} />}
            </span>
            <span className="list-prefs-option-label">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function ListPrefsDivider() {
  return <div className="list-prefs-divider" role="separator" />
}

// "Orden" row: the current direction on the right with a chevron that flips.
// Inside a legacy .list-prefs-row-inline (next to a <select>) it collapses to
// a compact pill and the "Orden" caption is hidden.
export function SortDirectionButton({
  direction,
  onToggle,
  label = direction === 'asc' ? 'Ascendente' : 'Descendente',
}: SortDirectionButtonProps) {
  const nextLabel = direction === 'asc' ? 'descendente' : 'ascendente'

  return (
    <button
      type="button"
      className={`list-sort-dir-btn ${direction}`}
      onClick={onToggle}
      title={`Cambiar a orden ${nextLabel}`}
      aria-label={`Orden ${label}`}
    >
      <span className="list-sort-dir-caption">Orden</span>
      <span className="list-sort-dir-value">
        {label}
        <Icon name="chevronDown" size={11} stroke={2} className="list-sort-dir-chev" />
      </span>
    </button>
  )
}
