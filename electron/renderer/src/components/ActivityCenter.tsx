import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  activityActionIdsFor,
  isActiveActivityStatus,
  primaryActivityActionIdFor,
  type ActivityActionId,
  type ActivityCategory,
  type ActivityItem,
  type ActivityStatus,
} from '@renderer/stores/activityCenterStore'
import { Icon, type IconName } from './Icon'

interface ActivityCenterProps {
  open: boolean
  pinned: boolean
  fullscreen: boolean
  items: ActivityItem[]
  onClose: () => void
  onTogglePinned: () => void
  onToggleFullscreen: () => void
  onMarkAllRead: () => void
  onClearResolved: () => void
  onAction: (actionId: ActivityActionId, item: ActivityItem) => void
}

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  devices: 'Dispositivos',
  lyrics: 'Letras',
  library: 'Biblioteca',
  duplicates: 'Duplicados',
  downloads: 'Descargas',
  updates: 'Updates',
}

const CATEGORY_ICONS: Record<ActivityCategory, IconName> = {
  devices: 'device',
  lyrics: 'lyrics',
  library: 'folder',
  duplicates: 'duplicate',
  downloads: 'download',
  updates: 'sync',
}

const STATUS_LABELS: Record<ActivityStatus, string> = {
  queued: 'En cola',
  running: 'En curso',
  waiting: 'Esperando',
  success: 'Listo',
  warning: 'Atención',
  error: 'Error',
  info: 'Info',
}

const ACTION_LABELS: Record<ActivityActionId, { label: string; icon: IconName }> = {
  'open-device': { label: 'Abrir', icon: 'device' },
  'open-device-sync': { label: 'Sync', icon: 'sync' },
  'open-libraries': { label: 'Bibliotecas', icon: 'folder' },
  'connect-device': { label: 'MP3', icon: 'device' },
  'add-library': { label: 'Biblioteca', icon: 'folder' },
  'ignore-volume': { label: 'Ignorar', icon: 'close' },
  'open-lyrics-settings': { label: 'Letras', icon: 'lyrics' },
  'open-downloads': { label: 'Descargas', icon: 'download' },
  'open-import': { label: 'Fuentes', icon: 'folder' },
  'open-updates': { label: 'Updates', icon: 'sync' },
  'open-duplicates': { label: 'Revisar', icon: 'duplicate' },
}

function formatActivityTime(value: number): string {
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function statusClass(status: ActivityStatus): string {
  if (status === 'running' || status === 'queued' || status === 'waiting') return 'active'
  if (status === 'success') return 'done'
  if (status === 'error') return 'failed'
  if (status === 'warning') return 'warn'
  return 'info'
}

function ActivityRow({
  item,
  onAction,
}: {
  item: ActivityItem
  onAction: (actionId: ActivityActionId, item: ActivityItem) => void
}) {
  const actions = activityActionIdsFor(item)
  const active = isActiveActivityStatus(item.status)
  const progress = item.progress
  const progressStyle = progress?.percent != null ? { width: `${progress.percent}%` } : undefined
  const primaryActionId = primaryActivityActionIdFor(item)
  const openPrimaryAction = () => {
    if (primaryActionId) onAction(primaryActionId, item)
  }
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!primaryActionId || event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openPrimaryAction()
  }

  return (
    <div
      className={`activity-center-row ${primaryActionId ? 'actionable' : ''} ${statusClass(item.status)} ${item.read ? 'read' : 'unread'}`}
      role={primaryActionId ? 'button' : undefined}
      tabIndex={primaryActionId ? 0 : undefined}
      aria-label={primaryActionId ? `Abrir actividad: ${item.title}` : undefined}
      onClick={openPrimaryAction}
      onKeyDown={onRowKeyDown}
    >
      <div className="activity-center-row-icon">
        <Icon
          name={active ? 'loader' : CATEGORY_ICONS[item.category]}
          size={15}
          className={active ? 'activity-center-loader' : undefined}
        />
      </div>
      <div className="activity-center-row-main">
        <div className="activity-center-row-top">
          <span>{CATEGORY_LABELS[item.category]}</span>
          <em>{formatActivityTime(item.updatedAt)}</em>
        </div>
        <strong>{item.title}</strong>
        {item.detail && <p title={item.detail}>{item.detail}</p>}
        {progress && item.status !== 'success' && (
          <div className={`activity-center-progress ${progress.percent == null && active ? 'indeterminate' : ''}`}>
            <div aria-hidden="true">
              <i style={progressStyle} />
            </div>
            <span>{progress.label}</span>
          </div>
        )}
        {actions.length > 0 && (
          <div className="activity-center-actions">
            {actions.map(actionId => {
              const action = ACTION_LABELS[actionId]
              return (
                <button
                  key={actionId}
                  className="btn"
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    onAction(actionId, item)
                  }}
                  title={action.label}
                >
                  <Icon name={action.icon} size={12} />
                  {action.label}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <span className={`activity-center-status ${statusClass(item.status)}`}>
        {item.status === 'success' && <Icon name="check" size={11} stroke={2.2} />}
        <span>{STATUS_LABELS[item.status]}</span>
      </span>
    </div>
  )
}

export function ActivityCenter({
  open,
  pinned,
  fullscreen,
  items,
  onClose,
  onTogglePinned,
  onToggleFullscreen,
  onMarkAllRead,
  onClearResolved,
  onAction,
}: ActivityCenterProps) {
  const activeCount = items.filter(item => isActiveActivityStatus(item.status)).length
  const unreadCount = items.filter(item => !item.read).length

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pinned) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, pinned, onClose])

  if (!open) return null

  const rootStyle: CSSProperties = fullscreen
    ? {
        position: 'fixed',
        inset: 0,
        zIndex: 130,
        width: 'auto',
        maxWidth: 'none',
        display: 'grid',
        placeItems: 'center',
        padding: 32,
        pointerEvents: 'auto',
      }
    : {
        position: 'fixed',
        top: 60,
        right: 16,
        zIndex: 120,
        width: 430,
        maxWidth: 'calc(100vw - 32px)',
        pointerEvents: 'auto',
      }

  const panelStyle: CSSProperties = {
    position: 'relative',
    minHeight: 220,
    maxHeight: fullscreen ? 'min(760px, calc(100vh - 64px))' : 'min(620px, calc(100vh - var(--tb-h) - 28px))',
    width: fullscreen ? 'min(880px, 100%)' : undefined,
    display: 'grid',
    gridTemplateRows: 'auto auto minmax(0, 1fr)',
    overflow: 'hidden',
    border: '0.5px solid rgba(255,255,255,0.12)',
    borderRadius: 8,
    background: 'var(--bg-panel)',
    boxShadow: '0 20px 70px rgba(0,0,0,0.38), 0 0 0 0.5px rgba(255,255,255,0.05)',
    color: 'var(--text-primary)',
    pointerEvents: 'auto',
  }

  const panel = (
    <div className={`activity-center ${fullscreen ? 'fullscreen' : ''} ${pinned ? 'pinned' : ''}`} style={rootStyle}>
      {fullscreen && <button className="activity-center-scrim" type="button" aria-label="Cerrar actividad" onClick={onClose} />}
      <section className="activity-center-panel" style={panelStyle} aria-label="Centro de actividad">
        <header className="activity-center-head">
          <div>
            <h2>Actividad</h2>
            <span>{activeCount > 0 ? `${activeCount} en curso` : `${items.length} recientes`}</span>
          </div>
          <div className="activity-center-tools">
            {unreadCount > 0 && (
              <button className="tb-icon-btn" type="button" title="Marcar leído" onClick={onMarkAllRead}>
                <Icon name="check" size={14} />
              </button>
            )}
            <button
              className={`tb-icon-btn ${pinned ? 'active' : ''}`}
              type="button"
              title={pinned ? 'Desanclar' : 'Anclar'}
              aria-pressed={pinned}
              onClick={onTogglePinned}
            >
              <Icon name="pin" size={14} />
            </button>
            <button
              className={`tb-icon-btn ${fullscreen ? 'active' : ''}`}
              type="button"
              title={fullscreen ? 'Panel compacto' : 'Pantalla completa'}
              aria-pressed={fullscreen}
              onClick={onToggleFullscreen}
            >
              <Icon name={fullscreen ? 'contract' : 'expand'} size={14} />
            </button>
            <button className="tb-icon-btn" type="button" title="Cerrar" onClick={onClose}>
              <Icon name="close" size={14} />
            </button>
          </div>
        </header>

        <div className="activity-center-summary">
          <span>{unreadCount > 0 ? `${unreadCount} sin leer` : 'Al día'}</span>
          <button className="btn ghost" type="button" onClick={onClearResolved}>
            Limpiar resueltos
          </button>
        </div>

        <div className="activity-center-list">
          {items.length === 0 ? (
            <div className="activity-center-empty">
              <Icon name="activity" size={18} />
              <strong>Sin actividad reciente</strong>
            </div>
          ) : (
            items.map(item => (
              <ActivityRow key={item.id} item={item} onAction={onAction} />
            ))
          )}
        </div>
      </section>
    </div>
  )

  if (typeof document === 'undefined') return panel
  return createPortal(panel, document.body)
}
