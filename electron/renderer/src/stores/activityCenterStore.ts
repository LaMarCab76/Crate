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
import type { DuplicateAnalysisProgress, DuplicateSummary } from '@shared/types/duplicates'
import type {
  FolderCleanupEvent,
  FolderCleanupProposal,
  FolderCleanupProposalFolder,
} from '@shared/types/folder-cleanup'

export type ActivityCategory = 'devices' | 'lyrics' | 'library' | 'duplicates' | 'updates'
export type ActivityStatus = 'queued' | 'running' | 'waiting' | 'success' | 'warning' | 'error' | 'info'

export type ActivityActionId =
  | 'open-device'
  | 'open-device-sync'
  | 'open-libraries'
  | 'connect-device'
  | 'add-library'
  | 'ignore-volume'
  | 'open-lyrics-settings'
  | 'open-import'
  | 'open-updates'
  | 'open-duplicates'
  | 'confirm-folder-cleanup'
  | 'keep-folder-cleanup'

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
  volumeName?: string
  folderId?: number
  updateStatus?: string
  folderCleanupId?: string
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

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function withoutTransientPathTokens(metadata: ActivityMetadata): ActivityMetadata {
  const { pathToken: _expiredPathToken, ...safeMetadata } = metadata
  return safeMetadata
}

function withoutTransientActivityTokens(item: ActivityItem): ActivityItem {
  return { ...item, metadata: withoutTransientPathTokens(item.metadata) }
}

function persistActivityCenterState(state: PersistedActivityCenterState): void {
  if (!storageAvailable()) return
  try {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify({
      items: pruneActivityItems(state.items).map(withoutTransientActivityTokens),
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
    case 'app-update':
      return 'open-updates'
    case 'duplicate-analysis':
    case 'duplicate-candidates':
      return 'open-duplicates'
    case 'folder-cleanup-proposal':
    case 'folder-cleanup-removed':
    case 'device-trash-purge':
      // Deleting must be an explicit button press, never a row click.
      return null
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
    metadata: withoutTransientPathTokens({
      ...(previous?.metadata ?? {}),
      ...(input.metadata ?? {}),
    }),
    actionIds: input.actionIds ?? previous?.actionIds ?? [],
  }
  return pruneActivityItems([
    next,
    ...items.filter(item => item.id !== input.id),
  ])
}

export function hydrateActivityItems(items: ActivityItem[], now = Date.now()): ActivityItem[] {
  return pruneActivityItems(items.filter(shouldHydrateActivityItem).map(item => {
    const safeItem = withoutTransientActivityTokens(item)
    if (!isActiveActivityStatus(safeItem.status)) return safeItem
    return {
      ...safeItem,
      status: 'warning',
      detail: safeItem.detail || 'Actividad interrumpida al cerrar la app.',
      progress: safeItem.progress,
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

export function shouldShowLibraryActivity(
  event: Pick<ImportProgressEvent, 'scanReason'>,
): boolean {
  // ImportService events have no scanReason and remain user-visible. Reconciler
  // passes only surface during startup; watch/manual/periodic scans stay quiet.
  return event.scanReason == null || event.scanReason === 'startup'
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

export function shouldShowDuplicateProgressActivity(
  event: Pick<DuplicateAnalysisProgress, 'phase' | 'activityOrigin'>,
): boolean {
  // The startup pass explains initial work. Later maintenance stays quiet, but
  // errors remain actionable regardless of which pass produced them.
  return event.activityOrigin === 'startup' || event.phase === 'error'
}

export function shouldShowDuplicateSummaryActivity(
  summary: Pick<DuplicateSummary, 'running' | 'activityOrigin'>,
): boolean {
  return !summary.running || summary.activityOrigin === 'startup'
}

export function duplicateSummaryReadState(
  previous: ActivityItem | undefined,
  next: ActivityUpsert,
): boolean | undefined {
  if (!previous) return undefined
  const changed = previous.status !== next.status
    || previous.title !== next.title
    || previous.detail !== (next.detail ?? null)
  const newlyActionable = (next.status === 'error' || next.status === 'waiting') && changed
  return newlyActionable ? undefined : previous.read
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
      volumeName: volume.name,
    },
    actionIds: ['connect-device', 'add-library', 'ignore-volume', 'open-libraries'],
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

const FOLDER_CLEANUP_DETAIL_LIMIT = 3

function folderList(paths: readonly string[]): string {
  const shown = paths.slice(0, FOLDER_CLEANUP_DETAIL_LIMIT).join(', ')
  const extra = paths.length - FOLDER_CLEANUP_DETAIL_LIMIT
  return extra > 0 ? `${shown} y ${extra} más` : shown
}

function countLabel(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function remainingFilesLabel(folder: FolderCleanupProposalFolder): string {
  const parts: string[] = []
  if (folder.images.length > 0) parts.push(countLabel(folder.images.length, 'imagen', 'imágenes'))
  if (folder.playlists.length > 0) parts.push(countLabel(folder.playlists.length, 'playlist', 'playlists'))
  if (folder.lyrics.length > 0) parts.push(countLabel(folder.lyrics.length, 'letra', 'letras'))
  if (folder.otherCount > 0) parts.push(countLabel(folder.otherCount, 'archivo más', 'archivos más'))
  return parts.join(', ')
}

function formatTrashBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`
}

export function folderCleanupActivityId(proposalId: string): string {
  return `folder-cleanup:${proposalId}`
}

export function activityFromFolderCleanupProposal(proposal: FolderCleanupProposal): ActivityUpsert {
  const folders = proposal.folders
  const where = proposal.scope === 'device' ? `En ${proposal.rootLabel}` : proposal.rootLabel
  const detail = folders.length === 1
    ? `${where} · ${folders[0].relativePath} ya no tiene canciones, pero quedan ${remainingFilesLabel(folders[0])}. ¿Borrar la carpeta?`
    : `${where} · ${folderList(folders.map(folder => folder.relativePath))} ya no tienen canciones, pero quedan imágenes, playlists o letras. ¿Borrar las carpetas?`
  return {
    id: folderCleanupActivityId(proposal.id),
    category: proposal.scope === 'device' ? 'devices' : 'library',
    status: 'warning',
    title: folders.length === 1 ? 'Carpeta sin canciones' : `${folders.length} carpetas sin canciones`,
    detail,
    progress: null,
    metadata: {
      activityKind: 'folder-cleanup-proposal',
      folderCleanupId: proposal.id,
      deviceId: proposal.deviceId ?? undefined,
      folderId: proposal.folderId ?? undefined,
    },
    actionIds: ['confirm-folder-cleanup', 'keep-folder-cleanup'],
  }
}

export function activityFromFolderCleanupEvent(event: FolderCleanupEvent): ActivityUpsert {
  switch (event.kind) {
    case 'proposed':
      return activityFromFolderCleanupProposal(event.proposal)
    case 'removed': {
      const where = event.scope === 'device' ? `En ${event.rootLabel}` : event.rootLabel
      return {
        id: `folder-cleanup-removed:${event.id}`,
        category: event.scope === 'device' ? 'devices' : 'library',
        status: 'success',
        title: event.folders.length === 1
          ? 'Carpeta vacía borrada'
          : `${event.folders.length} carpetas vacías borradas`,
        detail: `${where} · ${folderList(event.folders)}`,
        progress: null,
        metadata: {
          activityKind: 'folder-cleanup-removed',
          deviceId: event.deviceId ?? undefined,
          folderId: event.folderId ?? undefined,
        },
        actionIds: [],
      }
    }
    case 'resolved':
      return {
        id: folderCleanupActivityId(event.proposalId),
        category: event.scope === 'device' ? 'devices' : 'library',
        status: event.resolution === 'deleted' ? 'success' : event.resolution === 'partial' ? 'warning' : 'info',
        title: event.resolution === 'deleted'
          ? 'Carpetas borradas'
          : event.resolution === 'partial'
            ? 'Carpetas borradas en parte'
            : event.resolution === 'expired' ? 'Consulta vencida' : 'Carpetas conservadas',
        detail: event.message,
        progress: null,
        metadata: { activityKind: 'folder-cleanup-proposal', folderCleanupId: event.proposalId },
        actionIds: [],
      }
    case 'device-trash-purged':
      return {
        id: `device-trash-purge:${event.id}`,
        category: 'devices',
        status: 'success',
        title: 'Papelera del dispositivo vaciada',
        detail: `${event.deviceName} · Se borraron definitivamente ${countLabel(event.files, 'archivo', 'archivos')} (${formatTrashBytes(event.bytes)}) que llevaban más de ${event.retentionDays} días en la papelera.`,
        progress: null,
        metadata: { activityKind: 'device-trash-purge', deviceId: event.deviceId },
        actionIds: [],
      }
  }
}

/**
 * Aligns persisted proposal activities with the proposals main still holds:
 * questions answered or expired while the app was closed lose their buttons,
 * and pending ones missing from the history are added back.
 */
export function reconcileFolderCleanupActivities(
  items: ActivityItem[],
  pending: readonly FolderCleanupProposal[],
  now = Date.now(),
): ActivityItem[] {
  const pendingIds = new Set(pending.map(proposal => proposal.id))
  let next = items.map(item => {
    if (item.metadata.activityKind !== 'folder-cleanup-proposal' || item.actionIds.length === 0) return item
    const id = item.metadata.folderCleanupId
    if (typeof id === 'string' && pendingIds.has(id)) return item
    return {
      ...item,
      status: 'info' as ActivityStatus,
      title: 'Consulta vencida',
      detail: 'Esta consulta ya no está disponible; no se borró nada.',
      actionIds: [],
      updatedAt: now,
    }
  })
  for (const proposal of pending) {
    if (next.some(item => item.id === folderCleanupActivityId(proposal.id))) continue
    next = upsertActivityItem(next, activityFromFolderCleanupProposal(proposal), Date.parse(proposal.createdAt) || now)
  }
  return pruneActivityItems(next)
}

function recordFolderCleanupPending(pending: FolderCleanupProposal[]): void {
  useActivityCenterStore.setState(state => {
    const items = reconcileFolderCleanupActivities(state.items, pending)
    persistActivityCenterState({ items, pinned: state.pinned })
    return { items }
  })
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
  // A late renderer subscription can recover the visible startup pass from the
  // summary. Running background maintenance remains silent.
  if (!shouldShowDuplicateSummaryActivity(summary)) return
  const activity = activityFromDuplicateSummary(summary)
  const store = useActivityCenterStore.getState()
  const previous = store.items.find(item => item.id === 'duplicates:pending')
  if (activity) {
    store.upsert({
      ...activity,
      read: duplicateSummaryReadState(previous, activity),
    })
  } else if (previous?.status !== 'success') {
    store.remove('duplicates:pending')
  }
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
    if (shouldShowLibraryActivity(event)) {
      useActivityCenterStore.getState().upsert(activityFromImportProgress(event))
    }
  })
  const offImportComplete = window.api.library.onImportComplete(event => {
    if (shouldShowLibraryActivity(event)) {
      useActivityCenterStore.getState().upsert(activityFromImportComplete(event))
    }
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
  const offUpdates = window.api.updates.onStateChanged(state => {
    recordUpdateState(state)
  })
  const offDuplicatesChanged = window.api.duplicates.onChanged(refreshDuplicateActivity)
  const offDuplicatesProgress = window.api.duplicates.onProgress(event => {
    if (shouldShowDuplicateProgressActivity(event)) {
      useActivityCenterStore.getState().upsert(activityFromDuplicateProgress(event))
    }
  })
  const offFolderCleanup = window.api.folderCleanup.onEvent(event => {
    useActivityCenterStore.getState().upsert(activityFromFolderCleanupEvent(event))
  })

  void window.api.devices.volumes().then(recordVolumeSnapshot).catch(() => undefined)
  void window.api.updates.getState().then(state => {
    recordUpdateState(state)
  }).catch(() => undefined)
  refreshDuplicateActivity()
  void window.api.folderCleanup.pending().then(recordFolderCleanupPending).catch(() => undefined)

  activityListenerCleanups = [
    offImportProgress,
    offImportComplete,
    offLyrics,
    offScan,
    offSync,
    offArtwork,
    offVolumes,
    offUpdates,
    offDuplicatesChanged,
    offDuplicatesProgress,
    offFolderCleanup,
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
