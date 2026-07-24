import { create } from 'zustand'
import type {
  AppUpdateState,
  ImportCompleteEvent,
  ImportProgressEvent,
} from '@shared/types/ipc-contract'
import type {
  DeviceArtworkAnalysisProgressEvent,
  DeviceScanProgressEvent,
  DeviceSyncProgressEvent,
  DeviceUnknownVolume,
  DeviceVolumeSnapshot,
} from '@shared/types/device-sync'
import type { LyricsSelectionProgress } from '@shared/types/lyrics'
import type { DownloadJob } from '@shared/types/downloads'
import type { DuplicateAnalysisProgress, DuplicateSummary } from '@shared/types/duplicates'

export type ActivityCategory = 'devices' | 'lyrics' | 'library' | 'duplicates' | 'downloads' | 'updates'
export type ActivityStatus = 'queued' | 'running' | 'waiting' | 'success' | 'warning' | 'error' | 'info'

export type ActivityActionId =
  | 'open-device'
  | 'open-device-sync'
  | 'open-libraries'
  | 'connect-device'
  | 'add-library'
  | 'ignore-volume'
  | 'open-lyrics-settings'
  | 'open-downloads'
  | 'open-import'
  | 'open-updates'
  | 'open-duplicates'

export interface ActivityProgress {
  completed: number
  total: number
  percent: number | null
  label: string
}

export interface ActivityMetadata {
  [key: string]: string | number | boolean | null | undefined
  activityKind?: string
  deviceId?: string
  planId?: string
  rootPath?: string
  pathToken?: string
  volumeName?: string
  folderId?: number
  downloadJobId?: string
  updateStatus?: string
}

export interface ActivityItem {
  id: string
  category: ActivityCategory
  status: ActivityStatus
  title: string
  detail: string | null
  progress: ActivityProgress | null
  read: boolean
  createdAt: number
  updatedAt: number
  metadata: ActivityMetadata
  actionIds: ActivityActionId[]
}

export interface ActivityUpsert {
  id: string
  category: ActivityCategory
  status: ActivityStatus
  title: string
  detail?: string | null
  progress?: ActivityProgress | null
  metadata?: ActivityMetadata
  actionIds?: ActivityActionId[]
  read?: boolean
}

interface PersistedActivityCenterState {
  items: ActivityItem[]
  pinned: boolean
}

interface ActivityCenterState {
  items: ActivityItem[]
  open: boolean
  pinned: boolean
  fullscreen: boolean
  upsert(input: ActivityUpsert): void
  completeActivity(id: string, detail?: string | null): void
  resolveDeviceSyncDiscarded(planId: string): void
  resolveDeviceArtworkOptimization(deviceId: string, planId: string | null | undefined, status: ActivityStatus, detail?: string | null): void
  markAllRead(): void
  clearResolved(): void
  remove(id: string): void
  openPanel(): void
  closePanel(): void
  togglePanel(): void
  setPinned(pinned: boolean): void
  setFullscreen(fullscreen: boolean): void
}

export const ACTIVITY_STORAGE_KEY = 'crate.activityCenter.v1'
export const ACTIVITY_MAX_ITEMS = 100

const ACTIVE_STATUSES: ActivityStatus[] = ['queued', 'running', 'waiting']

const IMPORT_PHASE_LABELS: Record<ImportProgressEvent['phase'], string> = {
  discovering: 'Descubriendo archivos',
  scanning: 'Leyendo biblioteca',
  writing: 'Guardando biblioteca',
}

const LYRICS_PHASE_LABELS: Record<NonNullable<LyricsSelectionProgress['phase']>, string> = {
  queued: 'En cola',
  waiting: 'Esperando proveedor',
  fetching: 'Buscando en LRCLIB',
  complete: 'Completado',
}

const DEVICE_SCAN_PHASE_LABELS: Record<DeviceScanProgressEvent['phase'], string> = {
  discovering: 'Buscando archivos',
  reading: 'Leyendo dispositivo',
  complete: 'Scan completado',
}

const DEVICE_SYNC_PHASE_LABELS: Record<DeviceSyncProgressEvent['phase'], string> = {
  copying: 'Copiando',
  deleting: 'Eliminando',
  refreshing: 'Actualizando',
  optimizing_artwork: 'Optimizando artwork',
  writing_state: 'Guardando estado',
  complete: 'Sincronización completada',
}

const ARTWORK_PHASE_LABELS: Record<DeviceArtworkAnalysisProgressEvent['phase'], string> = {
  scanning: 'Buscando artwork',
  reading: 'Analizando artwork',
  complete: 'Artwork analizado',
}

const DOWNLOAD_STATUS_LABELS: Record<DownloadJob['status'], string> = {
  queued: 'En cola',
  authenticating: 'Autenticando',
  resolving: 'Resolviendo',
  downloading: 'Descargando',
  verifying: 'Verificando',
  tagging: 'Etiquetando',
  importing: 'Importando',
  completed: 'Completada',
  failed: 'Fallida',
  cancelled: 'Cancelada',
  unavailable: 'No disponible',
  already_exists: 'Ya existe',
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function persistActivityCenterState(state: PersistedActivityCenterState): void {
  if (!storageAvailable()) return
  try {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify({
      items: pruneActivityItems(state.items),
      pinned: state.pinned,
    }))
  } catch {
    // Best-effort UI history; storage failures should never block playback.
  }
}

function readPersistedActivityCenterState(now = Date.now()): PersistedActivityCenterState {
  if (!storageAvailable()) return { items: [], pinned: false }
  try {
    const raw = window.localStorage.getItem(ACTIVITY_STORAGE_KEY)
    if (!raw) return { items: [], pinned: false }
    const parsed = JSON.parse(raw) as Partial<PersistedActivityCenterState>
    return {
      items: hydrateActivityItems(parsed.items ?? [], now),
      pinned: Boolean(parsed.pinned),
    }
  } catch {
    return { items: [], pinned: false }
  }
}

export function isActiveActivityStatus(status: ActivityStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

export function activityProgress(completed: number, total: number, label?: string): ActivityProgress {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0
  const safeCompleted = Number.isFinite(completed)
    ? Math.max(0, safeTotal > 0 ? Math.min(safeTotal, Math.round(completed)) : Math.round(completed))
    : 0
  const percent = safeTotal > 0 ? Math.min(100, Math.round((safeCompleted / safeTotal) * 100)) : null
  return {
    completed: safeCompleted,
    total: safeTotal,
    percent,
    label: label ?? (safeTotal > 0 ? `${safeCompleted}/${safeTotal}` : 'Trabajando'),
  }
}

export function activityActionIdsFor(item: ActivityItem): ActivityActionId[] {
  if (item.metadata.activityKind === 'unknown-volume') {
    return ['connect-device', 'add-library', 'ignore-volume', 'open-libraries']
  }
  return item.actionIds
}

export function primaryActivityActionIdFor(item: ActivityItem): ActivityActionId | null {
  switch (item.metadata.activityKind) {
    case 'unknown-volume':
      return 'open-libraries'
    case 'device-scan':
      return 'open-device'
    case 'device-sync':
    case 'device-artwork-optimization':
    case 'device-artwork-analysis':
      return 'open-device-sync'
    case 'lyrics-selection':
      return 'open-lyrics-settings'
    case 'library-import':
      return 'open-import'
    case 'download':
      return 'open-downloads'
    case 'app-update':
      return 'open-updates'
    case 'duplicate-analysis':
    case 'duplicate-candidates':
      return 'open-duplicates'
    default:
      return item.actionIds.find(actionId => actionId.startsWith('open-')) ?? item.actionIds[0] ?? null
  }
}

export function upsertActivityItem(
  items: ActivityItem[],
  input: ActivityUpsert,
  now = Date.now(),
): ActivityItem[] {
  const previous = items.find(item => item.id === input.id)
  const replacesDetail = Object.prototype.hasOwnProperty.call(input, 'detail')
  const replacesProgress = Object.prototype.hasOwnProperty.call(input, 'progress')
  const next: ActivityItem = {
    id: input.id,
    category: input.category,
    status: input.status,
    title: input.title,
    detail: replacesDetail ? (input.detail ?? null) : (previous?.detail ?? null),
    progress: replacesProgress ? (input.progress ?? null) : (previous?.progress ?? null),
    read: input.read ?? false,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    metadata: {
      ...(previous?.metadata ?? {}),
      ...(input.metadata ?? {}),
    },
    actionIds: input.actionIds ?? previous?.actionIds ?? [],
  }
  return pruneActivityItems([
    next,
    ...items.filter(item => item.id !== input.id),
  ])
}

export function hydrateActivityItems(items: ActivityItem[], now = Date.now()): ActivityItem[] {
  return pruneActivityItems(items.filter(shouldHydrateActivityItem).map(item => {
    if (!isActiveActivityStatus(item.status)) return item
    return {
      ...item,
      status: 'warning',
      detail: item.detail || 'Actividad interrumpida al cerrar la app.',
      progress: item.progress,
      read: false,
      updatedAt: now,
    } satisfies ActivityItem
  }))
}

function shouldHydrateActivityItem(item: ActivityItem): boolean {
  if (isInterruptedArtworkOptimizationActivity(item)) return false
  if (item.metadata.activityKind !== 'app-update') return true
  return !isNonActionableUpdateStatus(item.metadata.updateStatus)
}

function isInterruptedArtworkOptimizationActivity(item: ActivityItem): boolean {
  if (item.metadata.activityKind !== 'device-artwork-optimization') return false
  if (isActiveActivityStatus(item.status)) return true
  return item.status === 'warning' &&
    item.progress != null &&
    item.progress.total > 0 &&
    item.progress.completed < item.progress.total
}

function isNonActionableUpdateStatus(status: unknown): boolean {
  return status === 'idle' || status === 'unsupported' || status === 'not-available'
}

export function pruneActivityItems(items: ActivityItem[]): ActivityItem[] {
  return [...items]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, ACTIVITY_MAX_ITEMS)
}

export function syncUnknownVolumeActivities(
  items: ActivityItem[],
  volumes: DeviceUnknownVolume[],
  now = Date.now(),
): ActivityItem[] {
  const activeRoots = new Set(volumes.map(volume => volume.rootPath))
  let next = items
  for (const volume of volumes) {
    next = upsertActivityItem(next, activityFromUnknownVolume(volume), now)
  }
  next = next.map(item => {
    if (item.metadata.activityKind !== 'unknown-volume') return item
    const rootPath = typeof item.metadata.rootPath === 'string' ? item.metadata.rootPath : ''
    if (activeRoots.has(rootPath) || item.status === 'success') return item
    return {
      ...item,
      status: 'success',
      detail: 'Volumen clasificado o desconectado.',
      read: false,
      updatedAt: now,
      actionIds: ['open-libraries'],
    }
  })
  return pruneActivityItems(next)
}

export function resolveDeviceSyncActivityDiscarded(
  items: ActivityItem[],
  planId: string,
  now = Date.now(),
  read = false,
): ActivityItem[] {
  const activityId = `device-sync:${planId}`
  return pruneActivityItems(items.map(item => item.id === activityId
    ? {
        ...item,
        status: 'info' as ActivityStatus,
        title: 'Sync descartada',
        detail: 'Sync incompleta descartada.',
        progress: null,
        read,
        updatedAt: now,
      }
    : item))
}

function matchesDeviceArtworkOptimization(item: ActivityItem, deviceId: string, planId?: string | null): boolean {
  if (planId && item.id === `device-sync:${planId}`) {
    return item.metadata.deviceId === undefined || item.metadata.deviceId === deviceId
  }
  return item.metadata.activityKind === 'device-artwork-optimization' &&
    item.metadata.deviceId === deviceId &&
    (!planId || item.metadata.planId === planId)
}

export function resolveDeviceArtworkOptimizationActivity(
  items: ActivityItem[],
  deviceId: string,
  planId: string | null | undefined,
  status: ActivityStatus,
  detail: string | null = null,
  now = Date.now(),
  read = false,
): ActivityItem[] {
  return pruneActivityItems(items.map(item => {
    if (!matchesDeviceArtworkOptimization(item, deviceId, planId)) return item
    const progress = item.progress && (status === 'success' || status === 'warning')
      ? activityProgress(item.progress.total, item.progress.total)
      : item.progress
    return {
      ...item,
      status,
      title: status === 'error' ? 'Artwork no optimizado' : 'Artwork optimizado',
      detail: detail ?? item.detail,
      progress,
      read,
      updatedAt: now,
      metadata: {
        ...item.metadata,
        activityKind: 'device-artwork-optimization',
        deviceId,
        planId: planId ?? item.metadata.planId,
      },
    }
  }))
}

export function activityFromImportProgress(event: ImportProgressEvent): ActivityUpsert {
  const progress = activityProgress(event.scanned, event.total)
  return {
    id: `library-import:${event.folderId}`,
    category: 'library',
    status: 'running',
    title: 'Importando biblioteca',
    detail: `${IMPORT_PHASE_LABELS[event.phase]} · ${event.imported.toLocaleString()} importadas`,
    progress,
    metadata: { activityKind: 'library-import', folderId: event.folderId },
    actionIds: ['open-import'],
  }
}

export function activityFromImportComplete(event: ImportCompleteEvent): ActivityUpsert {
  return {
    id: `library-import:${event.folderId}`,
    category: 'library',
    status: 'success',
    title: 'Biblioteca importada',
    detail: `${event.totalImported.toLocaleString()} canciones importadas`,
    progress: activityProgress(event.total, event.total),
    metadata: { activityKind: 'library-import', folderId: event.folderId },
    actionIds: ['open-import'],
  }
}

export function activityFromDuplicateSummary(summary: DuplicateSummary): ActivityUpsert | null {
  if (!summary.running && summary.pendingCount === 0 && summary.failedCount === 0 && !summary.blocker) return null
  const progress = summary.progress
    ? activityProgress(summary.progress.completed, summary.progress.total)
    : null
  if (summary.blocker) {
    const waitingForLibrary = summary.blocker.retryable
    return {
      id: 'duplicates:pending',
      category: 'duplicates',
      status: waitingForLibrary ? 'waiting' : 'error',
      title: summary.blocker.code === 'local_library_unavailable'
        ? 'Biblioteca desconectada'
        : summary.blocker.code === 'local_library_permission_required'
          ? 'Esperando acceso a la biblioteca'
          : summary.blocker.code === 'native_component_missing'
            ? 'Falta el componente de análisis acústico'
            : 'Análisis acústico no disponible',
      detail: summary.blocker.message,
      progress: null,
      metadata: {
        activityKind: 'duplicate-analysis',
        analysisBlocker: summary.blocker.code,
      },
      actionIds: ['open-duplicates'],
    }
  }
  if (summary.running) {
    return {
      id: 'duplicates:pending',
      category: 'duplicates',
      status: 'running',
      title: 'Buscando temas duplicados',
      detail: summary.progress?.currentTitle || 'Comparando huellas acústicas',
      progress,
      metadata: { activityKind: 'duplicate-analysis' },
      actionIds: ['open-duplicates'],
    }
  }
  if (summary.pendingCount > 0) {
    return {
      id: 'duplicates:pending',
      category: 'duplicates',
      status: 'warning',
      title: summary.pendingCount === 1 ? 'Posible tema duplicado' : 'Posibles temas duplicados',
      detail: summary.pendingCount === 1
        ? 'Hay una comparación pendiente de revisión.'
        : `Hay ${summary.pendingCount.toLocaleString()} comparaciones pendientes de revisión.`,
      progress: null,
      metadata: { activityKind: 'duplicate-candidates', pendingCount: summary.pendingCount },
      actionIds: ['open-duplicates'],
    }
  }
  return {
    id: 'duplicates:pending',
    category: 'duplicates',
    status: 'error',
    title: 'No se completó el análisis de duplicados',
    detail: `${summary.failedCount.toLocaleString()} ${summary.failedCount === 1 ? 'tema requiere' : 'temas requieren'} un nuevo intento.`,
    progress: null,
    metadata: { activityKind: 'duplicate-analysis' },
    actionIds: ['open-duplicates'],
  }
}

export function activityFromDuplicateProgress(event: DuplicateAnalysisProgress): ActivityUpsert {
  const phaseLabel: Record<DuplicateAnalysisProgress['phase'], string> = {
    prefiltering: 'Buscando candidatos',
    fingerprinting: 'Calculando huellas acústicas',
    comparing: 'Comparando grabaciones',
    complete: 'Análisis completado',
    error: 'El análisis necesita atención',
  }
  return {
    id: 'duplicates:pending',
    category: 'duplicates',
    status: event.phase === 'error'
      ? event.blocker?.retryable ? 'waiting' : 'error'
      : event.phase === 'complete' ? 'success' : 'running',
    title: event.phase === 'complete'
      ? 'Biblioteca analizada'
      : event.phase === 'error'
        ? event.blocker?.code === 'local_library_unavailable'
          ? 'Biblioteca desconectada'
          : event.blocker?.code === 'local_library_permission_required'
            ? 'Esperando acceso a la biblioteca'
            : 'Análisis de duplicados no disponible'
        : 'Buscando temas duplicados',
    detail: event.message || phaseLabel[event.phase],
    progress: event.phase === 'error' ? null : activityProgress(event.completed, event.total),
    metadata: {
      activityKind: 'duplicate-analysis',
      analysisBlocker: event.blocker?.code,
    },
    actionIds: ['open-duplicates'],
  }
}

export function activityFromLyricsSelectionProgress(event: LyricsSelectionProgress): ActivityUpsert {
  const phase = event.phase ?? 'fetching'
  return {
    id: 'lyrics-selection',
    category: 'lyrics',
    status: phase === 'complete' ? 'success' : phase === 'waiting' ? 'waiting' : phase === 'queued' ? 'queued' : 'running',
    title: 'Buscando letras',
    detail: `${LYRICS_PHASE_LABELS[phase]} · ${event.found.toLocaleString()} encontradas · ${event.failed.toLocaleString()} fallidas`,
    progress: activityProgress(event.done, event.total),
    metadata: {
      activityKind: 'lyrics-selection',
      currentTrackId: event.currentTrackId,
      currentTitle: event.currentTitle,
      nextAllowedAt: event.nextAllowedAt,
    },
    actionIds: ['open-lyrics-settings'],
  }
}

export function activityFromDeviceScanProgress(event: DeviceScanProgressEvent): ActivityUpsert {
  return {
    id: `device-scan:${event.deviceId}`,
    category: 'devices',
    status: event.phase === 'complete' ? 'success' : 'running',
    title: 'Escaneando dispositivo',
    detail: DEVICE_SCAN_PHASE_LABELS[event.phase],
    progress: activityProgress(event.scanned, event.total),
    metadata: { activityKind: 'device-scan', deviceId: event.deviceId },
    actionIds: ['open-device'],
  }
}

export function activityFromDeviceSyncProgress(event: DeviceSyncProgressEvent): ActivityUpsert {
  const isArtwork = event.phase === 'optimizing_artwork'
  return {
    id: `device-sync:${event.planId}`,
    category: 'devices',
    status: event.phase === 'complete' ? 'success' : 'running',
    title: isArtwork ? 'Optimizando artwork' : 'Sincronizando dispositivo',
    detail: event.currentTitle ?? event.currentPath ?? DEVICE_SYNC_PHASE_LABELS[event.phase],
    progress: activityProgress(event.completed, event.total),
    metadata: {
      activityKind: isArtwork ? 'device-artwork-optimization' : 'device-sync',
      deviceId: event.deviceId,
      planId: event.planId,
      currentKind: event.currentKind,
    },
    actionIds: ['open-device-sync'],
  }
}

export function activityFromArtworkAnalysisProgress(event: DeviceArtworkAnalysisProgressEvent): ActivityUpsert {
  return {
    id: `device-artwork-analysis:${event.deviceId}`,
    category: 'devices',
    status: event.phase === 'complete' ? 'success' : 'running',
    title: 'Analizando artwork',
    detail: ARTWORK_PHASE_LABELS[event.phase],
    progress: activityProgress(event.scanned, event.total),
    metadata: { activityKind: 'device-artwork-analysis', deviceId: event.deviceId },
    actionIds: ['open-device-sync'],
  }
}


export function activityFromUnknownVolume(volume: DeviceUnknownVolume): ActivityUpsert {
  return {
    id: `unknown-volume:${volume.rootPath}`,
    category: 'devices',
    status: 'warning',
    title: 'Nuevo volumen detectado',
    detail: `${volume.name} · ${volume.rootPath}`,
    progress: null,
    metadata: {
      activityKind: 'unknown-volume',
      rootPath: volume.rootPath,
      pathToken: volume.token,
      volumeName: volume.name,
    },
    actionIds: ['connect-device', 'add-library', 'ignore-volume', 'open-libraries'],
  }
}

export function activityFromDownloadJob(job: DownloadJob): ActivityUpsert {
  const status: ActivityStatus =
    job.status === 'queued' ? 'queued'
      : job.status === 'completed' || job.status === 'already_exists' ? 'success'
        : job.status === 'failed' ? 'error'
          : job.status === 'cancelled' ? 'info'
            : job.status === 'unavailable' ? 'warning'
              : 'running'
  const progress = job.bytesTotal && job.bytesTotal > 0
    ? activityProgress(job.bytesReceived, job.bytesTotal)
    : null
  return {
    id: `download:${job.id}`,
    category: 'downloads',
    status,
    title: `Descarga: ${job.title}`,
    detail: job.error || `${job.artist} · ${DOWNLOAD_STATUS_LABELS[job.status]}`,
    progress,
    metadata: {
      activityKind: 'download',
      downloadJobId: job.id,
      provider: job.provider,
    },
    actionIds: ['open-downloads'],
  }
}

export function activityFromAppUpdateState(state: AppUpdateState): ActivityUpsert | null {
  if (isNonActionableUpdateStatus(state.status)) return null
  const status: ActivityStatus =
    state.status === 'checking' || state.status === 'downloading' ? 'running'
      : state.status === 'downloaded' ? 'success'
        : state.status === 'error' ? 'error'
          : 'info'
  const title = state.updateVersion ? `Actualización ${state.updateVersion}` : 'Actualizaciones'
  const detail = state.error
    || state.releaseName
    || state.status
  return {
    id: 'app-update',
    category: 'updates',
    status,
    title,
    detail,
    progress: state.progress ? activityProgress(state.progress.transferred, state.progress.total, `${Math.round(state.progress.percent)}%`) : null,
    metadata: {
      activityKind: 'app-update',
      updateStatus: state.status,
      updateVersion: state.updateVersion,
    },
    actionIds: ['open-updates'],
  }
}

function recordUpdateState(state: AppUpdateState): void {
  const activity = activityFromAppUpdateState(state)
  if (activity) {
    useActivityCenterStore.getState().upsert(activity)
  } else {
    useActivityCenterStore.getState().remove('app-update')
  }
}

function recordDuplicateSummary(summary: DuplicateSummary): void {
  const activity = activityFromDuplicateSummary(summary)
  if (activity) useActivityCenterStore.getState().upsert(activity)
  else useActivityCenterStore.getState().remove('duplicates:pending')
}

function refreshDuplicateActivity(): void {
  void window.api.duplicates.summary().then(recordDuplicateSummary).catch(() => undefined)
}

function initialState(): Pick<ActivityCenterState, 'items' | 'open' | 'pinned' | 'fullscreen'> {
  const persisted = readPersistedActivityCenterState()
  return {
    items: persisted.items,
    open: persisted.pinned,
    pinned: persisted.pinned,
    fullscreen: false,
  }
}

const initial = initialState()

export const useActivityCenterStore = create<ActivityCenterState>((set, get) => ({
  ...initial,

  upsert(input) {
    set(state => {
      const items = upsertActivityItem(state.items, { ...input, read: state.open ? true : input.read })
      persistActivityCenterState({ items, pinned: state.pinned })
      return { items }
    })
  },

  completeActivity(id, detail) {
    set(state => {
      const items = state.items.map(item => item.id === id
        ? {
            ...item,
            status: 'success' as ActivityStatus,
            detail: detail ?? item.detail,
            read: state.open,
            updatedAt: Date.now(),
          }
        : item)
      persistActivityCenterState({ items, pinned: state.pinned })
      return { items: pruneActivityItems(items) }
    })
  },

  resolveDeviceSyncDiscarded(planId) {
    set(state => {
      const items = resolveDeviceSyncActivityDiscarded(state.items, planId, Date.now(), state.open)
      persistActivityCenterState({ items, pinned: state.pinned })
      return { items }
    })
  },

  resolveDeviceArtworkOptimization(deviceId, planId, status, detail) {
    set(state => {
      const items = resolveDeviceArtworkOptimizationActivity(state.items, deviceId, planId, status, detail ?? null, Date.now(), state.open)
      persistActivityCenterState({ items, pinned: state.pinned })
      return { items }
    })
  },

  markAllRead() {
    set(state => {
      const items = state.items.map(item => ({ ...item, read: true }))
      persistActivityCenterState({ items, pinned: state.pinned })
      return { items }
    })
  },

  clearResolved() {
    set(state => {
      const items = state.items.filter(item => isActiveActivityStatus(item.status) || item.status === 'warning' || item.status === 'error')
      persistActivityCenterState({ items, pinned: state.pinned })
      return { items }
    })
  },

  remove(id) {
    set(state => {
      const items = state.items.filter(item => item.id !== id)
      persistActivityCenterState({ items, pinned: state.pinned })
      return { items }
    })
  },

  openPanel() {
    set({ open: true })
    get().markAllRead()
  },

  closePanel() {
    set(state => {
      persistActivityCenterState({ items: state.items, pinned: false })
      return { open: false, pinned: false, fullscreen: false }
    })
  },

  togglePanel() {
    const nextOpen = !get().open
    set({ open: nextOpen, fullscreen: nextOpen ? get().fullscreen : false })
    if (nextOpen) get().markAllRead()
  },

  setPinned(pinned) {
    set(state => {
      persistActivityCenterState({ items: state.items, pinned })
      return { pinned, open: pinned ? true : state.open }
    })
  },

  setFullscreen(fullscreen) {
    set({ fullscreen, open: true })
    if (fullscreen) get().markAllRead()
  },
}))

let activityListenerCleanups: Array<() => void> | null = null

function recordVolumeSnapshot(snapshot: DeviceVolumeSnapshot): void {
  useActivityCenterStore.setState(state => {
    let items = syncUnknownVolumeActivities(state.items, snapshot.unknownVolumes)
    if (state.open) items = items.map(item => ({ ...item, read: true }))
    persistActivityCenterState({ items, pinned: state.pinned })
    return { items }
  })
}

function initializeActivityCenterListeners(): void {
  if (typeof window === 'undefined' || !window.api) return
  if (activityListenerCleanups) {
    for (const off of activityListenerCleanups) off()
    activityListenerCleanups = null
  }

  const offImportProgress = window.api.library.onImportProgress(event => {
    useActivityCenterStore.getState().upsert(activityFromImportProgress(event))
  })
  const offImportComplete = window.api.library.onImportComplete(event => {
    useActivityCenterStore.getState().upsert(activityFromImportComplete(event))
  })
  const offLyrics = window.api.lyrics.onSelectionProgress(event => {
    useActivityCenterStore.getState().upsert(activityFromLyricsSelectionProgress(event))
  })
  const offScan = window.api.devices.onScanProgress(event => {
    useActivityCenterStore.getState().upsert(activityFromDeviceScanProgress(event))
  })
  const offSync = window.api.devices.onSyncProgress(event => {
    useActivityCenterStore.getState().upsert(activityFromDeviceSyncProgress(event))
  })
  const offArtwork = window.api.devices.onArtworkAnalyzeProgress(event => {
    useActivityCenterStore.getState().upsert(activityFromArtworkAnalysisProgress(event))
  })
  const offVolumes = window.api.devices.onVolumesChanged(recordVolumeSnapshot)
  const offDownloadProgress = window.api.downloads.onProgress(({ job }) => {
    useActivityCenterStore.getState().upsert(activityFromDownloadJob(job))
  })
  const offDownloadJobs = window.api.downloads.onJobsChanged(({ jobs }) => {
    for (const job of jobs) useActivityCenterStore.getState().upsert(activityFromDownloadJob(job))
  })
  const offUpdates = window.api.updates.onStateChanged(state => {
    recordUpdateState(state)
  })
  const offDuplicatesChanged = window.api.duplicates.onChanged(refreshDuplicateActivity)
  const offDuplicatesProgress = window.api.duplicates.onProgress(event => {
    useActivityCenterStore.getState().upsert(activityFromDuplicateProgress(event))
    if (event.phase === 'complete' || event.phase === 'error') refreshDuplicateActivity()
  })

  void window.api.devices.volumes().then(recordVolumeSnapshot).catch(() => undefined)
  void window.api.downloads.jobs().then(jobs => {
    for (const job of jobs) useActivityCenterStore.getState().upsert(activityFromDownloadJob(job))
  }).catch(() => undefined)
  void window.api.updates.getState().then(state => {
    recordUpdateState(state)
  }).catch(() => undefined)
  refreshDuplicateActivity()

  activityListenerCleanups = [
    offImportProgress,
    offImportComplete,
    offLyrics,
    offScan,
    offSync,
    offArtwork,
    offVolumes,
    offDownloadProgress,
    offDownloadJobs,
    offUpdates,
    offDuplicatesChanged,
    offDuplicatesProgress,
  ]
}

initializeActivityCenterListeners()

if (typeof import.meta !== 'undefined' && (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (import.meta as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    if (activityListenerCleanups) {
      for (const off of activityListenerCleanups) off()
      activityListenerCleanups = null
    }
  })
}
