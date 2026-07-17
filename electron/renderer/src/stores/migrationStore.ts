import { create } from 'zustand'
import type {
  CreateLibraryMigrationRequest,
  LibraryMigrationProgressEvent,
  LibraryMigrationState,
} from '@shared/types/library-locations'
import { activityProgress, useActivityCenterStore, type ActivityStatus } from './activityCenterStore'

interface MigrationStoreState {
  runs: LibraryMigrationState[]
  initialized: boolean
  loading: boolean
  error: string | null
  load(): Promise<void>
  subscribe(): () => void
  create(input: CreateLibraryMigrationRequest): Promise<LibraryMigrationState>
  approve(runId: string): Promise<void>
  pause(runId: string): Promise<void>
  resume(runId: string): Promise<void>
  cancel(runId: string): Promise<void>
  retryCleanup(runId: string): Promise<void>
  clearError(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function upsert(runs: LibraryMigrationState[], run: LibraryMigrationState): LibraryMigrationState[] {
  return [run, ...runs.filter(candidate => candidate.runId !== run.runId)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function activityStatus(status: LibraryMigrationState['status']): ActivityStatus {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'cleanup_pending' || status === 'awaiting_approval' || status === 'paused') return 'waiting'
  if (status === 'cancelled') return 'info'
  return 'running'
}

function activityTitle(status: LibraryMigrationState['status']): string {
  if (status === 'awaiting_approval') return 'Migración lista para revisar'
  if (status === 'cleanup_pending') return 'Migración con limpieza pendiente'
  if (status === 'completed') return 'Biblioteca migrada'
  if (status === 'failed') return 'Migración interrumpida'
  if (status === 'paused') return 'Migración pausada'
  if (status === 'cancelled') return 'Migración cancelada'
  return 'Migrando biblioteca'
}

function syncActivity(run: LibraryMigrationState): void {
  useActivityCenterStore.getState().upsert({
    id: `library-migration:${run.runId}`,
    category: 'library',
    status: activityStatus(run.status),
    title: activityTitle(run.status),
    detail: run.cleanupError ?? run.error ?? `${run.phase} · ${run.targetName}`,
    progress: activityProgress(run.completedActions, run.totalActions),
    metadata: {
      activityKind: 'library-migration',
      folderId: run.targetFolderId ?? run.sourceFolderId,
      runId: run.runId,
    },
    actionIds: ['open-libraries'],
  })
}

async function invoke(
  operation: () => Promise<LibraryMigrationState>,
  set: (partial: Partial<MigrationStoreState> | ((state: MigrationStoreState) => Partial<MigrationStoreState>)) => void,
): Promise<LibraryMigrationState> {
  try {
    const run = await operation()
    set(state => ({ runs: upsert(state.runs, run), error: null }))
    syncActivity(run)
    return run
  } catch (error) {
    set({ error: errorMessage(error) })
    throw error
  }
}

export const useMigrationStore = create<MigrationStoreState>((set, get) => ({
  runs: [],
  initialized: false,
  loading: false,
  error: null,

  async load() {
    set({ loading: true, error: null })
    try {
      const runs = await window.api.libraryMigrations.list()
      runs.forEach(syncActivity)
      set({ runs, initialized: true, loading: false })
    } catch (error) {
      set({ initialized: true, loading: false, error: errorMessage(error) })
    }
  },

  subscribe() {
    return window.api.libraryMigrations.onProgress((event: LibraryMigrationProgressEvent) => {
      const current = get().runs.find(run => run.runId === event.runId)
      if (current) {
        const next: LibraryMigrationState = {
          ...current,
          status: event.status,
          phase: event.phase,
          completedActions: event.completedActions,
          totalActions: event.totalActions,
          completedBytes: event.completedBytes,
          totalBytes: event.totalBytes,
          relativePath: event.relativePath ?? null,
          updatedAt: new Date().toISOString(),
        }
        set(state => ({ runs: upsert(state.runs, next) }))
        syncActivity(next)
      }
      if (['completed', 'failed', 'cleanup_pending', 'awaiting_approval', 'paused', 'cancelled'].includes(event.status)) {
        void get().load()
      }
    })
  },

  create(input) {
    return invoke(() => window.api.libraryMigrations.create(input), set)
  },
  async approve(runId) { await invoke(() => window.api.libraryMigrations.approve(runId), set) },
  async pause(runId) { await invoke(() => window.api.libraryMigrations.pause(runId), set) },
  async resume(runId) { await invoke(() => window.api.libraryMigrations.resume(runId), set) },
  async cancel(runId) { await invoke(() => window.api.libraryMigrations.cancel(runId), set) },
  async retryCleanup(runId) { await invoke(() => window.api.libraryMigrations.retryCleanup(runId), set) },
  clearError() { set({ error: null }) },
}))
