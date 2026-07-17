import { create } from 'zustand'
import type { LibraryBackupsApi } from '@shared/types/ipc-contract'
import { useLibraryLocationsStore } from './libraryLocationsStore'
import { activityProgress, useActivityCenterStore, type ActivityStatus } from './activityCenterStore'

export type BackupRunStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'error'
  | 'offline'

export interface BackupPlanEntry {
  path: string
  action: 'create' | 'update' | 'delete' | 'conflict'
  reason: string | null
}

export interface BackupPlanSummary {
  runId: string | null
  creates: number
  updates: number
  deletes: number
  conflicts: number
  totalBytes: number | null
  entries: BackupPlanEntry[]
}

export interface BackupProgressEvent {
  backupFolderId: number
  sourceFolderId: number | null
  runId: string | null
  status: BackupRunStatus
  phase: string | null
  currentPath: string | null
  completedFiles: number
  totalFiles: number
  transferredBytes: number
  totalBytes: number | null
  error: string | null
  plan: BackupPlanSummary | null
}

export interface LibraryBackupState extends BackupProgressEvent {
  lastRunAt: string | number | null
}

interface BackupStoreState {
  backups: LibraryBackupState[]
  loading: boolean
  busyFolderId: number | null
  busyAction: string | null
  error: string | null
  load(): Promise<void>
  assign(sourceFolderId: number, backupFolderId: number): Promise<void>
  unlink(backupFolderId: number): Promise<void>
  promote(backupFolderId: number): Promise<void>
  start(backupFolderId: number): Promise<void>
  pause(backupFolderId: number): Promise<void>
  resume(backupFolderId: number): Promise<void>
  approveDiff(backupFolderId: number, runId: string): Promise<void>
  clearError(): void
}

function backupsApi(): LibraryBackupsApi {
  return window.api.libraryBackups
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function numberValue(record: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return fallback
}

function nullableNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  const value = numberValue(record, Number.NaN, ...keys)
  return Number.isFinite(value) ? value : null
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function statusValue(record: Record<string, unknown>): BackupRunStatus {
  const raw = stringValue(record, 'status', 'runStatus', 'run_status')
  switch (raw) {
    case 'planning':
    case 'running':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'error':
    case 'offline':
      return raw
    case 'pending':
      return 'planning'
    case 'awaiting-approval':
    case 'awaiting_approval':
    case 'diverged':
    case 'conflict':
      return 'awaiting_approval'
    default:
      return 'idle'
  }
}

function normalizePlan(raw: unknown, fallbackRunId: string | null): BackupPlanSummary | null {
  if (raw == null) return null
  const value = asRecord(raw)
  const rawEntries = Array.isArray(value.entries)
    ? value.entries
    : Array.isArray(value.changes) ? value.changes : []
  const entries = rawEntries.map(item => {
    const row = asRecord(item)
    const rawAction = stringValue(row, 'action', 'kind')
    const action: BackupPlanEntry['action'] = rawAction === 'update' || rawAction === 'delete' || rawAction === 'conflict'
      ? rawAction
      : 'create'
    return {
      path: stringValue(row, 'path', 'relativePath', 'relative_path') ?? 'Archivo sin nombre',
      action,
      reason: stringValue(row, 'reason', 'detail'),
    }
  })
  const hasDetailedEntries = entries.length > 0
  return {
    runId: stringValue(value, 'runId', 'run_id') ?? fallbackRunId,
    creates: hasDetailedEntries
      ? entries.filter(item => item.action === 'create').length
      : numberValue(value, 0, 'creates', 'createCount', 'create_count', 'filesToCopy', 'files_to_copy')
        + numberValue(value, 0, 'directoriesToCreate', 'directories_to_create'),
    updates: hasDetailedEntries
      ? entries.filter(item => item.action === 'update').length
      : numberValue(value, 0, 'updates', 'updateCount', 'update_count'),
    deletes: hasDetailedEntries
      ? entries.filter(item => item.action === 'delete').length
      : numberValue(value, 0, 'deletes', 'deleteCount', 'delete_count', 'filesToDelete', 'files_to_delete')
        + numberValue(value, 0, 'directoriesToDelete', 'directories_to_delete'),
    conflicts: numberValue(value, entries.filter(item => item.action === 'conflict').length, 'conflicts', 'conflictCount', 'conflict_count', 'divergenceCount', 'divergence_count'),
    totalBytes: nullableNumber(value, 'totalBytes', 'total_bytes', 'bytesToCopy', 'bytes_to_copy'),
    entries,
  }
}

function normalizeBackup(raw: unknown): LibraryBackupState {
  const value = asRecord(raw)
  const runId = stringValue(value, 'runId', 'run_id')
  const nestedProgress = asRecord(value.progress)
  const merged = { ...value, ...nestedProgress }
  const nestedPlan = value.plan ?? nestedProgress.plan ?? value.pendingPlan ?? value.pending_plan
  const normalizedStatus = statusValue(merged)
  return {
    backupFolderId: numberValue(value, 0, 'backupFolderId', 'backup_folder_id', 'folderId', 'folder_id'),
    sourceFolderId: nullableNumber(value, 'sourceFolderId', 'source_folder_id', 'backupSourceFolderId', 'backup_source_folder_id'),
    runId: stringValue(merged, 'runId', 'run_id') ?? runId,
    status: normalizedStatus,
    phase: stringValue(merged, 'phase'),
    currentPath: stringValue(merged, 'currentPath', 'current_path', 'relativePath', 'relative_path'),
    completedFiles: numberValue(merged, 0, 'completedFiles', 'completed_files', 'completedActions', 'completed_actions'),
    totalFiles: numberValue(merged, 0, 'totalFiles', 'total_files', 'totalActions', 'total_actions'),
    transferredBytes: numberValue(merged, 0, 'transferredBytes', 'transferred_bytes', 'completedBytes', 'completed_bytes'),
    totalBytes: nullableNumber(merged, 'totalBytes', 'total_bytes'),
    error: normalizedStatus === 'failed' || normalizedStatus === 'error' || normalizedStatus === 'offline'
      ? stringValue(merged, 'error', 'errorMessage', 'error_message', 'message')
      : stringValue(merged, 'error', 'errorMessage', 'error_message'),
    plan: normalizePlan(nestedPlan, runId),
    lastRunAt: stringValue(value, 'lastRunAt', 'last_run_at') ?? nullableNumber(value, 'lastRunAt', 'last_run_at'),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mergeBackup(list: LibraryBackupState[], next: LibraryBackupState): LibraryBackupState[] {
  const existing = list.find(item => item.backupFolderId === next.backupFolderId)
  if (!existing) return [next, ...list]
  return list.map(item => item.backupFolderId === next.backupFolderId
    ? {
        ...item,
        ...next,
        sourceFolderId: next.sourceFolderId ?? item.sourceFolderId,
        // Progress events intentionally stay compact and do not include the
        // persisted plan. Keep it only while both payloads describe the same
        // run; otherwise an awaiting-approval event could expose (and approve)
        // the diff from an older completed run.
        plan: next.plan ?? (next.runId === item.runId ? item.plan : null),
        lastRunAt: next.lastRunAt ?? item.lastRunAt,
      }
    : item)
}

async function refreshBackupsFromMain(): Promise<void> {
  const backups = (await backupsApi().list()).map(normalizeBackup)
  useBackupStore.setState({ backups })
  backups.forEach(recordBackupActivity)
}

function activityStatusForBackup(status: BackupRunStatus): ActivityStatus {
  switch (status) {
    case 'planning':
    case 'running':
      return 'running'
    case 'awaiting_approval':
    case 'paused':
      return 'waiting'
    case 'completed':
      return 'success'
    case 'failed':
    case 'error':
      return 'error'
    case 'offline':
      return 'warning'
    default:
      return 'info'
  }
}

function recordBackupActivity(backup: LibraryBackupState): void {
  if (backup.backupFolderId <= 0 || backup.status === 'idle') return
  const destination = useLibraryLocationsStore.getState().locations.find(item => item.id === backup.backupFolderId)
  const source = useLibraryLocationsStore.getState().locations.find(item => item.id === backup.sourceFolderId)
  const title = source ? `Backup de ${source.name}` : 'Backup de biblioteca'
  const destinationDetail = destination ? ` → ${destination.name}` : ''
  const detail = backup.error
    ?? backup.currentPath
    ?? (backup.status === 'awaiting_approval'
      ? 'El destino cambió. Revisá el lote antes de continuar.'
      : `${backup.phase ?? backup.status}${destinationDetail}`)
  const progress = backup.totalFiles > 0
    ? activityProgress(backup.completedFiles, backup.totalFiles)
    : backup.totalBytes != null && backup.totalBytes > 0
      ? activityProgress(backup.transferredBytes, backup.totalBytes)
      : null
  useActivityCenterStore.getState().upsert({
    id: `library-backup:${backup.backupFolderId}`,
    category: 'library',
    status: activityStatusForBackup(backup.status),
    title,
    detail,
    progress,
    metadata: {
      activityKind: 'library-backup',
      folderId: backup.backupFolderId,
      sourceFolderId: backup.sourceFolderId,
      runId: backup.runId,
    },
    actionIds: ['open-libraries'],
  })
}

export const useBackupStore = create<BackupStoreState>((set) => {
  const run = async (
    action: string,
    backupFolderId: number,
    operation: (api: LibraryBackupsApi) => Promise<unknown>,
    refreshLocations = false,
  ): Promise<void> => {
    set({ busyFolderId: backupFolderId, busyAction: action, error: null })
    try {
      const result = await operation(backupsApi())
      if (result != null) {
        const normalized = normalizeBackup(result)
        if (normalized.backupFolderId > 0) {
          set(state => ({ backups: mergeBackup(state.backups, normalized) }))
          recordBackupActivity(normalized)
        }
      }
      const rawBackups = await backupsApi().list()
      const nextBackups = rawBackups.map(normalizeBackup)
      set({ backups: nextBackups, busyFolderId: null, busyAction: null })
      nextBackups.forEach(recordBackupActivity)
      if (refreshLocations) await useLibraryLocationsStore.getState().load()
    } catch (error) {
      set({ busyFolderId: null, busyAction: null, error: errorMessage(error) })
      throw error
    }
  }

  return {
    backups: [],
    loading: false,
    busyFolderId: null,
    busyAction: null,
    error: null,

    async load() {
      set({ loading: true, error: null })
      try {
        const backups = (await backupsApi().list()).map(normalizeBackup)
        set({ backups, loading: false })
        backups.forEach(recordBackupActivity)
      } catch (error) {
        set({ loading: false, error: errorMessage(error) })
      }
    },

    assign(sourceFolderId, backupFolderId) {
      return run('assign', backupFolderId, api => api.assign({ sourceFolderId, backupFolderId }), true)
    },

    unlink(backupFolderId) {
      return run('unlink', backupFolderId, async api => {
        await api.remove(backupFolderId)
        return null
      }, true)
    },

    promote(backupFolderId) {
      return run('promote', backupFolderId, api => api.promote(backupFolderId), true)
    },

    start(backupFolderId) {
      return run('start', backupFolderId, api => api.start(backupFolderId))
    },

    pause(backupFolderId) {
      return run('pause', backupFolderId, api => api.pause(backupFolderId))
    },

    resume(backupFolderId) {
      return run('resume', backupFolderId, api => api.resume(backupFolderId))
    },

    approveDiff(backupFolderId, runId) {
      return run('approve', backupFolderId, api => api.approveDiff(backupFolderId, runId))
    },

    clearError() {
      set({ error: null })
    },
  }
})

if (typeof window !== 'undefined') {
  const api = window.api?.libraryBackups
  if (api?.onProgress) {
    const offProgress = api.onProgress(raw => {
      const progress = normalizeBackup(raw)
      if (progress.backupFolderId <= 0) return
      useBackupStore.setState(state => ({ backups: mergeBackup(state.backups, progress) }))
      recordBackupActivity(progress)
      // Awaiting approval needs the journal-backed entries and final states
      // need their authoritative timestamps/errors. Fetch once at these state
      // boundaries instead of bloating every byte-progress event.
      if (['awaiting_approval', 'paused', 'completed', 'failed', 'error'].includes(progress.status)) {
        void refreshBackupsFromMain().catch(error => {
          useBackupStore.setState({ error: errorMessage(error) })
        })
      }
    })
    import.meta.hot?.dispose(offProgress)
  }
}
