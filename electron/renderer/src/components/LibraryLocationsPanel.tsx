import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { ModalShell } from './ModalShell'
import {
  useLibraryLocationsStore,
  type LibraryLocation,
  type LibraryProvider,
  type LibraryRole,
  type OneDriveFolderEntry,
} from '../stores/libraryLocationsStore'
import {
  useBackupStore,
  type BackupPlanSummary,
  type BackupRunStatus,
  type LibraryBackupState,
} from '../stores/backupStore'
import { useMigrationStore } from '../stores/migrationStore'
import type { LibraryMigrationState } from '@shared/types/library-locations'
import {
  LibraryMigrationWizard,
  MigrationReviewDialog,
} from './LibraryMigrationWizard'
import {
  LocationPresentationDialog,
  SourceDisplaySettings,
} from './SourceDisplaySettings'

interface LibraryLocationPickerProps {
  role: LibraryRole
  source?: LibraryLocation | null
  initialProvider?: LibraryProvider
  onCreated: (location: LibraryLocation) => void | Promise<void>
}

interface RemoteLevel {
  driveId: string | null
  itemId: string | null
  name: string
}

const BACKUP_STATUS_LABELS: Record<BackupRunStatus, string> = {
  idle: 'Listo para sincronizar',
  planning: 'Comparando bibliotecas',
  awaiting_approval: 'Revisión pendiente',
  running: 'Sincronizando',
  paused: 'En pausa',
  completed: 'Actualizado',
  failed: 'Necesita atención',
  error: 'Necesita atención',
  offline: 'Ubicación no disponible',
}

const PLAN_ACTION_LABELS: Record<BackupPlanSummary['entries'][number]['action'], string> = {
  create: 'Crear',
  update: 'Actualizar',
  delete: 'Eliminar',
  conflict: 'Divergencia',
}

const MIGRATION_STATUS_LABELS: Record<LibraryMigrationState['status'], string> = {
  planning: 'Inventariando',
  awaiting_approval: 'Preview listo',
  transferring: 'Transfiriendo',
  publishing: 'Publicando',
  committing: 'Confirmando catálogo',
  cleanup_pending: 'Limpieza pendiente',
  paused: 'En pausa',
  completed: 'Completada',
  failed: 'Interrumpida',
  cancelled: 'Cancelada',
}

function useEscapeClose(onClose: () => void): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])
}

function formatBytes(value: number | null): string | null {
  if (value == null || value < 0) return null
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = value / 1024
  let unit = units[0]
  for (let i = 1; amount >= 1024 && i < units.length; i += 1) {
    amount /= 1024
    unit = units[i]
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`
}

function formatDate(value: string | number | null): string {
  if (value == null) return 'Todavía no se ejecutó'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Sin fecha'
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function locationTitle(location: LibraryLocation): string {
  return location.name || (location.provider === 'onedrive' ? 'OneDrive' : 'Biblioteca local')
}

function providerLabel(provider: LibraryProvider): string {
  return provider === 'onedrive' ? 'OneDrive' : 'Local'
}

function roleLabel(role: LibraryRole): string {
  return role === 'backup' ? 'Backup' : 'Biblioteca'
}

function localAccessLabel(location: LibraryLocation): string {
  if (location.provider !== 'local' || !location.localAccess) {
    return location.available ? 'Disponible' : 'Sin conexión'
  }
  switch (location.localAccess.state) {
    case 'ready': return 'Acceso completo'
    case 'permission_required': return 'Necesita acceso'
    case 'unavailable': return 'Sin conexión'
    case 'read_only': return 'Solo lectura'
  }
}

function localAccessClass(location: LibraryLocation): string {
  if (location.provider !== 'local' || !location.localAccess) return location.available ? 'ready' : 'unavailable'
  return location.localAccess.state
}

export function LibraryLocationPicker({
  role,
  source = null,
  initialProvider,
  onCreated,
}: LibraryLocationPickerProps) {
  const oneDrive = useLibraryLocationsStore(state => state.oneDrive)
  const initialized = useLibraryLocationsStore(state => state.initialized)
  const busy = useLibraryLocationsStore(state => state.pickerBusy)
  const error = useLibraryLocationsStore(state => state.error)
  const load = useLibraryLocationsStore(state => state.load)
  const clearError = useLibraryLocationsStore(state => state.clearError)
  const setOneDriveClientId = useLibraryLocationsStore(state => state.setOneDriveClientId)
  const connectOneDrive = useLibraryLocationsStore(state => state.connectOneDrive)
  const listOneDriveFolders = useLibraryLocationsStore(state => state.listOneDriveFolders)
  const pickAndAddLocal = useLibraryLocationsStore(state => state.pickAndAddLocal)
  const addOneDriveFolder = useLibraryLocationsStore(state => state.addOneDriveFolder)
  const availableProviders = useMemo<LibraryProvider[]>(
    () => ['local', 'onedrive'],
    [],
  )
  const [provider, setProvider] = useState<LibraryProvider>(() => {
    if (initialProvider && availableProviders.includes(initialProvider)) return initialProvider
    return availableProviders[0]
  })
  const [clientId, setClientId] = useState('')
  const [stack, setStack] = useState<RemoteLevel[]>([
    { driveId: null, itemId: null, name: 'OneDrive' },
  ])
  const [entries, setEntries] = useState<OneDriveFolderEntry[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const focusRef = useRef<HTMLDivElement>(null)

  const current = stack[stack.length - 1]
  const options = useMemo(() => ({
    role,
    backupSourceFolderId: role === 'backup' ? source?.id ?? null : null,
  }), [role, source?.id])

  useEffect(() => {
    if (!initialized) void load()
  }, [initialized, load])

  useEffect(() => {
    if (!availableProviders.includes(provider)) setProvider(availableProviders[0])
  }, [availableProviders, provider])

  useEffect(() => {
    focusRef.current?.focus()
  }, [])

  const refreshRemote = useCallback(async (level: RemoteLevel) => {
    setRemoteLoading(true)
    const next = await listOneDriveFolders(level.driveId, level.itemId)
    setEntries(next)
    setRemoteLoading(false)
  }, [listOneDriveFolders])

  useEffect(() => {
    if (provider !== 'onedrive' || oneDrive?.connected !== true) return
    void refreshRemote(current)
  }, [provider, oneDrive?.connected, current, refreshRemote])

  const chooseProvider = (next: LibraryProvider) => {
    clearError()
    setProvider(next)
  }

  const chooseLocal = async () => {
    const location = await pickAndAddLocal(options)
    if (location) await onCreated(location)
  }

  const chooseOneDrive = async (entry: OneDriveFolderEntry) => {
    const location = await addOneDriveFolder(entry, options)
    if (location) await onCreated(location)
  }

  const configureClientId = async () => {
    const value = clientId.trim()
    if (!value) return
    const configured = await setOneDriveClientId(value)
    if (configured) setClientId('')
  }

  const connect = async () => {
    const connected = await connectOneDrive()
    if (connected) {
      setStack([{ driveId: null, itemId: null, name: 'OneDrive' }])
    }
  }

  const drillInto = (entry: OneDriveFolderEntry) => {
    setStack(previous => [...previous, {
      driveId: entry.driveId,
      itemId: entry.itemId,
      name: entry.name,
    }])
  }

  const jumpTo = (index: number) => {
    setStack(previous => previous.slice(0, index + 1))
  }

  return (
    <div className="loc-picker" ref={focusRef} tabIndex={-1}>
      <div className="loc-provider-choice" role="group" aria-label="Tipo de ubicación">
        {availableProviders.map(item => (
          <button
            className={`loc-provider-option ${provider === item ? 'selected' : ''}`}
            type="button"
            key={item}
            aria-pressed={provider === item}
            onClick={() => chooseProvider(item)}
          >
            <span className={`loc-provider-icon ${item}`} aria-hidden="true">
              <Icon name={item === 'onedrive' ? 'cloud' : 'folder'} size={18} />
            </span>
            <span>
              <strong>{item === 'onedrive' ? 'OneDrive personal' : 'Carpeta de este equipo'}</strong>
              <small>
                {item === 'onedrive'
                  ? 'Se indexa como cualquier otra biblioteca.'
                  : 'Crate conserva la autorización sin exponer la ruta.'}
              </small>
            </span>
            <Icon name="check" size={14} className="loc-provider-check" />
          </button>
        ))}
      </div>

      {role === 'backup' && source && (
        <div className="loc-picker-context">
          <Icon name="sync" size={14} />
          Esta ubicación será el espejo de <strong>{locationTitle(source)}</strong>.
        </div>
      )}

      {error && (
        <div className="loc-inline-error" role="alert">
          <Icon name="info" size={14} />
          <span>{error}</span>
          <button type="button" className="btn ghost sm" onClick={clearError}>Cerrar</button>
        </div>
      )}

      {provider === 'local' ? (
        <div className="loc-picker-action">
          <div>
            <strong>{role === 'backup' ? 'Elegí una carpeta exclusiva para el espejo' : 'Elegí la raíz de tu música'}</strong>
            <p>
              {role === 'backup'
                ? 'Puede estar vacía. Si ya tiene contenido, Crate pedirá revisar el primer plan antes de modificarla.'
                : 'Las subcarpetas y formatos compatibles se incorporarán al catálogo unificado.'}
            </p>
          </div>
          <button className="btn primary" type="button" disabled={busy} onClick={() => { void chooseLocal() }}>
            <Icon name="folder" size={13} /> {busy ? 'Abriendo…' : 'Elegir carpeta'}
          </button>
        </div>
      ) : oneDrive?.clientIdConfigured === false ? (
        <div className="loc-cloud-connect">
          <div className="loc-cloud-mark" aria-hidden="true"><Icon name="cloud" size={24} /></div>
          <div className="loc-cloud-copy">
            <strong>Configurá la aplicación de Microsoft</strong>
            <p>Ingresá el Application (client) ID de una app pública con permisos Files.ReadWrite, User.Read y offline_access.</p>
            <label className="loc-client-id-field">
              <span>Application (client) ID</span>
              <span className="loc-client-id-control">
                <input
                  className="settings-input"
                  type="text"
                  value={clientId}
                  autoComplete="off"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  onChange={event => setClientId(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void configureClientId()
                  }}
                />
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy || clientId.trim().length === 0}
                  onClick={() => { void configureClientId() }}
                >
                  Guardar
                </button>
              </span>
            </label>
          </div>
        </div>
      ) : oneDrive?.connected !== true ? (
        <div className="loc-cloud-connect">
          <div className="loc-cloud-mark" aria-hidden="true"><Icon name="cloud" size={24} /></div>
          <div className="loc-cloud-copy">
            <strong>Conectá tu OneDrive personal</strong>
            <p>La sesión se abre con Microsoft y las credenciales quedan protegidas por el sistema.</p>
          </div>
          <button className="btn primary" type="button" disabled={busy} onClick={() => { void connect() }}>
            {busy ? 'Conectando…' : 'Conectar OneDrive'}
          </button>
        </div>
      ) : (
        <div className="loc-remote-browser">
          <div className="loc-remote-head">
            <div>
              <strong>{oneDrive.displayName ?? 'Cuenta conectada'}</strong>
              <small>{oneDrive.email ?? 'OneDrive personal'}</small>
            </div>
            <button
              className="btn ghost sm"
              type="button"
              disabled={remoteLoading || busy}
              onClick={() => { void refreshRemote(current) }}
            >
              <Icon name="rotate" size={12} /> Actualizar
            </button>
          </div>
          <nav className="loc-breadcrumbs" aria-label="Ruta en OneDrive">
            {stack.map((level, index) => (
              <span key={`${level.itemId ?? 'root'}-${index}`}>
                {index > 0 && <Icon name="chevR" size={10} />}
                <button type="button" onClick={() => jumpTo(index)} aria-current={index === stack.length - 1 ? 'location' : undefined}>
                  {level.name}
                </button>
              </span>
            ))}
          </nav>
          <div className="loc-remote-list" aria-busy={remoteLoading}>
            {remoteLoading ? (
              <div className="loc-picker-empty"><Icon name="loader" size={15} className="loc-spin" /> Cargando carpetas…</div>
            ) : entries.length === 0 ? (
              <div className="loc-picker-empty">No hay subcarpetas en esta ubicación.</div>
            ) : entries.map(entry => (
              <div className="loc-remote-row" key={`${entry.driveId}-${entry.itemId}`}>
                <button className="loc-remote-open" type="button" onClick={() => drillInto(entry)}>
                  <Icon name="folder" size={16} />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{entry.childCount == null ? 'Carpeta' : `${entry.childCount} elementos`}</small>
                  </span>
                  <Icon name="chevR" size={12} />
                </button>
                <button
                  className="btn sm"
                  type="button"
                  disabled={busy}
                  aria-label={`Elegir ${entry.name}`}
                  onClick={() => { void chooseOneDrive(entry) }}
                >
                  Elegir
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ConfirmationDialog({
  title,
  copy,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  title: string
  copy: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  useEscapeClose(onClose)
  return (
    <ModalShell
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" type="button" disabled={busy} onClick={onClose}>Cancelar</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} type="button" disabled={busy} onClick={onConfirm}>
            {busy ? 'Procesando…' : confirmLabel}
          </button>
        </>
      )}
    >
      <p className="modal-copy">{copy}</p>
    </ModalShell>
  )
}

function DiffReviewDialog({
  backup,
  onApprove,
  onClose,
  busy,
}: {
  backup: LibraryBackupState
  onApprove: () => void
  onClose: () => void
  busy: boolean
}) {
  useEscapeClose(onClose)
  const plan = backup.plan
  const totalChanges = plan ? plan.creates + plan.updates + plan.deletes : 0
  return (
    <ModalShell
      title="Revisar cambios del backup"
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" type="button" disabled={busy} onClick={onClose}>Mantener en pausa</button>
          <button className="btn primary" type="button" disabled={busy || !plan?.runId} onClick={onApprove}>
            <Icon name="check" size={13} /> {busy ? 'Aprobando…' : `Aprobar ${totalChanges} cambios`}
          </button>
        </>
      )}
    >
      <div className="loc-diff-summary" role="status">
        <span><b>{plan?.creates ?? 0}</b> altas</span>
        <span><b>{plan?.updates ?? 0}</b> cambios</span>
        <span><b>{plan?.deletes ?? 0}</b> eliminaciones</span>
        <span className="conflict"><b>{plan?.conflicts ?? 0}</b> divergencias</span>
      </div>
      <p className="modal-copy">
        El destino cambió por fuera de Crate. La fuente no será modificada; el espejo continuará solo si aprobás este lote completo.
      </p>
      <div className="loc-diff-list">
        {plan?.entries.length ? plan.entries.map((entry, index) => (
          <div className={`loc-diff-row ${entry.action}`} key={`${entry.action}-${entry.path}-${index}`}>
            <span>{PLAN_ACTION_LABELS[entry.action]}</span>
            <code>{entry.path}</code>
            {entry.reason && <small>{entry.reason}</small>}
          </div>
        )) : (
          <div className="loc-picker-empty">El plan no incluye el detalle por archivo.</div>
        )}
      </div>
    </ModalShell>
  )
}

function progressPercent(backup: LibraryBackupState): number {
  if (backup.totalBytes && backup.totalBytes > 0) {
    return Math.min(100, Math.round(backup.transferredBytes / backup.totalBytes * 100))
  }
  if (backup.totalFiles > 0) {
    return Math.min(100, Math.round(backup.completedFiles / backup.totalFiles * 100))
  }
  return backup.status === 'completed' ? 100 : 0
}

function backupDetail(backup: LibraryBackupState): string {
  if (backup.currentPath) return backup.currentPath
  if (backup.totalFiles > 0) return `${backup.completedFiles} de ${backup.totalFiles} archivos`
  if (backup.totalBytes != null) return `${formatBytes(backup.transferredBytes)} de ${formatBytes(backup.totalBytes)}`
  return formatDate(backup.lastRunAt)
}

export function LibraryLocationsPanel() {
  const locations = useLibraryLocationsStore(state => state.locations)
  const locationsLoading = useLibraryLocationsStore(state => state.loading)
  const locationsError = useLibraryLocationsStore(state => state.error)
  const loadLocations = useLibraryLocationsStore(state => state.load)
  const removeLocation = useLibraryLocationsStore(state => state.removeLocation)
  const updatePresentation = useLibraryLocationsStore(state => state.updatePresentation)
  const requestLocalAccess = useLibraryLocationsStore(state => state.requestLocalAccess)
  const openFilePrivacySettings = useLibraryLocationsStore(state => state.openFilePrivacySettings)
  const locationPickerBusy = useLibraryLocationsStore(state => state.pickerBusy)
  const backups = useBackupStore(state => state.backups)
  const backupsLoading = useBackupStore(state => state.loading)
  const backupError = useBackupStore(state => state.error)
  const busyFolderId = useBackupStore(state => state.busyFolderId)
  const busyAction = useBackupStore(state => state.busyAction)
  const loadBackups = useBackupStore(state => state.load)
  const assignBackup = useBackupStore(state => state.assign)
  const unlinkBackup = useBackupStore(state => state.unlink)
  const promoteBackup = useBackupStore(state => state.promote)
  const startBackup = useBackupStore(state => state.start)
  const pauseBackup = useBackupStore(state => state.pause)
  const resumeBackup = useBackupStore(state => state.resume)
  const approveDiff = useBackupStore(state => state.approveDiff)
  const migrationRuns = useMigrationStore(state => state.runs)
  const migrationsLoading = useMigrationStore(state => state.loading)
  const migrationError = useMigrationStore(state => state.error)
  const loadMigrations = useMigrationStore(state => state.load)
  const pauseMigration = useMigrationStore(state => state.pause)
  const resumeMigration = useMigrationStore(state => state.resume)
  const cancelMigration = useMigrationStore(state => state.cancel)
  const retryMigrationCleanup = useMigrationStore(state => state.retryCleanup)
  const [picker, setPicker] = useState<{ role: LibraryRole; source: LibraryLocation | null } | null>(null)
  const [reclassify, setReclassify] = useState<{ source: LibraryLocation; target: LibraryLocation } | null>(null)
  const [promote, setPromote] = useState<LibraryLocation | null>(null)
  const [remove, setRemove] = useState<LibraryLocation | null>(null)
  const [unlink, setUnlink] = useState<LibraryLocation | null>(null)
  const [review, setReview] = useState<LibraryBackupState | null>(null)
  const [migration, setMigration] = useState<LibraryLocation | null>(null)
  const [migrationReview, setMigrationReview] = useState<LibraryMigrationState | null>(null)
  const [presentation, setPresentation] = useState<LibraryLocation | null>(null)

  const closeTopLayer = useCallback(() => {
    if (migrationReview) setMigrationReview(null)
    else if (migration) return
    else if (presentation) setPresentation(null)
    else if (review) setReview(null)
    else if (reclassify) setReclassify(null)
    else if (promote) setPromote(null)
    else if (unlink) setUnlink(null)
    else if (remove) setRemove(null)
    else if (picker) setPicker(null)
  }, [migration, migrationReview, picker, presentation, promote, reclassify, remove, review, unlink])
  useEscapeClose(closeTopLayer)

  useEffect(() => {
    void Promise.all([loadLocations(), loadBackups(), loadMigrations()])
  }, [loadBackups, loadLocations, loadMigrations])

  useEffect(() => {
    if (window.api.meta.platform !== 'macos') return
    const refreshAccessState = () => { void loadLocations() }
    window.addEventListener('focus', refreshAccessState)
    return () => window.removeEventListener('focus', refreshAccessState)
  }, [loadLocations])

  const libraryLocations = useMemo(
    () => locations.filter(location => location.role === 'library'),
    [locations],
  )
  const backupLocations = useMemo(
    () => locations.filter(location => location.role === 'backup'),
    [locations],
  )
  const locationById = useMemo(
    () => new Map(locations.map(location => [location.id, location])),
    [locations],
  )
  const backupByFolderId = useMemo(
    () => new Map(backups.map(backup => [backup.backupFolderId, backup])),
    [backups],
  )

  const reload = async () => {
    await Promise.all([loadLocations(), loadBackups(), loadMigrations()])
  }

  const terminalMigrationSignature = migrationRuns
    .filter(run => ['completed', 'cleanup_pending', 'cancelled'].includes(run.status))
    .map(run => `${run.runId}:${run.status}:${run.updatedAt}`)
    .join('|')
  useEffect(() => {
    if (!terminalMigrationSignature) return
    void Promise.all([loadLocations(), loadBackups()])
  }, [loadBackups, loadLocations, terminalMigrationSignature])

  const perform = async (operation: () => Promise<void>, after?: () => void) => {
    try {
      await operation()
      after?.()
      await reload()
    } catch {
      // Stores expose the actionable error inline.
    }
  }

  const handleCreated = async () => {
    setPicker(null)
    await reload()
  }

  const migrationForLocation = (folderId: number): LibraryMigrationState | null => (
    migrationRuns.find(run => (
      run.sourceFolderId === folderId || run.targetFolderId === folderId
    ) && !['cancelled'].includes(run.status)) ?? null
  )

  const migrationPercent = (run: LibraryMigrationState): number => {
    if (run.totalBytes > 0) return Math.min(100, Math.round(run.completedBytes / run.totalBytes * 100))
    if (run.totalActions > 0) return Math.min(100, Math.round(run.completedActions / run.totalActions * 100))
    return run.status === 'completed' ? 100 : 0
  }

  const renderMigrationState = (run: LibraryMigrationState | null) => {
    if (!run || ['completed', 'cancelled'].includes(run.status)) return null
    const active = ['planning', 'transferring', 'publishing', 'committing'].includes(run.status)
    return (
      <div className={`location-migration-state status-${run.status}`}>
        <div>
          <span><i aria-hidden /> {MIGRATION_STATUS_LABELS[run.status]}</span>
          <small title={run.relativePath ?? undefined}>{run.cleanupError ?? run.error ?? run.relativePath ?? run.phase}</small>
        </div>
        {(active || run.status === 'paused') && <progress max={100} value={migrationPercent(run)} />}
      </div>
    )
  }

  const renderMigrationAction = (run: LibraryMigrationState | null) => {
    if (!run || ['completed', 'cancelled'].includes(run.status)) return null
    if (run.status === 'awaiting_approval') return (
      <button className="btn sm primary" type="button" onClick={() => setMigrationReview(run)}><Icon name="info" size={12} /> Revisar</button>
    )
    if (run.status === 'transferring' || run.status === 'publishing') return (
      <button className="btn sm" type="button" onClick={() => { void pauseMigration(run.runId) }}><Icon name="pause" size={12} /> Pausar</button>
    )
    if (run.status === 'paused' || run.status === 'failed') return (
      <>
        <button className="btn sm primary" type="button" onClick={() => { void resumeMigration(run.runId) }}><Icon name="play" size={12} /> Reanudar</button>
        <button className="btn ghost sm" type="button" onClick={() => { void cancelMigration(run.runId) }}>Cancelar</button>
      </>
    )
    if (run.status === 'cleanup_pending') return (
      <button className="btn sm" type="button" onClick={() => { void retryMigrationCleanup(run.runId) }}><Icon name="trash" size={12} /> Reintentar limpieza</button>
    )
    return <button className="btn sm" type="button" disabled><Icon name="loader" size={12} className="loc-spin" /> Migrando</button>
  }

  const renderBackupActions = (location: LibraryLocation, state: LibraryBackupState) => {
    const busy = busyFolderId === location.id
    if (state.status === 'awaiting_approval') {
      return (
        <button className="btn sm loc-review-btn" type="button" disabled={busy} onClick={() => setReview(state)}>
          <Icon name="info" size={12} /> Revisar cambios
        </button>
      )
    }
    if (state.status === 'planning') {
      return (
        <button className="btn sm" type="button" disabled>
          <Icon name="sync" size={12} /> Preparando…
        </button>
      )
    }
    if (state.status === 'running') {
      return (
        <button className="btn sm" type="button" disabled={busy} onClick={() => { void perform(() => pauseBackup(location.id)) }}>
          <Icon name="pause" size={12} /> {busy ? 'Pausando…' : 'Pausar'}
        </button>
      )
    }
    if (state.status === 'paused' || state.status === 'failed') {
      return (
        <button className="btn sm primary" type="button" disabled={busy} onClick={() => { void perform(() => resumeBackup(location.id)) }}>
          <Icon name="play" size={12} /> {busy ? 'Reanudando…' : 'Reanudar'}
        </button>
      )
    }
    return (
      <button className="btn sm" type="button" disabled={busy || state.status === 'offline'} onClick={() => { void perform(() => startBackup(location.id)) }}>
        <Icon name="sync" size={12} /> {busy ? 'Iniciando…' : 'Sincronizar'}
      </button>
    )
  }

  const renderAccessActions = (location: LibraryLocation) => {
    if (
      window.api.meta.platform !== 'macos'
      || location.provider !== 'local'
      || location.localAccess?.state !== 'permission_required'
    ) return null
    return (
      <>
        <button
          className="btn sm primary"
          type="button"
          disabled={locationPickerBusy}
          onClick={() => { void requestLocalAccess(location.id) }}
        >
          <Icon name="folder" size={12} /> {locationPickerBusy ? 'Abriendo…' : 'Dar acceso'}
        </button>
        <button
          className="btn ghost sm"
          type="button"
          title="Abrir Privacidad y seguridad"
          onClick={() => { void openFilePrivacySettings() }}
        >
          Ajustes del Sistema
        </button>
      </>
    )
  }

  const renderLibrary = (library: LibraryLocation) => {
    const linked = backupLocations.find(item => item.backupSourceFolderId === library.id)
    const activeMigration = migrationForLocation(library.id)
    const compatibleExisting = libraryLocations.filter(candidate => (
      candidate.id !== library.id
      && !backupLocations.some(backup => backup.backupSourceFolderId === candidate.id)
    ))
    return (
      <li className="loc-chain" key={library.id}>
        <div className="loc-row library">
          <div className={`loc-kind-icon ${library.provider}`} aria-hidden="true">
            <Icon name={library.provider === 'onedrive' ? 'cloud' : 'folder'} size={17} />
          </div>
          <div className="loc-row-copy">
            <div className="loc-title-line">
              <strong>{locationTitle(library)}</strong>
              <span className={`loc-badge provider ${library.provider}`}>{providerLabel(library.provider)}</span>
              <span className="loc-badge role library">{roleLabel(library.role)}</span>
            </div>
            <div className="loc-path" title={library.path}>{library.path}</div>
            <div className="loc-meta">
              <span
                className={`loc-availability access-${localAccessClass(library)}`}
                title={library.localAccess?.detail ?? undefined}
              >
                <i aria-hidden="true" /> {localAccessLabel(library)}
              </span>
              <span>{library.trackCount.toLocaleString('es-AR')} canciones</span>
            </div>
            {renderMigrationState(activeMigration)}
          </div>
          <div className="loc-row-actions">
            {renderAccessActions(library)}
            {renderMigrationAction(activeMigration)}
            {!activeMigration || ['completed', 'cancelled'].includes(activeMigration.status) ? (
              <button className="btn sm" type="button" onClick={() => setMigration(library)}><Icon name="sync" size={12} /> Migrar</button>
            ) : null}
            <button className="btn ghost sm" type="button" title="Editar nombre e icono" onClick={() => setPresentation(library)}><Icon name="edit" size={12} /></button>
            <button
              className="btn sm"
              type="button"
              disabled={Boolean(linked) || Boolean(activeMigration && !['completed', 'cancelled'].includes(activeMigration.status))}
              title={linked ? 'Esta biblioteca ya tiene un backup asignado' : undefined}
              onClick={() => setPicker({ role: 'backup', source: library })}
            >
              <Icon name="plus" size={12} /> Backup
            </button>
            <button
              className="btn ghost sm"
              type="button"
              disabled={Boolean(linked)}
              title={linked ? 'Desvinculá o promové el backup antes de quitar la biblioteca' : 'Quitar ubicación'}
              onClick={() => setRemove(library)}
            >
              <Icon name="trash" size={12} />
              <span className="loc-action-label">Quitar</span>
            </button>
          </div>
        </div>

        {linked ? renderBackup(linked) : (
          <div className="loc-empty-backup">
            <span aria-hidden="true" />
            <p>Sin espejo asignado. La biblioteca funciona normalmente y sus archivos no se copian.</p>
          </div>
        )}

        {!linked && picker?.role === 'backup' && picker.source?.id === library.id && compatibleExisting.length > 0 && (
          <span className="sr-only">Hay bibliotecas existentes compatibles para usar como backup.</span>
        )}
      </li>
    )
  }

  const renderBackup = (location: LibraryLocation) => {
    const source = location.backupSourceFolderId == null ? null : locationById.get(location.backupSourceFolderId) ?? null
    const state = backupByFolderId.get(location.id) ?? {
      backupFolderId: location.id,
      sourceFolderId: source?.id ?? location.backupSourceFolderId,
      runId: null,
      status: 'idle' as const,
      phase: null,
      currentPath: null,
      completedFiles: 0,
      totalFiles: 0,
      transferredBytes: 0,
      totalBytes: null,
      error: null,
      plan: null,
      lastRunAt: null,
    }
    const percent = progressPercent(state)
    const isActive = state.status === 'planning' || state.status === 'running'
    const activeMigration = migrationForLocation(location.id)
    return (
      <div className={`loc-row backup status-${state.status}`} key={location.id} aria-live="polite">
        <div className="loc-backup-connector" aria-hidden="true"><i /></div>
        <div className={`loc-kind-icon ${location.provider}`} aria-hidden="true">
          <Icon name={location.provider === 'onedrive' ? 'cloud' : 'folder'} size={17} />
        </div>
        <div className="loc-row-copy">
          <div className="loc-title-line">
            <strong>{locationTitle(location)}</strong>
            <span className={`loc-badge provider ${location.provider}`}>{providerLabel(location.provider)}</span>
            <span className="loc-badge role backup">Backup</span>
          </div>
          <div className="loc-path" title={location.path}>{location.path}</div>
          <div className="loc-backup-state">
            <span
              className={`loc-availability access-${localAccessClass(location)}`}
              title={location.localAccess?.detail ?? undefined}
            >
              <i aria-hidden="true" /> {localAccessLabel(location)}
            </span>
            <span className={`loc-status status-${state.status}`}>
              <i aria-hidden="true" /> {BACKUP_STATUS_LABELS[state.status]}
            </span>
            <span className="loc-progress-detail" title={state.currentPath ?? undefined}>{backupDetail(state)}</span>
          </div>
          {(isActive || state.status === 'paused') && (
            <progress className={`loc-progress status-${state.status}`} max={100} value={percent} aria-label={`Progreso del backup: ${percent}%`}>
              {percent}%
            </progress>
          )}
          {state.error && <div className="loc-row-error" role="alert">{state.error}</div>}
          {source && <div className="loc-source-note">Respalda a {locationTitle(source)}</div>}
          {renderMigrationState(activeMigration)}
        </div>
        <div className="loc-row-actions backup-actions">
          {renderAccessActions(location)}
          {renderMigrationAction(activeMigration)}
          {!activeMigration || ['completed', 'cancelled'].includes(activeMigration.status) ? (
            <button className="btn sm" type="button" onClick={() => setMigration(location)}><Icon name="sync" size={12} /> Migrar</button>
          ) : null}
          <button className="btn ghost sm" type="button" title="Editar nombre e icono" onClick={() => setPresentation(location)}><Icon name="edit" size={12} /></button>
          {(!activeMigration || ['completed', 'cancelled'].includes(activeMigration.status)) && renderBackupActions(location, state)}
          <button className="btn ghost sm" type="button" disabled={busyFolderId === location.id} onClick={() => setPromote(location)}>
            Promover
          </button>
          <button className="btn ghost sm" type="button" disabled={busyFolderId === location.id} onClick={() => setUnlink(location)}>
            Desvincular
          </button>
        </div>
      </div>
    )
  }

  const orphanBackups = backupLocations.filter(location => (
    location.backupSourceFolderId == null || !locationById.has(location.backupSourceFolderId)
  ))
  const pickerExistingCandidates = picker?.role === 'backup' && picker.source
    ? libraryLocations.filter(candidate => (
        candidate.id !== picker.source?.id
        && !backupLocations.some(backup => backup.backupSourceFolderId === candidate.id)
      ))
    : []

  return (
    <section className="set-section loc-settings-section">
      <div className="set-section-head loc-section-head">
        <div>
          <h2>Ubicaciones de biblioteca</h2>
          <p className="set-section-sub">Local y OneDrive comparten el catálogo. Solo las ubicaciones marcadas como backup quedan fuera.</p>
        </div>
        <button className="btn primary sm" type="button" onClick={() => setPicker({ role: 'library', source: null })}>
          <Icon name="plus" size={12} /> Agregar biblioteca
        </button>
      </div>

      {(locationsError || backupError || migrationError) && (
        <div className="loc-inline-error" role="alert">
          <Icon name="info" size={14} />
          <span>{locationsError ?? backupError ?? migrationError}</span>
          <button className="btn ghost sm" type="button" onClick={() => { void reload() }}>Reintentar</button>
        </div>
      )}

      {(locationsLoading || backupsLoading || migrationsLoading) && locations.length === 0 ? (
        <div className="loc-list-loading" role="status"><Icon name="loader" size={15} className="loc-spin" /> Cargando ubicaciones…</div>
      ) : libraryLocations.length === 0 ? (
        <div className="loc-list-empty">
          <span className="loc-empty-mark"><Icon name="library" size={22} /></span>
          <div><strong>No hay una biblioteca base</strong><p>Agregá una carpeta local o de OneDrive para empezar.</p></div>
          <button className="btn primary" type="button" onClick={() => setPicker({ role: 'library', source: null })}>Agregar biblioteca</button>
        </div>
      ) : (
        <ul className="loc-list" aria-label="Bibliotecas y backups">
          {libraryLocations.map(renderLibrary)}
        </ul>
      )}

      {orphanBackups.length > 0 && (
        <div className="loc-orphan-group">
          <h3>Backups sin biblioteca base</h3>
          {orphanBackups.map(renderBackup)}
        </div>
      )}

      <SourceDisplaySettings />

      {picker && (
        <ModalShell
          title={picker.role === 'backup' ? `Backup de ${locationTitle(picker.source!)}` : 'Agregar biblioteca'}
          onClose={() => setPicker(null)}
        >
          <LibraryLocationPicker role={picker.role} source={picker.source} onCreated={handleCreated} />
          {picker.role === 'backup' && pickerExistingCandidates.length > 0 && (
            <div className="loc-existing-destinations">
              <div className="loc-subsection-title"><span>o usar una biblioteca ya agregada</span></div>
              {pickerExistingCandidates.map(candidate => (
                <button
                  className="loc-existing-row"
                  type="button"
                  key={candidate.id}
                  onClick={() => setReclassify({ source: picker.source!, target: candidate })}
                >
                  <span className={`loc-kind-icon ${candidate.provider}`}><Icon name={candidate.provider === 'onedrive' ? 'cloud' : 'folder'} size={15} /></span>
                  <span><strong>{locationTitle(candidate)}</strong><small>{candidate.path}</small></span>
                  <span>Usar como backup</span>
                </button>
              ))}
            </div>
          )}
        </ModalShell>
      )}

      {reclassify && (
        <ConfirmationDialog
          title="Usar biblioteca como backup"
          copy={`${locationTitle(reclassify.target)} dejará de aparecer en el catálogo y pasará a espejar ${locationTitle(reclassify.source)}. Sus archivos no se borrarán; si el destino tiene cambios propios, Crate pedirá revisar el primer lote.`}
          confirmLabel="Convertir en backup"
          busy={busyFolderId === reclassify.target.id && busyAction === 'assign'}
          onClose={() => setReclassify(null)}
          onConfirm={() => { void perform(
            () => assignBackup(reclassify.source.id, reclassify.target.id),
            () => { setReclassify(null); setPicker(null) },
          ) }}
        />
      )}

      {promote && (
        <ConfirmationDialog
          title="Promover backup a biblioteca"
          copy={`${locationTitle(promote)} dejará de espejar su origen, se incorporará al catálogo y recuperará el estado portable guardado en .crate/library.yaml.`}
          confirmLabel="Promover biblioteca"
          busy={busyFolderId === promote.id && busyAction === 'promote'}
          onClose={() => setPromote(null)}
          onConfirm={() => { void perform(() => promoteBackup(promote.id), () => setPromote(null)) }}
        />
      )}

      {unlink && (
        <ConfirmationDialog
          title="Desvincular backup"
          copy={`${locationTitle(unlink)} dejará de recibir cambios y volverá a ser una biblioteca normal. No se borrará ningún archivo.`}
          confirmLabel="Desvincular"
          busy={busyFolderId === unlink.id && busyAction === 'unlink'}
          onClose={() => setUnlink(null)}
          onConfirm={() => { void perform(() => unlinkBackup(unlink.id), () => setUnlink(null)) }}
        />
      )}

      {remove && (
        <ConfirmationDialog
          title="Quitar biblioteca"
          copy={`${locationTitle(remove)} se quitará del catálogo de Crate. Los archivos de la carpeta no se modificarán.`}
          confirmLabel="Quitar biblioteca"
          danger
          busy={locationsLoading}
          onClose={() => setRemove(null)}
          onConfirm={() => { void perform(() => removeLocation(remove.id), () => setRemove(null)) }}
        />
      )}

      {review && (
        <DiffReviewDialog
          backup={review}
          busy={busyFolderId === review.backupFolderId && busyAction === 'approve'}
          onClose={() => setReview(null)}
          onApprove={() => {
            const runId = review.plan?.runId ?? review.runId
            if (runId == null) return
            void perform(() => approveDiff(review.backupFolderId, runId), () => setReview(null))
          }}
        />
      )}

      {migration && (
        <LibraryMigrationWizard
          source={migration}
          locations={locations}
          onClose={() => setMigration(null)}
          onChanged={reload}
        />
      )}

      {migrationReview && (
        <MigrationReviewDialog run={migrationReview} onClose={() => setMigrationReview(null)} />
      )}

      {presentation && (
        <LocationPresentationDialog
          location={presentation}
          onClose={() => setPresentation(null)}
          onSave={input => updatePresentation(presentation.id, input)}
        />
      )}
    </section>
  )
}
