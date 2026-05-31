import type {
  AppUpdateProgress,
  AppUpdateState,
  AppUpdateStatus,
} from '@shared/types/ipc-contract'

export interface UpdateInfoLike {
  version?: string | null
  releaseName?: string | null
  releaseDate?: string | null
  releaseNotes?: unknown
}

export type UpdateStateEvent =
  | { type: 'checking'; now: number }
  | { type: 'available'; info: UpdateInfoLike; now: number }
  | { type: 'not-available'; info: UpdateInfoLike; now: number }
  | { type: 'downloading'; progress: Partial<AppUpdateProgress> }
  | { type: 'downloaded'; info: UpdateInfoLike; now: number }
  | { type: 'error'; error: unknown; now: number }

const BUSY_STATUSES = new Set<AppUpdateStatus>(['checking', 'downloading'])

export function createInitialUpdateState(currentVersion: string, supported: boolean, reason?: string): AppUpdateState {
  return withCapabilities({
    currentVersion,
    status: supported ? 'idle' : 'unsupported',
    updateVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progress: null,
    error: supported ? null : (reason ?? 'Las actualizaciones solo están disponibles en builds empaquetadas.'),
    lastCheckedAt: null,
    canCheck: false,
    canDownload: false,
    canInstall: false,
  })
}

export function reduceUpdateState(state: AppUpdateState, event: UpdateStateEvent): AppUpdateState {
  switch (event.type) {
    case 'checking':
      return withCapabilities({
        ...state,
        status: 'checking',
        progress: null,
        error: null,
      })
    case 'available':
      return withCapabilities({
        ...state,
        ...normalizeUpdateInfo(event.info),
        status: 'available',
        progress: null,
        error: null,
        lastCheckedAt: event.now,
      })
    case 'not-available':
      return withCapabilities({
        ...state,
        ...normalizeUpdateInfo(event.info),
        status: 'not-available',
        progress: null,
        error: null,
        lastCheckedAt: event.now,
      })
    case 'downloading':
      return withCapabilities({
        ...state,
        status: 'downloading',
        progress: normalizeProgress(event.progress),
        error: null,
      })
    case 'downloaded':
      return withCapabilities({
        ...state,
        ...normalizeUpdateInfo(event.info),
        status: 'downloaded',
        progress: {
          ...(state.progress ?? { bytesPerSecond: 0, transferred: 0, total: 0 }),
          percent: 100,
        },
        error: null,
        lastCheckedAt: event.now,
      })
    case 'error':
      return withCapabilities({
        ...state,
        status: 'error',
        progress: null,
        error: formatUpdateError(event.error),
        lastCheckedAt: event.now,
      })
  }
}

export function normalizeUpdateInfo(info: UpdateInfoLike): Pick<AppUpdateState, 'updateVersion' | 'releaseName' | 'releaseDate' | 'releaseNotes'> {
  return {
    updateVersion: cleanString(info.version),
    releaseName: cleanString(info.releaseName),
    releaseDate: cleanString(info.releaseDate),
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  }
}

export function normalizeReleaseNotes(value: unknown): string | null {
  if (typeof value === 'string') return trimToNull(value)
  if (!Array.isArray(value)) return null

  const text = value
    .map(item => {
      if (!item || typeof item !== 'object') return ''
      const row = item as { version?: unknown; note?: unknown }
      const version = typeof row.version === 'string' ? row.version.trim() : ''
      const note = typeof row.note === 'string' ? row.note.trim() : ''
      if (!version && !note) return ''
      return version && note ? `${version}\n${note}` : (version || note)
    })
    .filter(Boolean)
    .join('\n\n')

  return trimToNull(text)
}

export function formatUpdateError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'No se pudo completar la operación de actualización.'
}

function withCapabilities(state: AppUpdateState): AppUpdateState {
  const supported = state.status !== 'unsupported'
  return {
    ...state,
    canCheck: supported && !BUSY_STATUSES.has(state.status),
    canDownload: supported && state.status === 'available',
    canInstall: supported && state.status === 'downloaded',
  }
}

function normalizeProgress(progress: Partial<AppUpdateProgress>): AppUpdateProgress {
  return {
    percent: clamp(finiteNumber(progress.percent), 0, 100),
    bytesPerSecond: finiteNumber(progress.bytesPerSecond),
    transferred: finiteNumber(progress.transferred),
    total: finiteNumber(progress.total),
  }
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function cleanString(value: string | null | undefined): string | null {
  return typeof value === 'string' ? trimToNull(value) : null
}

function trimToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
