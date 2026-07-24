import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react'
import { Icon } from './Icon'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const modalStack: HTMLElement[] = []

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}

function isolateBackground(backdrop: HTMLElement): () => void {
  const restored: Array<{ element: HTMLElement; inert: string | null; ariaHidden: string | null }> = []
  let branch: HTMLElement | null = backdrop
  while (branch?.parentElement) {
    const parent: HTMLElement | null = branch.parentElement
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue
      restored.push({
        element: sibling,
        inert: sibling.getAttribute('inert'),
        ariaHidden: sibling.getAttribute('aria-hidden'),
      })
      sibling.setAttribute('inert', '')
      sibling.setAttribute('aria-hidden', 'true')
    }
    if (parent.id === 'root') break
    branch = parent
  }
  return () => {
    for (const item of restored) {
      if (item.inert == null) item.element.removeAttribute('inert')
      else item.element.setAttribute('inert', item.inert)
      if (item.ariaHidden == null) item.element.removeAttribute('aria-hidden')
      else item.element.setAttribute('aria-hidden', item.ariaHidden)
    }
  }
}

// Shared modal chrome (backdrop + panel + head/body/foot). Mirrors the private
// shell in MediaActions.tsx so lyrics dialogs match the rest of the app.
export function ModalShell({
  title,
  children,
  footer,
  onClose,
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
}) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const backdrop = backdropRef.current
    const panel = panelRef.current
    if (!backdrop || !panel) return
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    modalStack.push(panel)
    const restoreBackground = isolateBackground(backdrop)
    const focusFirst = () => (focusableElements(panel)[0] ?? panel).focus()
    focusFirst()
    const keepFocusInside = (event: FocusEvent) => {
      if (modalStack.at(-1) !== panel) return
      if (event.target instanceof Node && !panel.contains(event.target)) focusFirst()
    }
    document.addEventListener('focusin', keepFocusInside)
    return () => {
      document.removeEventListener('focusin', keepFocusInside)
      const index = modalStack.lastIndexOf(panel)
      if (index >= 0) modalStack.splice(index, 1)
      restoreBackground()
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current
    if (!panel || modalStack.at(-1) !== panel) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const elements = focusableElements(panel)
    if (elements.length === 0) {
      event.preventDefault()
      panel.focus()
      return
    }
    const first = elements[0]
    const last = elements[elements.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div ref={backdropRef} className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="tb-icon-btn"
            onClick={onClose}
            title="Cerrar"
            aria-label={`Cerrar ${title}`}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
