import { type ReactNode } from 'react'
import { Icon } from './Icon'

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
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="tb-icon-btn" onClick={onClose} title="Cerrar">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
