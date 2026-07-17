import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbFolder, DbLibraryMirrorRun } from '@shared/types/db'
import type {
  BackupPlanSummary,
  BackupProgressEvent,
  BackupProgressPhase,
  BackupTrigger,
} from '@shared/types/library-locations'
import { LocalMirrorAdapter } from './LocalMirrorAdapter.ts'
import { MirrorJournalRepository, type StoredMirrorAction } from './MirrorJournalRepository.ts'
import { entriesHaveSameContent, planMirror } from './planner.ts'
import {
  MirrorPreconditionError,
  MirrorRootUnavailableError,
  type MirrorAdapter,
  type MirrorEntry,
  type MirrorInventory,
  type MirrorPlan,
  type MirrorPlannedAction,
} from './types.ts'
import { assertLibraryLocationMigrationUnlocked } from '../library-migration/locationLocks.ts'

export interface LibraryMirrorServiceOptions {
  db: BetterSqliteDatabase
  adapters?: readonly MirrorAdapter[]
}

export interface SyncMirrorOptions {
  trigger?: BackupTrigger
  signal?: AbortSignal
}

export type BackupProgressListener = (event: BackupProgressEvent) => void

interface SyncOperation {
  controller: AbortController
  promise: Promise<BackupPlanSummary>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function skippedSymlinks(prefix: string, warnings: readonly { code: string; relativePath: string }[]): string[] {
  return warnings
    .filter(warning => warning.code === 'symlink_skipped')
    .map(warning => `${prefix}:${warning.relativePath}`)
}

function sameEntry(left: MirrorEntry | null, right: MirrorEntry | null): boolean {
  if (!left || !right) return left === right
  return left.relativePath === right.relativePath
    && left.kind === right.kind
    && left.size === right.size
    && left.modifiedAtMs === right.modifiedAtMs
    && left.sha256 === right.sha256
    && left.quickXorHash === right.quickXorHash
    && left.etag === right.etag
    && (left.providerItemId ?? null) === (right.providerItemId ?? null)
}

/** A persisted plan is authoritative only while every still-pending action is
 * exactly the action produced by a fresh three-way inventory. Completed
 * actions are intentionally omitted: after pause/restart their paths should
 * already be equal and therefore absent from a fresh plan. */
function pendingPlanMatches(
  persisted: readonly StoredMirrorAction[],
  fresh: readonly MirrorPlannedAction[],
): boolean {
  const pending = persisted.filter(action => action.status !== 'completed')
  return pending.length === fresh.length && pending.every((action, index) => {
    const candidate = fresh[index]
    return candidate !== undefined
      && action.kind === candidate.kind
      && action.relative_path === candidate.relativePath
      && action.bytes_total === candidate.bytesTotal
      && action.phase === candidate.phase
      && sameEntry(action.source, candidate.source)
      && sameEntry(action.destinationBefore, candidate.destinationBefore)
  })
}

export class LibraryMirrorService {
  private readonly db: BetterSqliteDatabase
  private readonly journal: MirrorJournalRepository
  private readonly adapters = new Map<MirrorAdapter['provider'], MirrorAdapter>()
  private readonly listeners = new Set<BackupProgressListener>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly inFlight = new Map<string, Promise<BackupPlanSummary>>()
  private readonly syncOperations = new Map<number, SyncOperation>()
  private readonly suspending = new Set<string>()

  constructor(options: LibraryMirrorServiceOptions) {
    this.db = options.db
    for (const adapter of options.adapters ?? [new LocalMirrorAdapter()]) {
      if (this.adapters.has(adapter.provider)) throw new Error(`Duplicate mirror adapter: ${adapter.provider}`)
      this.adapters.set(adapter.provider, adapter)
    }
    this.journal = new MirrorJournalRepository(options.db)
  }

  onProgress(listener: BackupProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listBackups(): DbFolder[] {
    return this.db.prepare<unknown[], DbFolder>(`
      SELECT * FROM folders WHERE role = 'backup' ORDER BY date_added ASC
    `).all()
  }

  getRun(runId: string): DbLibraryMirrorRun | undefined {
    return this.journal.getRun(runId)
  }

  getRunSummary(runId: string): BackupPlanSummary | null {
    const run = this.journal.getRun(runId)
    const summary = this.journal.getPlanSummary(runId)
    return run && summary ? { ...summary, status: run.status } : null
  }

  getLatestSummary(backupFolderId: number): BackupPlanSummary | null {
    const run = this.journal.getLatestRun(backupFolderId)
    return run ? this.getRunSummary(run.id) : null
  }

  getDivergences(runId: string) {
    return this.journal.getDivergences(runId)
  }

  sync(backupFolderId: number, options: SyncMirrorOptions = {}): Promise<BackupPlanSummary> {
    assertLibraryLocationMigrationUnlocked(backupFolderId, 'el mirror de backup', this.db)
    const linked = this.db.prepare<[number], { backup_source_folder_id: number | null }>(`
      SELECT backup_source_folder_id FROM folders WHERE id = ?
    `).get(backupFolderId)
    if (linked?.backup_source_folder_id != null) {
      assertLibraryLocationMigrationUnlocked(linked.backup_source_folder_id, 'el mirror de backup', this.db)
    }
    const existing = this.syncOperations.get(backupFolderId)
    if (existing) return existing.promise

    const controller = new AbortController()
    const abortFromExternal = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abortFromExternal, { once: true })
    if (options.signal?.aborted) abortFromExternal()
    const promise = this.performSync(backupFolderId, {
      ...options,
      signal: controller.signal,
    }).finally(() => {
      options.signal?.removeEventListener('abort', abortFromExternal)
      const current = this.syncOperations.get(backupFolderId)
      if (current?.promise === promise) this.syncOperations.delete(backupFolderId)
    })
    this.syncOperations.set(backupFolderId, { controller, promise })
    return promise
  }

  async waitForLocationIdle(folderId: number): Promise<void> {
    const relatedBackupIds = this.db.prepare<[number, number], { id: number }>(`
      SELECT id FROM folders
      WHERE id = ? OR (role = 'backup' AND backup_source_folder_id = ?)
    `).all(folderId, folderId).map(row => row.id)
    const operations = relatedBackupIds
      .map(id => this.syncOperations.get(id)?.promise)
      .filter((promise): promise is Promise<BackupPlanSummary> => promise != null)
    if (operations.length > 0) await Promise.allSettled(operations)
  }

  private async performSync(backupFolderId: number, options: SyncMirrorOptions): Promise<BackupPlanSummary> {
    const active = this.journal.getActiveRun(backupFolderId)
    if (active) {
      const running = this.inFlight.get(active.id)
      if (running) return running
      const summary = this.getRunSummary(active.id)
      if (active.status === 'awaiting_approval') {
        if (!summary) throw new Error(`Mirror run ${active.id} has no persisted plan.`)
        if (options.trigger === 'source_change' || options.trigger === 'cloud_delta') {
          return this.refreshAwaitingRun(active, options.signal)
        }
        return summary
      }
      if (active.status === 'paused') {
        if (!summary) throw new Error(`Mirror run ${active.id} has no persisted plan.`)
        return summary
      }
      if ((active.status === 'pending' || active.status === 'running') && summary) {
        if (active.status === 'running') this.journal.setRunStatus(active.id, 'pending')
        return this.startExecution(active.id, options.signal)
      }
      // A process exit during inventory leaves no resumable actions. Retire it
      // and build a fresh plan from both live roots.
      this.journal.setRunStatus(active.id, 'failed', 'Interrupted while planning; a fresh inventory is required.')
    }

    const latest = this.journal.getLatestRun(backupFolderId)
    if (
      latest?.status === 'failed'
      && latest.source_root_identity
      && latest.backup_root_identity
      && this.journal.listActions(latest.id).length > 0
    ) {
      const recoverable = this.getRunSummary(latest.id)
      if (recoverable) return recoverable
    }

    const backup = this.requireFolder(backupFolderId)
    if (backup.role !== 'backup' || backup.backup_source_folder_id === null) {
      throw new Error(`Folder ${backupFolderId} is not an assigned backup location.`)
    }
    const source = this.requireFolder(backup.backup_source_folder_id)
    if (source.role !== 'library') throw new Error('Backup source is no longer a library location.')
    this.assertSupportedPair(source, backup)

    const run = this.journal.createRun({
      sourceFolderId: source.id,
      backupFolderId: backup.id,
      trigger: options.trigger ?? 'manual',
    })
    this.journal.savePlan(run.id, {
      runId: run.id,
      sourceFolderId: source.id,
      backupFolderId: backup.id,
      status: 'planning',
      filesToCopy: 0,
      directoriesToCreate: 0,
      filesToDelete: 0,
      directoriesToDelete: 0,
      bytesToCopy: 0,
      divergenceCount: 0,
      skippedSymlinks: [],
      warnings: [],
    }, [], [])
    this.emit(run, 'planning', [], undefined, 'Inventariando biblioteca y destino.')

    try {
      const sourceAdapter = this.requireAdapter(source)
      const backupAdapter = this.requireAdapter(backup)
      const [sourceInventory, destinationInventory] = await Promise.all([
        sourceAdapter.inventory(source, options.signal),
        backupAdapter.inventory(backup, options.signal),
      ])
      this.assertSnapshotRootIdentities(backup.id, sourceInventory, destinationInventory)
      const snapshot = this.journal.loadSnapshot(backup.id)
      const plan = planMirror({
        source: sourceInventory.entries,
        destination: destinationInventory.entries,
        snapshot,
        hasBaseline: this.journal.hasSnapshotBaseline(backup.id),
        sourceProvider: source.provider,
        backupProvider: backup.provider,
      })
      const status = plan.divergences.length > 0 ? 'awaiting_approval' : 'pending'
      const summary = this.buildPlanSummary(run, sourceInventory, destinationInventory, plan, status)
      this.journal.savePlan(run.id, summary, plan.actions, plan.divergences, {
        sourceRootIdentity: sourceInventory.rootIdentity,
        backupRootIdentity: destinationInventory.rootIdentity,
      })
      if (status === 'awaiting_approval') {
        this.emit(this.journal.getRun(run.id)!, 'awaiting_approval', this.journal.listActions(run.id), undefined,
          'El destino fue modificado fuera de Crate; el lote completo requiere aprobación.')
        return summary
      }
      return this.startExecution(run.id, options.signal)
    } catch (error) {
      const stoppedStatus = this.journal.getRun(run.id)?.status
      if (stoppedStatus === 'cancelled' && isAbortError(error)) {
        const summary = this.getRunSummary(run.id)
        return summary ? { ...summary, status: 'cancelled' } : {
          runId: run.id,
          sourceFolderId: source.id,
          backupFolderId: backup.id,
          status: 'cancelled',
          filesToCopy: 0,
          directoriesToCreate: 0,
          filesToDelete: 0,
          directoriesToDelete: 0,
          bytesToCopy: 0,
          divergenceCount: 0,
          skippedSymlinks: [],
          warnings: [],
        }
      }
      this.journal.setRunStatus(run.id, 'failed', message(error))
      this.emit(this.journal.getRun(run.id)!, 'error', [], undefined, message(error))
      throw error
    }
  }

  async syncAll(trigger: BackupTrigger = 'startup'): Promise<PromiseSettledResult<BackupPlanSummary>[]> {
    const results: PromiseSettledResult<BackupPlanSummary>[] = []
    for (const backup of this.listBackups()) {
      const [result] = await Promise.allSettled([this.sync(backup.id, { trigger })])
      results.push(result)
    }
    return results
  }

  async approve(runId: string, signal?: AbortSignal): Promise<BackupPlanSummary> {
    this.journal.approve(runId)
    return this.startExecution(runId, signal)
  }

  pause(runId: string): BackupPlanSummary {
    const run = this.journal.getRun(runId)
    const summary = this.journal.getPlanSummary(runId)
    if (!run || !summary) throw new Error(`Mirror run ${runId} does not exist.`)
    if (!['pending', 'running'].includes(run.status)) throw new Error(`Mirror run ${runId} cannot be paused from ${run.status}.`)
    this.journal.setRunStatus(runId, 'paused')
    this.controllers.get(runId)?.abort(new DOMException('Mirror paused', 'AbortError'))
    const paused = { ...summary, status: 'paused' as const }
    this.emit(this.journal.getRun(runId)!, 'paused', this.journal.listActions(runId), undefined, 'Backup pausado.')
    return paused
  }

  async resume(runId: string, signal?: AbortSignal): Promise<BackupPlanSummary> {
    const run = this.journal.getRun(runId)
    if (!run || (run.status !== 'paused' && run.status !== 'failed')) {
      throw new Error(`Mirror run ${runId} is not paused or recoverable.`)
    }
    this.journal.resetIncompleteActions(runId)
    this.journal.setRunStatus(runId, 'pending')
    return this.startExecution(runId, signal)
  }

  async resumePending(): Promise<PromiseSettledResult<BackupPlanSummary>[]> {
    const results: PromiseSettledResult<BackupPlanSummary>[] = []
    for (const run of this.journal.listResumableRuns()) {
      if (run.status === 'running') {
        this.journal.resetIncompleteActions(run.id)
        this.journal.setRunStatus(run.id, 'pending')
      }
      const [result] = await Promise.allSettled([this.startExecution(run.id)])
      results.push(result)
    }
    return results
  }

  /** Stops provider I/O before SQLite closes while preserving enough journal
   * state to continue the same upload/action on the next launch. */
  async dispose(): Promise<void> {
    for (const operation of this.syncOperations.values()) {
      operation.controller.abort(new DOMException('Application shutdown', 'AbortError'))
    }
    for (const [runId, controller] of this.controllers) {
      this.suspending.add(runId)
      controller.abort(new DOMException('Application shutdown', 'AbortError'))
    }
    await Promise.allSettled([
      ...new Set([
        ...[...this.syncOperations.values()].map(operation => operation.promise),
        ...this.inFlight.values(),
      ]),
    ])
  }

  /** Stops any active transfer before severing the relationship. Files are
   * never removed; the former destination becomes a normal library ready for
   * the import/indexing pipeline. */
  async unlinkBackup(backupFolderId: number): Promise<DbFolder> {
    await this.cancelActiveRun(backupFolderId)
    const unlink = this.db.transaction(() => {
      const backup = this.requireFolder(backupFolderId)
      if (backup.role !== 'backup') return backup
      this.db.prepare(`DELETE FROM library_mirror_snapshots WHERE backup_folder_id = ?`).run(backupFolderId)
      this.db.prepare(`DELETE FROM library_mirror_state WHERE backup_folder_id = ?`).run(backupFolderId)
      this.db.prepare(`DELETE FROM library_mirror_runs WHERE backup_folder_id = ?`).run(backupFolderId)
      this.db.prepare(`
        UPDATE folders
        SET role = 'library', backup_source_folder_id = NULL, date_updated = ?
        WHERE id = ?
      `).run(new Date().toISOString(), backupFolderId)
      return this.requireFolder(backupFolderId)
    })
    return unlink.immediate()
  }

  async promoteBackup(backupFolderId: number): Promise<DbFolder> {
    return this.unlinkBackup(backupFolderId)
  }

  private startExecution(runId: string, externalSignal?: AbortSignal): Promise<BackupPlanSummary> {
    const existing = this.inFlight.get(runId)
    if (existing) return existing
    const promise = this.execute(runId, externalSignal).finally(() => {
      this.inFlight.delete(runId)
      this.controllers.delete(runId)
    })
    this.inFlight.set(runId, promise)
    return promise
  }

  private async cancelActiveRun(backupFolderId: number): Promise<void> {
    const run = this.journal.getActiveRun(backupFolderId)
    if (run) this.journal.setRunStatus(run.id, 'cancelled')
    const reason = new DOMException('Backup relationship removed', 'AbortError')
    this.syncOperations.get(backupFolderId)?.controller.abort(reason)
    if (run) this.controllers.get(run.id)?.abort(reason)
    await Promise.allSettled([
      ...(this.syncOperations.get(backupFolderId)?.promise ? [this.syncOperations.get(backupFolderId)!.promise] : []),
      ...(run && this.inFlight.get(run.id) ? [this.inFlight.get(run.id)!] : []),
    ])
  }

  private async execute(
    runId: string,
    externalSignal?: AbortSignal,
    replanDepth = 0,
  ): Promise<BackupPlanSummary> {
    const run = this.journal.getRun(runId)
    const summary = this.journal.getPlanSummary(runId)
    if (!run || !summary) throw new Error(`Mirror run ${runId} has no persisted plan.`)
    if (!['pending', 'running'].includes(run.status)) throw new Error(`Mirror run ${runId} cannot execute from ${run.status}.`)
    const source = this.requireFolder(run.source_folder_id)
    const backup = this.requireFolder(run.backup_folder_id)
    if (backup.role !== 'backup' || backup.backup_source_folder_id !== source.id) {
      throw new Error('The backup relationship changed before this run could execute.')
    }
    this.assertSupportedPair(source, backup)

    const controller = new AbortController()
    this.controllers.set(runId, controller)
    const abortFromExternal = (): void => controller.abort(externalSignal?.reason)
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
    if (externalSignal?.aborted) abortFromExternal()

    const sourceAdapter = this.requireAdapter(source)
    const backupAdapter = this.requireAdapter(backup)
    let current: StoredMirrorAction | undefined

    try {
      const [plannedSourceInventory, plannedDestinationInventory] = await Promise.all([
        sourceAdapter.inventory(source, controller.signal),
        backupAdapter.inventory(backup, controller.signal),
      ])
      this.assertRunRootIdentities(run, plannedSourceInventory, plannedDestinationInventory)
      const persistedActions = this.journal.listActions(runId)
      const freshPlan = planMirror({
        source: plannedSourceInventory.entries,
        destination: plannedDestinationInventory.entries,
        snapshot: this.journal.loadSnapshot(backup.id),
        hasBaseline: this.journal.hasSnapshotBaseline(backup.id),
        sourceProvider: source.provider,
        backupProvider: backup.provider,
      })
      if (!pendingPlanMatches(persistedActions, freshPlan.actions)) {
        const status = freshPlan.divergences.length > 0 ? 'awaiting_approval' : 'pending'
        const refreshed = this.buildPlanSummary(
          run,
          plannedSourceInventory,
          plannedDestinationInventory,
          freshPlan,
          status,
        )
        this.journal.savePlan(run.id, refreshed, freshPlan.actions, freshPlan.divergences, {
          sourceRootIdentity: plannedSourceInventory.rootIdentity,
          backupRootIdentity: plannedDestinationInventory.rootIdentity,
        })
        if (status === 'awaiting_approval') {
          this.emit(
            this.journal.getRun(run.id)!,
            'awaiting_approval',
            this.journal.listActions(run.id),
            undefined,
            'El destino cambió antes de ejecutar; el lote completo fue recalculado sin modificar archivos.',
          )
          return refreshed
        }
        if (replanDepth >= 2) {
          throw new Error('The source changed repeatedly while preparing the mirror plan; no destination actions were applied.')
        }
        return this.execute(runId, externalSignal, replanDepth + 1)
      }

      const actions = persistedActions
      this.journal.setRunStatus(runId, 'running')
      for (const action of actions) {
        if (action.status === 'completed') continue
        controller.signal.throwIfAborted()
        current = action
        this.journal.setActionRunning(action.id)
        this.emit(this.journal.getRun(runId)!, this.phaseFor(action), this.journal.listActions(runId), action.relative_path)

        if (action.kind === 'create_directory') {
          await backupAdapter.createDirectory(backup, action.relative_path, controller.signal)
        } else if (action.kind === 'copy_file') {
          if (!action.source || action.source.kind !== 'file') throw new Error(`Missing source metadata for ${action.relative_path}.`)
          const chunks = sourceAdapter.readFile(source, action.source, controller.signal)
          let currentBytes = action.bytes_completed
          await backupAdapter.writeFile({
            location: backup,
            relativePath: action.relative_path,
            source: chunks,
            expectedSource: action.source,
            destinationBefore: action.destinationBefore,
            resumeState: action.resumeState,
            signal: controller.signal,
            onProgress: bytes => {
              currentBytes = bytes
              this.journal.setActionProgress(action.id, bytes)
              this.emit(this.journal.getRun(runId)!, 'copying', this.journal.listActions(runId), action.relative_path)
            },
            onResumeState: state => this.journal.setActionProgress(action.id, currentBytes, state),
          })
        } else {
          await backupAdapter.deleteEntry({
            location: backup,
            relativePath: action.relative_path,
            kind: action.kind === 'delete_directory' ? 'directory' : 'file',
            destinationBefore: action.destinationBefore,
            recursive: action.kind === 'delete_directory',
            signal: controller.signal,
          })
        }
        this.journal.setActionCompleted(action.id)
        current = undefined
      }

      this.emit(this.journal.getRun(runId)!, 'verifying', this.journal.listActions(runId), undefined, 'Verificando inventario final.')
      const [sourceInventory, destinationInventory] = await Promise.all([
        sourceAdapter.inventory(source, controller.signal),
        backupAdapter.inventory(backup, controller.signal),
      ])
      this.assertRunRootIdentities(run, sourceInventory, destinationInventory)
      this.assertMirrored(sourceInventory.entries, destinationInventory.entries, source.provider, backup.provider)
      this.journal.replaceSnapshot(
        backup.id,
        runId,
        sourceInventory.entries,
        destinationInventory.entries,
        sourceInventory.rootIdentity,
        destinationInventory.rootIdentity,
      )
      this.journal.setRunStatus(runId, 'completed')
      this.emit(this.journal.getRun(runId)!, 'done', this.journal.listActions(runId), undefined, 'Backup verificado.')
      return { ...summary, status: 'completed' }
    } catch (error) {
      if (this.suspending.delete(runId) && isAbortError(error)) {
        if (current) this.journal.setActionStopped(current.id, 'paused', null)
        this.journal.resetIncompleteActions(runId)
        this.journal.setRunStatus(runId, 'pending')
        return { ...summary, status: 'pending' }
      }
      const stoppedStatus = this.journal.getRun(runId)?.status
      const stopped = stoppedStatus === 'paused' || stoppedStatus === 'cancelled'
      if (!stopped && error instanceof MirrorPreconditionError) {
        try {
          const replanned = await this.replanDivergence(
            this.journal.getRun(runId) ?? run,
            source,
            backup,
            sourceAdapter,
            backupAdapter,
            controller.signal,
          )
          if (replanned.status === 'pending' && replanDepth < 2) {
            return this.execute(runId, externalSignal, replanDepth + 1)
          }
          return replanned
        } catch (replanError) {
          error = replanError
        }
      }
      if (current) this.journal.setActionStopped(current.id, stopped ? 'paused' : 'failed', message(error))
      if (!stopped) this.journal.setRunStatus(runId, 'failed', message(error))
      const updatedRun = this.journal.getRun(runId)
      if (updatedRun) {
        this.emit(updatedRun, stopped ? 'paused' : 'error', this.journal.listActions(runId), current?.relative_path, message(error))
      }
      if (stopped && isAbortError(error)) return { ...summary, status: stoppedStatus }
      throw error
    } finally {
      externalSignal?.removeEventListener('abort', abortFromExternal)
    }
  }

  private buildPlanSummary(
    run: DbLibraryMirrorRun,
    sourceInventory: MirrorInventory,
    destinationInventory: MirrorInventory,
    plan: MirrorPlan,
    status: 'pending' | 'awaiting_approval',
  ): BackupPlanSummary {
    return {
      runId: run.id,
      sourceFolderId: run.source_folder_id,
      backupFolderId: run.backup_folder_id,
      status,
      filesToCopy: plan.actions.filter(action => action.kind === 'copy_file').length,
      directoriesToCreate: plan.actions.filter(action => action.kind === 'create_directory').length,
      filesToDelete: plan.actions.filter(action => action.kind === 'delete_file').length,
      directoriesToDelete: plan.actions.filter(action => action.kind === 'delete_directory').length,
      bytesToCopy: plan.actions.reduce((sum, action) => sum + action.bytesTotal, 0),
      divergenceCount: plan.divergences.length,
      skippedSymlinks: [
        ...skippedSymlinks('source', sourceInventory.warnings),
        ...skippedSymlinks('backup', destinationInventory.warnings),
      ],
      warnings: [
        ...sourceInventory.warnings.map(warning => `source:${warning.relativePath}: ${warning.message}`),
        ...destinationInventory.warnings.map(warning => `backup:${warning.relativePath}: ${warning.message}`),
      ],
    }
  }

  private assertSnapshotRootIdentities(
    backupFolderId: number,
    sourceInventory: MirrorInventory,
    destinationInventory: MirrorInventory,
  ): void {
    const baseline = this.journal.getRootIdentities(backupFolderId)
    if (!baseline) return
    if (baseline.sourceRootIdentity !== sourceInventory.rootIdentity) {
      throw new MirrorRootUnavailableError(
        'The source root identity changed since the last verified backup. The run was stopped without deleting anything.',
      )
    }
    if (baseline.backupRootIdentity !== destinationInventory.rootIdentity) {
      throw new MirrorRootUnavailableError(
        'The backup root identity changed since the last verified backup. The run was stopped without deleting anything.',
      )
    }
  }

  private assertRunRootIdentities(
    run: DbLibraryMirrorRun,
    sourceInventory: MirrorInventory,
    destinationInventory: MirrorInventory,
  ): void {
    if (!run.source_root_identity || !run.backup_root_identity) {
      throw new MirrorRootUnavailableError(`Mirror run ${run.id} has no persisted root identities.`)
    }
    if (run.source_root_identity !== sourceInventory.rootIdentity) {
      throw new MirrorRootUnavailableError(
        'The source root changed after this mirror plan was created. The persisted actions were not applied.',
      )
    }
    if (run.backup_root_identity !== destinationInventory.rootIdentity) {
      throw new MirrorRootUnavailableError(
        'The backup root changed after this mirror plan was created. The persisted actions were not applied.',
      )
    }
    this.assertSnapshotRootIdentities(run.backup_folder_id, sourceInventory, destinationInventory)
  }

  private async replanDivergence(
    run: DbLibraryMirrorRun,
    source: DbFolder,
    backup: DbFolder,
    sourceAdapter: MirrorAdapter,
    backupAdapter: MirrorAdapter,
    signal: AbortSignal,
  ): Promise<BackupPlanSummary> {
    const [sourceInventory, destinationInventory] = await Promise.all([
      sourceAdapter.inventory(source, signal),
      backupAdapter.inventory(backup, signal),
    ])
    this.assertRunRootIdentities(run, sourceInventory, destinationInventory)
    const plan = planMirror({
      source: sourceInventory.entries,
      destination: destinationInventory.entries,
      snapshot: this.journal.loadSnapshot(backup.id),
      hasBaseline: this.journal.hasSnapshotBaseline(backup.id),
      sourceProvider: source.provider,
      backupProvider: backup.provider,
    })
    const status = plan.divergences.length > 0 ? 'awaiting_approval' : 'pending'
    const summary = this.buildPlanSummary(run, sourceInventory, destinationInventory, plan, status)
    this.journal.savePlan(run.id, summary, plan.actions, plan.divergences, {
      sourceRootIdentity: sourceInventory.rootIdentity,
      backupRootIdentity: destinationInventory.rootIdentity,
    })
    if (status === 'awaiting_approval') {
      this.emit(
        this.journal.getRun(run.id)!,
        'awaiting_approval',
        this.journal.listActions(run.id),
        undefined,
        'El destino cambió durante la ejecución; el lote completo fue recalculado y requiere aprobación.',
      )
    }
    return summary
  }

  private async refreshAwaitingRun(run: DbLibraryMirrorRun, signal?: AbortSignal): Promise<BackupPlanSummary> {
    const source = this.requireFolder(run.source_folder_id)
    const backup = this.requireFolder(run.backup_folder_id)
    if (source.role !== 'library' || backup.role !== 'backup' || backup.backup_source_folder_id !== source.id) {
      throw new Error('The backup relationship changed while its divergence was awaiting approval.')
    }
    this.assertSupportedPair(source, backup)
    const sourceAdapter = this.requireAdapter(source)
    const backupAdapter = this.requireAdapter(backup)
    const [sourceInventory, destinationInventory] = await Promise.all([
      sourceAdapter.inventory(source, signal),
      backupAdapter.inventory(backup, signal),
    ])
    this.assertRunRootIdentities(run, sourceInventory, destinationInventory)
    const plan = planMirror({
      source: sourceInventory.entries,
      destination: destinationInventory.entries,
      snapshot: this.journal.loadSnapshot(backup.id),
      hasBaseline: this.journal.hasSnapshotBaseline(backup.id),
      sourceProvider: source.provider,
      backupProvider: backup.provider,
    })
    const status = plan.divergences.length > 0 ? 'awaiting_approval' : 'pending'
    const summary = this.buildPlanSummary(run, sourceInventory, destinationInventory, plan, status)
    this.journal.savePlan(run.id, summary, plan.actions, plan.divergences, {
      sourceRootIdentity: sourceInventory.rootIdentity,
      backupRootIdentity: destinationInventory.rootIdentity,
    })
    if (status === 'awaiting_approval') {
      this.emit(
        this.journal.getRun(run.id)!,
        'awaiting_approval',
        this.journal.listActions(run.id),
        undefined,
        'El lote divergente fue actualizado con los cambios más recientes.',
      )
      return summary
    }
    return this.startExecution(run.id, signal)
  }

  private requireFolder(folderId: number): DbFolder {
    const folder = this.db.prepare<[number], DbFolder>(`SELECT * FROM folders WHERE id = ?`).get(folderId)
    if (!folder) throw new Error(`Library location ${folderId} does not exist.`)
    return folder
  }

  private requireAdapter(folder: DbFolder): MirrorAdapter {
    const adapter = this.adapters.get(folder.provider)
    if (!adapter) throw new Error(`No mirror adapter is registered for ${folder.provider}.`)
    return adapter
  }

  private assertSupportedPair(source: DbFolder, backup: DbFolder): void {
    this.requireAdapter(source)
    this.requireAdapter(backup)
  }

  private assertMirrored(
    sourceEntries: readonly MirrorEntry[],
    destinationEntries: readonly MirrorEntry[],
    sourceProvider: DbFolder['provider'],
    backupProvider: DbFolder['provider'],
  ): void {
    const source = new Map(sourceEntries.map(entry => [entry.relativePath, entry]))
    const destination = new Map(destinationEntries.map(entry => [entry.relativePath, entry]))
    const paths = new Set([...source.keys(), ...destination.keys()])
    for (const path of paths) {
      if (!entriesHaveSameContent(source.get(path), destination.get(path), sourceProvider, backupProvider)) {
        throw new Error(`Final backup verification failed at ${path}.`)
      }
    }
  }

  private phaseFor(action: StoredMirrorAction): BackupProgressPhase {
    if (action.kind === 'create_directory') return 'creating_directories'
    if (action.kind === 'copy_file') return 'copying'
    return 'deleting'
  }

  private emit(
    run: DbLibraryMirrorRun,
    phase: BackupProgressPhase,
    actions: readonly StoredMirrorAction[],
    relativePath?: string,
    eventMessage?: string,
  ): void {
    const event: BackupProgressEvent = {
      runId: run.id,
      sourceFolderId: run.source_folder_id,
      backupFolderId: run.backup_folder_id,
      status: run.status,
      phase,
      completedActions: actions.filter(action => action.status === 'completed').length,
      totalActions: actions.length,
      completedBytes: actions.reduce((sum, action) => sum + action.bytes_completed, 0),
      totalBytes: actions.reduce((sum, action) => sum + action.bytes_total, 0),
      relativePath,
      message: eventMessage,
    }
    for (const listener of this.listeners) listener(event)
  }
}
