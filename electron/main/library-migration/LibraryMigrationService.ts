import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, posix, relative, resolve } from 'node:path'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type {
  DbFolder,
  DbLibraryMigrationRun,
  DbTrack,
} from '@shared/types/db'
import type {
  LibraryMigrationPlanSummary,
  LibraryMigrationProgressEvent,
  LibraryMigrationState,
  LibraryProvider,
  UnifiedBackupChoice,
} from '@shared/types/library-locations'
import type { OneDriveClient } from '../cloud/OneDriveClient.ts'
import { cloudRelativePath } from '../cloud/cloudPortableManifest.ts'
import { entriesHaveSameContent } from '../library-mirror/planner.ts'
import type { MirrorAdapter, MirrorEntry, MirrorInventory } from '../library-mirror/types.ts'
import { MigrationJournalRepository, type StoredMigrationEntry } from './MigrationJournalRepository.ts'
import { planLibraryMigration } from './planner.ts'

export interface ResolvedMigrationTarget {
  folder: DbFolder
  existingFolderId: number | null
}

export type ResolvedUnifiedBackup =
  | { kind: 'none' }
  | { kind: 'existing'; folderId: number }
  | { kind: 'new'; folder: DbFolder }

export interface CreateResolvedMigrationRequest {
  sourceFolderId: number
  mode: 'relocate' | 'merge'
  target: ResolvedMigrationTarget
  sourceDisposition: 'keep' | 'trash'
  unifiedBackup?: ResolvedUnifiedBackup
  targetDisplayName?: string
}

export interface LibraryMigrationServiceOptions {
  db: BetterSqliteDatabase
  adapters: readonly MirrorAdapter[]
  oneDriveClient?: OneDriveClient
  trashLocalRoot?: (path: string) => Promise<void>
  suspendLocations?: (folders: readonly DbFolder[]) => Promise<void>
  restoreLocations?: (folderIds: readonly number[]) => Promise<void> | void
  onCommitted?: (run: DbLibraryMigrationRun, resultingFolderId: number) => Promise<void> | void
}

export type LibraryMigrationProgressListener = (event: LibraryMigrationProgressEvent) => void

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function comparableLocalPath(value: string): string {
  const path = resolve(value).normalize('NFC')
  return process.platform === 'darwin' || process.platform === 'win32'
    ? path.toLocaleLowerCase('en-US')
    : path
}

function normalizedRemotePath(value: string): string {
  return posix.normalize(value.startsWith('/') ? value : `/${value}`)
    .normalize('NFC')
    .toLocaleLowerCase('en-US')
}

function locationsOverlap(left: DbFolder, right: DbFolder): boolean {
  if (left.provider !== right.provider) return false
  if (left.provider === 'local') {
    const a = comparableLocalPath(left.path)
    const b = comparableLocalPath(right.path)
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  }
  if (!left.drive_id || left.drive_id !== right.drive_id || !left.remote_path || !right.remote_path) return false
  const a = normalizedRemotePath(left.remote_path)
  const b = normalizedRemotePath(right.remote_path)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function temporaryFolderId(runId: string): number {
  const numeric = Number.parseInt(runId.replaceAll('-', '').slice(0, 8), 16)
  return -(Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 1)
}

function withTemporaryId(folder: DbFolder, runId: string): DbFolder {
  return { ...folder, id: temporaryFolderId(runId) }
}

function sourceFolderFromRun(run: DbLibraryMigrationRun): DbFolder {
  return {
    id: run.source_folder_id,
    name: run.source_name,
    path: run.source_path,
    track_count: 0,
    date_added: run.created_at,
    date_updated: run.updated_at,
    bookmark_data: null,
    provider: run.source_provider,
    role: run.source_role,
    backup_source_folder_id: null,
    account_id: run.source_account_id,
    drive_id: run.source_drive_id,
    item_id: run.source_item_id,
    remote_path: run.source_remote_path,
    delta_cursor: null,
    display_icon: null,
  }
}

function targetFolderFromRun(run: DbLibraryMigrationRun): DbFolder {
  return {
    id: run.target_folder_id ?? temporaryFolderId(run.id),
    name: run.target_name,
    path: run.target_path,
    track_count: 0,
    date_added: run.created_at,
    date_updated: run.updated_at,
    bookmark_data: null,
    provider: run.target_provider,
    role: 'library',
    backup_source_folder_id: null,
    account_id: run.target_account_id,
    drive_id: run.target_drive_id,
    item_id: run.target_item_id,
    remote_path: run.target_remote_path,
    delta_cursor: null,
    display_icon: null,
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  return JSON.parse(value) as T
}

function relativeTrackPath(folder: DbFolder, track: DbTrack): string | null {
  if (folder.provider === 'local') {
    if (!isAbsolute(folder.path) || !isAbsolute(track.path)) return null
    const value = relative(resolve(folder.path), resolve(track.path)).replaceAll('\\', '/')
    if (!value || value.startsWith('../') || value === '..' || value.startsWith('/')) return null
    return value
  }
  if (!folder.remote_path || !track.remote_path) return null
  return cloudRelativePath(folder.remote_path, track.remote_path)
}

function remoteDestinationPath(root: string | null, relativePath: string): string {
  const base = normalizedRemotePath(root ?? '/')
  return posix.join(base, relativePath)
}

function localDestinationPath(root: string, relativePath: string): string {
  return resolve(root, ...relativePath.split('/'))
}

function storedLocationMatches(folder: DbFolder, run: DbLibraryMigrationRun, side: 'source' | 'target'): boolean {
  if (side === 'source') {
    return folder.id === run.source_folder_id
      && folder.provider === run.source_provider
      && folder.path === run.source_path
      && folder.account_id === run.source_account_id
      && folder.drive_id === run.source_drive_id
      && folder.item_id === run.source_item_id
      && folder.remote_path === run.source_remote_path
      && folder.role === run.source_role
  }
  return folder.id === run.target_folder_id
    && folder.provider === run.target_provider
    && folder.path === run.target_path
    && folder.account_id === run.target_account_id
    && folder.drive_id === run.target_drive_id
    && folder.item_id === run.target_item_id
    && folder.remote_path === run.target_remote_path
    && folder.role === 'library'
}

export class LibraryMigrationService {
  private readonly db: BetterSqliteDatabase
  private readonly journal: MigrationJournalRepository
  private readonly adapters = new Map<LibraryProvider, MirrorAdapter>()
  private readonly listeners = new Set<LibraryMigrationProgressListener>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly options: LibraryMigrationServiceOptions

  constructor(options: LibraryMigrationServiceOptions) {
    this.options = options
    this.db = options.db
    this.journal = new MigrationJournalRepository(options.db)
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.provider)) throw new Error(`Duplicate migration adapter: ${adapter.provider}`)
      this.adapters.set(adapter.provider, adapter)
    }
  }

  onProgress(listener: LibraryMigrationProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): LibraryMigrationState[] {
    return this.journal.listRuns().map(run => this.journal.state(run.id))
  }

  get(runId: string): LibraryMigrationState {
    return this.journal.state(runId)
  }

  getConflicts(runId: string) {
    return this.journal.conflicts(runId)
  }

  async waitForIdle(runId: string): Promise<LibraryMigrationState> {
    const pending = this.inFlight.get(runId)
    if (pending) await pending
    return this.journal.state(runId)
  }

  async create(request: CreateResolvedMigrationRequest): Promise<LibraryMigrationState> {
    const source = this.requireFolder(request.sourceFolderId)
    this.validateRequest(source, request)
    const id = randomUUID()
    const targetName = request.targetDisplayName?.trim() || request.target.folder.name
    const target = withTemporaryId({ ...request.target.folder, name: targetName }, id)
    const unifiedBackup = request.unifiedBackup ?? { kind: 'none' as const }
    const run = this.journal.createRun({
      id,
      source,
      target,
      targetFolderId: request.target.existingFolderId,
      mode: request.mode,
      sourceDisposition: request.sourceDisposition,
      unifiedBackup: this.serializableBackupChoice(unifiedBackup),
    })
    await this.options.suspendLocations?.([
      source,
      ...(request.target.existingFolderId == null ? [] : [request.target.folder]),
    ])
    try {
      await this.plan(run.id)
      this.emit(run.id, 'La migración está lista para revisar.')
      return this.journal.state(run.id)
    } catch (error) {
      this.journal.setRunStatus(run.id, 'failed', 'planning', message(error))
      this.emit(run.id, message(error))
      throw error
    }
  }

  approve(runId: string): LibraryMigrationState {
    this.journal.approve(runId)
    this.startExecution(runId)
    return this.journal.state(runId)
  }

  pause(runId: string): LibraryMigrationState {
    const run = this.journal.requireRun(runId)
    if (!['transferring', 'publishing', 'committing'].includes(run.status)) {
      throw new Error(`La migración no se puede pausar desde ${run.status}.`)
    }
    if (run.status === 'committing') throw new Error('El commit transaccional no se puede pausar.')
    this.journal.setRunStatus(runId, 'paused', 'paused')
    this.controllers.get(runId)?.abort(new DOMException('Migration paused', 'AbortError'))
    this.emit(runId, 'Migración pausada.')
    return this.journal.state(runId)
  }

  resume(runId: string): LibraryMigrationState {
    const run = this.journal.requireRun(runId)
    if (!['paused', 'failed', 'planning'].includes(run.status)) {
      throw new Error(`La migración no se puede reanudar desde ${run.status}.`)
    }
    const entries = this.journal.listEntries(runId)
    if (entries.length === 0) {
      this.journal.setRunStatus(runId, 'planning', 'planning')
      this.startPlanning(runId)
    } else {
      this.journal.resetIncompleteEntries(runId)
      const nextStatus = entries.some(entry => entry.status === 'transferred') ? 'publishing' : 'transferring'
      this.journal.setRunStatus(runId, nextStatus, nextStatus)
      this.startExecution(runId)
    }
    return this.journal.state(runId)
  }

  cancel(runId: string): LibraryMigrationState {
    const run = this.journal.requireRun(runId)
    if (run.committed_at) throw new Error('Una migración ya confirmada no se puede cancelar.')
    if (['completed', 'cancelled', 'cleanup_pending'].includes(run.status)) {
      throw new Error(`La migración no se puede cancelar desde ${run.status}.`)
    }
    this.journal.setRunStatus(runId, 'cancelled', 'cancelled')
    this.journal.releaseLocks(runId)
    this.controllers.get(runId)?.abort(new DOMException('Migration cancelled', 'AbortError'))
    void this.restoreAfterTerminal(run)
    this.emit(runId, 'Migración cancelada; la fuente no fue modificada.')
    return this.journal.state(runId)
  }

  retryCleanup(runId: string): LibraryMigrationState {
    const run = this.journal.requireRun(runId)
    if (run.status !== 'cleanup_pending' || !run.committed_at) {
      throw new Error('La migración no tiene una limpieza pendiente.')
    }
    this.startCleanup(runId)
    return this.journal.state(runId)
  }

  async recover(): Promise<void> {
    for (const run of this.journal.listRecoverableRuns()) {
      const live = [this.getFolder(run.source_folder_id), run.target_folder_id == null ? null : this.getFolder(run.target_folder_id)]
        .filter((folder): folder is DbFolder => folder != null)
      await this.options.suspendLocations?.(live)
      if (run.status === 'planning') this.startPlanning(run.id)
      else if (run.status === 'cleanup_pending') this.startCleanup(run.id)
      else {
        this.journal.resetIncompleteEntries(run.id)
        this.startExecution(run.id)
      }
    }
  }

  async dispose(): Promise<void> {
    for (const controller of this.controllers.values()) {
      controller.abort(new DOMException('Application shutdown', 'AbortError'))
    }
    await Promise.allSettled(this.inFlight.values())
    this.listeners.clear()
  }

  private serializableBackupChoice(choice: ResolvedUnifiedBackup): UnifiedBackupChoice | Record<string, unknown> {
    if (choice.kind !== 'new') return choice
    return { kind: 'resolved-new', folder: choice.folder }
  }

  private validateRequest(source: DbFolder, request: CreateResolvedMigrationRequest): void {
    const target = request.target.folder
    this.requireAdapter(source.provider)
    this.requireAdapter(target.provider)
    if (source.role === 'backup' && request.mode !== 'relocate') {
      throw new Error('Los backups se pueden relocalizar, pero no fusionar.')
    }
    if (request.mode === 'merge') {
      if (request.target.existingFolderId == null || target.role !== 'library') {
        throw new Error('Una fusión requiere una biblioteca de destino registrada.')
      }
      if (source.role !== 'library') throw new Error('Solo una biblioteca normal se puede fusionar.')
    } else if (request.target.existingFolderId != null) {
      throw new Error('Una relocalización requiere una raíz nueva no registrada.')
    }
    if (source.id === request.target.existingFolderId) throw new Error('La fuente y el destino no pueden coincidir.')
    if (locationsOverlap(source, target)) throw new Error('La fuente y el destino no pueden coincidir ni solaparse.')
    for (const candidate of this.listFolders()) {
      if (candidate.id === source.id || candidate.id === request.target.existingFolderId) continue
      if (locationsOverlap(candidate, target)) {
        throw new Error(`El destino se solapa con “${candidate.name}”.`)
      }
    }
    const activeTarget = this.journal.listRuns()
      .filter(run => !['completed', 'cancelled'].includes(run.status))
      .map(targetFolderFromRun)
      .find(candidate => locationsOverlap(candidate, target))
    if (activeTarget) {
      throw new Error(`El destino ya está reservado por otra migración activa: “${activeTarget.name}”.`)
    }
    if (
      source.provider === 'onedrive'
      && target.provider === 'onedrive'
      && source.account_id !== target.account_id
    ) throw new Error('OneDrive→OneDrive solo está disponible dentro de la cuenta conectada.')
    if (request.unifiedBackup && request.unifiedBackup.kind !== 'none') {
      if (request.mode !== 'merge') throw new Error('El backup unificado solo se elige durante una fusión.')
      if (request.unifiedBackup.kind === 'existing') {
        const backup = this.requireFolder(request.unifiedBackup.folderId)
        const sourceBackup = this.db.prepare<[number], { id: number }>(`
          SELECT id FROM folders WHERE role = 'backup' AND backup_source_folder_id = ?
        `).get(source.id)?.id
        const targetBackup = request.target.existingFolderId == null ? null : this.db.prepare<[number], { id: number }>(`
          SELECT id FROM folders WHERE role = 'backup' AND backup_source_folder_id = ?
        `).get(request.target.existingFolderId)?.id
        if (backup.role !== 'backup' || ![sourceBackup, targetBackup].includes(backup.id)) {
          throw new Error('El backup unificado debe pertenecer a una de las bibliotecas fusionadas.')
        }
      } else {
        const backup = request.unifiedBackup.folder
        if (locationsOverlap(source, backup) || locationsOverlap(target, backup)) {
          throw new Error('El backup unificado no puede coincidir ni solaparse con la fuente o el destino.')
        }
        const overlap = this.listFolders().find(candidate => locationsOverlap(candidate, backup))
        if (overlap) throw new Error(`El backup unificado se solapa con “${overlap.name}”.`)
      }
    }
    if (request.sourceDisposition === 'trash' && this.isProtectedRoot(source)) {
      throw new Error('No se puede enviar a la papelera una raíz de volumen o de drive.')
    }
  }

  private async plan(runId: string): Promise<void> {
    const run = this.journal.requireRun(runId)
    const source = this.requireLiveSource(run)
    const target = this.requireLiveTarget(run)
    const sourceAdapter = this.requireAdapter(source.provider)
    const targetAdapter = this.requireAdapter(target.provider)
    const [sourceInventory, targetInventory] = await Promise.all([
      sourceAdapter.inventory(source),
      targetAdapter.inventory(target),
    ])
    const plan = planLibraryMigration({
      source: sourceInventory,
      target: targetInventory,
      sourceProvider: source.provider,
      targetProvider: target.provider,
      sourceName: source.name,
      mode: run.mode,
    })
    const sourceTrackIds = this.trackIdsByRelativePath(source)
    const canonicalTrackIds = run.target_folder_id == null
      ? new Map<string, number>()
      : this.trackIdsByRelativePath(target)
    const conflicts = plan.entries.flatMap(entry => entry.conflict == null ? [] : [{
      sourcePath: entry.sourceRelativePath,
      destinationPath: entry.destinationRelativePath,
      resolution: entry.conflict === 'identical' ? 'deduplicate' as const : 'rename' as const,
    }])
    const summary: LibraryMigrationPlanSummary = {
      runId,
      sourceFolderId: source.id,
      targetFolderId: run.target_folder_id,
      mode: run.mode,
      status: 'awaiting_approval',
      filesToTransfer: plan.entries.filter(entry => entry.kind === 'file' && entry.needsTransfer).length,
      directoriesToCreate: plan.entries.filter(entry => entry.kind === 'directory' && entry.needsTransfer).length,
      identicalFiles: plan.entries.filter(entry => entry.conflict === 'identical').length,
      renamedFiles: plan.entries.filter(entry => entry.conflict === 'renamed' && entry.kind === 'file').length,
      bytesToTransfer: plan.entries.reduce(
        (sum, entry) => sum + (entry.kind === 'file' && entry.needsTransfer ? entry.source.size : 0),
        0,
      ),
      warnings: plan.warnings,
      conflicts,
    }
    this.journal.savePlan({
      runId,
      sourceRootIdentity: sourceInventory.rootIdentity,
      targetRootIdentity: targetInventory.rootIdentity,
      summary,
      entries: plan.entries,
      sourceTrackIds,
      canonicalTrackIds,
    })
  }

  private startPlanning(runId: string): void {
    if (this.inFlight.has(runId)) return
    const promise = this.plan(runId).then(() => {
      this.emit(runId, 'La migración está lista para revisar.')
    }).catch(error => {
      this.journal.setRunStatus(runId, 'failed', 'planning', message(error))
      this.emit(runId, message(error))
    }).finally(() => {
      this.inFlight.delete(runId)
    })
    this.inFlight.set(runId, promise)
  }

  private startExecution(runId: string): void {
    if (this.inFlight.has(runId)) return
    const controller = new AbortController()
    this.controllers.set(runId, controller)
    const promise = this.performExecution(runId, controller.signal).catch(error => {
      const current = this.journal.requireRun(runId)
      if (isAbortError(error) && ['paused', 'cancelled'].includes(current.status)) return
      this.journal.setRunStatus(runId, 'failed', current.phase, message(error))
      this.emit(runId, message(error))
    }).finally(() => {
      this.controllers.delete(runId)
      this.inFlight.delete(runId)
    })
    this.inFlight.set(runId, promise)
  }

  private async performExecution(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.journal.requireRun(runId)
    const source = this.requireLiveSource(run)
    const target = this.requireLiveTarget(run)
    const sourceAdapter = this.requireAdapter(source.provider)
    const targetAdapter = this.requireAdapter(target.provider)
    let [sourceInventory, targetInventory] = await Promise.all([
      sourceAdapter.inventory(source, signal),
      targetAdapter.inventory(target, signal),
    ])
    this.assertRootIdentities(run, sourceInventory, targetInventory)
    this.assertSourcePlan(run, sourceInventory)
    this.assertTargetPreconditions(run, targetInventory)

    run = this.journal.requireRun(runId)
    if (run.status === 'transferring') {
      await this.transfer(run, source, target, sourceAdapter, targetAdapter, signal)
      this.journal.setRunStatus(runId, run.mode === 'merge' ? 'publishing' : 'committing', run.mode === 'merge' ? 'publishing' : 'verifying')
      this.emit(runId, run.mode === 'merge' ? 'Publicando archivos verificados.' : 'Verificando el destino.')
    }

    run = this.journal.requireRun(runId)
    if (run.status === 'publishing') {
      await this.publish(run, target, targetAdapter, signal)
      this.journal.setRunStatus(runId, 'committing', 'verifying')
      this.emit(runId, 'Verificando el catálogo antes del commit.')
    }

    run = this.journal.requireRun(runId)
    if (run.status === 'committing') {
      ;[sourceInventory, targetInventory] = await Promise.all([
        sourceAdapter.inventory(source, signal),
        targetAdapter.inventory(target, signal),
      ])
      this.assertRootIdentities(run, sourceInventory, targetInventory)
      this.assertSourcePlan(run, sourceInventory)
      this.assertPublished(run, targetInventory)
      const resultingFolderId = this.commit(run, target, targetInventory)
      if (run.source_disposition === 'trash') {
        this.journal.setRunStatus(runId, 'cleanup_pending', 'cleanup')
        this.journal.releaseLocks(runId)
        await this.options.onCommitted?.(this.journal.requireRun(runId), resultingFolderId)
        await this.restoreAfterTerminal(this.journal.requireRun(runId))
        await this.cleanupSource(runId, signal)
      } else {
        this.journal.setRunStatus(runId, 'completed', 'completed')
        this.journal.releaseLocks(runId)
        await this.options.onCommitted?.(this.journal.requireRun(runId), resultingFolderId)
        await this.restoreAfterTerminal(this.journal.requireRun(runId))
        this.emit(runId, 'Migración completada; la fuente original se conservó.')
      }
    }
  }

  private async transfer(
    run: DbLibraryMigrationRun,
    source: DbFolder,
    target: DbFolder,
    sourceAdapter: MirrorAdapter,
    targetAdapter: MirrorAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    const entries = this.journal.listEntries(run.id)
    if (run.mode === 'merge') {
      for (const directory of ['.crate', '.crate/migrations', `.crate/migrations/${run.id}`]) {
        await targetAdapter.createDirectory(target, directory, signal)
      }
    }
    for (const entry of entries.filter(item => item.kind === 'directory' && item.status === 'pending')) {
      signal.throwIfAborted()
      this.journal.setEntryStatus(entry.id, 'transferring')
      const destinationPath = run.mode === 'merge'
        ? `.crate/migrations/${run.id}/${entry.destination_relative_path}`
        : entry.destination_relative_path
      await targetAdapter.createDirectory(target, destinationPath, signal)
      if (run.mode === 'merge') {
        this.journal.setEntryStatus(entry.id, 'transferred')
      } else {
        this.journal.setEntryStatus(entry.id, 'published', { latestDestination: {
          ...entry.source,
          relativePath: entry.destination_relative_path,
        } })
      }
      this.emit(run.id)
    }
    for (const entry of this.journal.listEntries(run.id).filter(item => item.kind === 'file' && item.status === 'pending')) {
      signal.throwIfAborted()
      this.journal.setEntryStatus(entry.id, 'transferring')
      const destinationPath = run.mode === 'merge'
        ? `.crate/migrations/${run.id}/${entry.destination_relative_path}`
        : entry.destination_relative_path
      const result = await targetAdapter.writeFile({
        location: target,
        relativePath: destinationPath,
        source: sourceAdapter.readFile(source, entry.source, signal),
        expectedSource: entry.source,
        destinationBefore: null,
        resumeState: entry.resumeState,
        signal,
        onProgress: bytes => {
          this.journal.setEntryStatus(entry.id, 'transferring', { bytesCompleted: bytes })
          this.emit(run.id)
        },
        onResumeState: state => {
          this.journal.setEntryStatus(entry.id, 'transferring', { resumeState: state })
        },
      })
      this.journal.setEntryStatus(entry.id, run.mode === 'merge' ? 'transferred' : 'published', {
        bytesCompleted: entry.bytes_total,
        resumeState: null,
        latestDestination: result,
      })
      this.emit(run.id)
    }
  }

  private async publish(
    run: DbLibraryMigrationRun,
    target: DbFolder,
    targetAdapter: MirrorAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    if (!targetAdapter.moveEntry) throw new Error(`El adaptador ${target.provider} no admite publicación desde staging.`)
    const entries = this.journal.listEntries(run.id)
    for (const entry of entries.filter(item => item.kind === 'directory' && item.status === 'transferred')) {
      signal.throwIfAborted()
      await targetAdapter.createDirectory(target, entry.destination_relative_path, signal)
      this.journal.setEntryStatus(entry.id, 'published', {
        latestDestination: { ...entry.source, relativePath: entry.destination_relative_path },
      })
      this.emit(run.id)
    }
    for (const entry of this.journal.listEntries(run.id).filter(item => item.kind === 'file' && item.status === 'transferred')) {
      signal.throwIfAborted()
      if (!entry.latestDestination) throw new Error(`La transferencia de ${entry.source_relative_path} no dejó identidad de staging.`)
      this.journal.setEntryStatus(entry.id, 'publishing')
      const finalEntry = await targetAdapter.moveEntry({
        location: target,
        sourceRelativePath: `.crate/migrations/${run.id}/${entry.destination_relative_path}`,
        destinationRelativePath: entry.destination_relative_path,
        sourceBefore: entry.latestDestination,
        destinationBefore: entry.destinationBefore,
        signal,
      })
      this.journal.setEntryStatus(entry.id, 'published', {
        bytesCompleted: entry.bytes_total,
        latestDestination: finalEntry,
      })
      this.emit(run.id)
    }
  }

  private commit(run: DbLibraryMigrationRun, target: DbFolder, targetInventory: MirrorInventory): number {
    this.requireLiveSource(run)
    if (run.target_folder_id != null) this.requireLiveTarget(run)
    const targetEntries = new Map(targetInventory.entries.map(entry => [entry.relativePath, entry]))
    const commit = this.db.transaction(() => {
      if (run.mode === 'relocate') {
        this.commitRelocation(run, target, targetEntries)
        return run.source_folder_id
      }
      this.commitMerge(run, target, targetEntries)
      return run.target_folder_id!
    })
    return commit.immediate()
  }

  private commitRelocation(
    run: DbLibraryMigrationRun,
    target: DbFolder,
    targetEntries: ReadonlyMap<string, MirrorEntry>,
  ): void {
    for (const entry of this.journal.listEntries(run.id)) {
      if (entry.source_track_id == null) continue
      const destination = targetEntries.get(entry.destination_relative_path)
      if (!destination || destination.kind !== 'file') {
        throw new Error(`No se pudo mapear el track migrado ${entry.destination_relative_path}.`)
      }
      this.updateTrackLocation(entry.source_track_id, target, entry.destination_relative_path, destination, run.source_folder_id)
    }
    const result = this.db.prepare(`
      UPDATE folders
      SET name = ?, path = ?, provider = ?, account_id = ?, drive_id = ?,
          item_id = ?, remote_path = ?, delta_cursor = NULL, bookmark_data = NULL,
          date_updated = ?
      WHERE id = ? AND path = ? AND provider = ? AND role = ?
    `).run(
      run.target_name,
      run.target_path,
      run.target_provider,
      run.target_account_id,
      run.target_drive_id,
      run.target_item_id,
      run.target_remote_path,
      new Date().toISOString(),
      run.source_folder_id,
      run.source_path,
      run.source_provider,
      run.source_role,
    )
    if (result.changes !== 1) throw new Error('La ubicación fuente cambió antes del commit.')
    if (run.source_role === 'backup') {
      this.db.prepare(`
        UPDATE library_mirror_state SET backup_root_identity = ?, updated_at = ?
        WHERE backup_folder_id = ?
      `).run(run.target_root_identity, new Date().toISOString(), run.source_folder_id)
    }
  }

  private commitMerge(
    run: DbLibraryMigrationRun,
    target: DbFolder,
    targetEntries: ReadonlyMap<string, MirrorEntry>,
  ): void {
    if (run.target_folder_id == null) throw new Error('La fusión no tiene biblioteca destino.')
    this.db.prepare(`UPDATE folders SET name = ?, date_updated = ? WHERE id = ? AND role = 'library'`)
      .run(run.target_name, new Date().toISOString(), run.target_folder_id)
    const sourceTracks = this.db.prepare<[number], DbTrack>(`
      SELECT * FROM tracks WHERE folder_id = ? ORDER BY id
    `).all(run.source_folder_id)
    const mappings = new Map(
      this.journal.listEntries(run.id)
        .filter(entry => entry.source_track_id != null)
        .map(entry => [entry.source_track_id!, entry]),
    )
    if (mappings.size !== sourceTracks.length) {
      throw new Error('No todos los tracks fuente tienen un mapping verificado.')
    }
    for (const track of sourceTracks) {
      const entry = mappings.get(track.id)!
      if (entry.conflict === 'identical') {
        const canonicalId = entry.canonical_track_id ?? this.findCanonicalTrackId(target, entry.destination_relative_path)
        if (!canonicalId) throw new Error(`No existe el track canónico para ${entry.destination_relative_path}.`)
        this.mergeCanonicalTrack(track.id, canonicalId)
      } else {
        const destination = targetEntries.get(entry.destination_relative_path)
        if (!destination || destination.kind !== 'file') {
          throw new Error(`No se verificó el track publicado ${entry.destination_relative_path}.`)
        }
        this.updateTrackLocation(track.id, target, entry.destination_relative_path, destination, run.target_folder_id)
      }
    }
    this.applyUnifiedBackup(run, run.target_folder_id)
    const removed = this.db.prepare(`DELETE FROM folders WHERE id = ? AND role = 'library'`).run(run.source_folder_id)
    if (removed.changes !== 1) throw new Error('La biblioteca fuente cambió antes de cerrar la fusión.')
  }

  private updateTrackLocation(
    trackId: number,
    target: DbFolder,
    relativePath: string,
    entry: MirrorEntry,
    folderId: number,
  ): void {
    const itemId = target.provider === 'onedrive' ? entry.providerItemId : null
    if (target.provider === 'onedrive' && !itemId) {
      throw new Error(`OneDrive no devolvió identidad estable para ${relativePath}.`)
    }
    const trackPath = target.provider === 'local'
      ? localDestinationPath(target.path, relativePath)
      : `onedrive://${target.drive_id}/${itemId}`
    const result = this.db.prepare(`
      UPDATE tracks
      SET folder_id = ?, path = ?, filename = ?, provider = ?, drive_id = ?,
          item_id = ?, etag = ?, remote_path = ?, quickxor_hash = ?,
          file_size = ?, date_modified = ?
      WHERE id = ?
    `).run(
      folderId,
      trackPath,
      basename(relativePath),
      target.provider,
      target.provider === 'onedrive' ? target.drive_id : null,
      itemId,
      target.provider === 'onedrive' ? entry.etag : null,
      target.provider === 'onedrive' ? remoteDestinationPath(target.remote_path, relativePath) : null,
      target.provider === 'onedrive' ? entry.quickXorHash : null,
      entry.size,
      entry.modifiedAtMs == null ? null : new Date(entry.modifiedAtMs).toISOString(),
      trackId,
    )
    if (result.changes !== 1) throw new Error(`El track ${trackId} cambió durante el commit.`)
  }

  private mergeCanonicalTrack(sourceId: number, canonicalId: number): void {
    if (sourceId === canonicalId) return
    const source = this.db.prepare<[number], DbTrack>(`SELECT * FROM tracks WHERE id = ?`).get(sourceId)
    const canonical = this.db.prepare<[number], DbTrack>(`SELECT * FROM tracks WHERE id = ?`).get(canonicalId)
    if (!source || !canonical) throw new Error('El mapping canónico cambió durante el commit.')
    const sourceIsNewer = (source.state_updated_at ?? 0) > (canonical.state_updated_at ?? 0)
    this.db.prepare(`
      UPDATE tracks
      SET is_favorite = ?, rating = ?, state_updated_at = ?,
          play_count = MAX(play_count, ?),
          last_played_date = CASE
            WHEN last_played_date IS NULL THEN ?
            WHEN ? IS NULL THEN last_played_date
            WHEN ? > last_played_date THEN ?
            ELSE last_played_date END
      WHERE id = ?
    `).run(
      sourceIsNewer ? source.is_favorite : canonical.is_favorite,
      sourceIsNewer ? source.rating : canonical.rating,
      Math.max(source.state_updated_at ?? 0, canonical.state_updated_at ?? 0) || null,
      source.play_count,
      source.last_played_date,
      source.last_played_date,
      source.last_played_date,
      source.last_played_date,
      canonicalId,
    )
    this.db.prepare(`UPDATE playlist_tracks SET track_id = ? WHERE track_id = ?`).run(canonicalId, sourceId)
    this.db.prepare(`UPDATE queue SET track_id = ? WHERE track_id = ?`).run(canonicalId, sourceId)
    this.db.prepare(`UPDATE tracks SET primary_track_id = ? WHERE primary_track_id = ?`).run(canonicalId, sourceId)
    for (const table of ['song_features', 'playback_analysis_cache', 'playback_table_bars_cache']) {
      const canonicalPresent = this.db.prepare(`SELECT 1 FROM ${table} WHERE track_id = ?`).get(canonicalId)
      if (canonicalPresent) this.db.prepare(`DELETE FROM ${table} WHERE track_id = ?`).run(sourceId)
      else this.db.prepare(`UPDATE ${table} SET track_id = ? WHERE track_id = ?`).run(canonicalId, sourceId)
    }
    this.db.prepare(`UPDATE track_album_moves SET track_id = ? WHERE track_id = ?`).run(canonicalId, sourceId)
    this.db.prepare(`DELETE FROM tracks WHERE id = ?`).run(sourceId)
  }

  private applyUnifiedBackup(run: DbLibraryMigrationRun, targetFolderId: number): void {
    const choice = parseJson<Record<string, unknown>>(run.unified_backup_json, { kind: 'none' })
    const sourceBackup = this.db.prepare<[number], DbFolder>(`
      SELECT * FROM folders WHERE role = 'backup' AND backup_source_folder_id = ?
    `).get(run.source_folder_id)
    const targetBackup = this.db.prepare<[number], DbFolder>(`
      SELECT * FROM folders WHERE role = 'backup' AND backup_source_folder_id = ?
    `).get(targetFolderId)
    let selectedId: number | null = null
    if (choice.kind === 'existing' && typeof choice.folderId === 'number') selectedId = choice.folderId
    const candidates = [sourceBackup, targetBackup].filter((folder): folder is DbFolder => folder != null)
    if (selectedId != null && !candidates.some(folder => folder.id === selectedId) && choice.kind !== 'resolved-new') {
      throw new Error('El backup unificado elegido ya no pertenece a las bibliotecas fusionadas.')
    }
    // Remove unselected registrations first, otherwise the partial unique
    // index for one backup per base can reject reassignment of the winner.
    for (const backup of candidates) {
      this.clearMirrorJournal(backup.id)
      if (backup.id !== selectedId) {
        this.db.prepare(`DELETE FROM folders WHERE id = ? AND role = 'backup'`).run(backup.id)
      }
    }
    if (selectedId != null) {
      this.db.prepare(`
        UPDATE folders SET backup_source_folder_id = ?, date_updated = ? WHERE id = ? AND role = 'backup'
      `).run(targetFolderId, new Date().toISOString(), selectedId)
    }
    if (choice.kind === 'resolved-new' && choice.folder && typeof choice.folder === 'object') {
      const folder = choice.folder as DbFolder
      const timestamp = new Date().toISOString()
      const result = this.db.prepare(`
        INSERT INTO folders (
          name, path, track_count, date_added, date_updated, bookmark_data,
          provider, role, backup_source_folder_id, account_id, drive_id,
          item_id, remote_path, delta_cursor, display_icon
        ) VALUES (?, ?, 0, ?, ?, NULL, ?, 'backup', ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        folder.name,
        folder.path,
        timestamp,
        timestamp,
        folder.provider,
        targetFolderId,
        folder.account_id,
        folder.drive_id,
        folder.item_id,
        folder.remote_path,
        folder.display_icon,
      )
      selectedId = Number(result.lastInsertRowid)
    }
  }

  private clearMirrorJournal(backupFolderId: number): void {
    this.db.prepare(`DELETE FROM library_mirror_snapshots WHERE backup_folder_id = ?`).run(backupFolderId)
    this.db.prepare(`DELETE FROM library_mirror_state WHERE backup_folder_id = ?`).run(backupFolderId)
    this.db.prepare(`DELETE FROM library_mirror_runs WHERE backup_folder_id = ?`).run(backupFolderId)
  }

  private assertRootIdentities(
    run: DbLibraryMigrationRun,
    source: MirrorInventory,
    target: MirrorInventory,
  ): void {
    if (!run.source_root_identity || source.rootIdentity !== run.source_root_identity) {
      throw new Error('La identidad de la raíz fuente cambió; no se aplicó ningún cambio al catálogo.')
    }
    if (!run.target_root_identity || target.rootIdentity !== run.target_root_identity) {
      throw new Error('La identidad de la raíz destino cambió; no se aplicó ningún cambio al catálogo.')
    }
  }

  private assertSourcePlan(run: DbLibraryMigrationRun, inventory: MirrorInventory): void {
    const planned = new Map(
      this.journal.listEntries(run.id).map(entry => [entry.source_relative_path, entry.source]),
    )
    const observedEntries = inventory.entries.filter(entry => (
      !(run.mode === 'merge' && entry.relativePath === '.crate/library.yaml')
    ))
    if (planned.size !== observedEntries.length) {
      throw new Error('El inventario fuente cambió después de la planificación.')
    }
    for (const observed of observedEntries) {
      const expected = planned.get(observed.relativePath)
      if (!entriesHaveSameContent(expected, observed, run.source_provider, run.source_provider)) {
        throw new Error(`La fuente cambió después de planificar: ${observed.relativePath}`)
      }
    }
  }

  private assertTargetPreconditions(run: DbLibraryMigrationRun, inventory: MirrorInventory): void {
    const observed = new Map(inventory.entries.map(entry => [entry.relativePath, entry]))
    for (const entry of this.journal.listEntries(run.id)) {
      const current = observed.get(entry.destination_relative_path) ?? null
      if (
        entry.status === 'transferred'
        && entriesHaveSameContent(entry.source, current, run.source_provider, run.target_provider)
      ) continue
      const expected = entry.status === 'published' ? entry.source : entry.destinationBefore
      const leftProvider = entry.status === 'published' ? run.source_provider : run.target_provider
      if (!entriesHaveSameContent(expected, current, leftProvider, run.target_provider)) {
        throw new Error(`El destino cambió después de planificar: ${entry.destination_relative_path}`)
      }
    }
  }

  private assertPublished(run: DbLibraryMigrationRun, inventory: MirrorInventory): void {
    const observed = new Map(inventory.entries.map(entry => [entry.relativePath, entry]))
    for (const entry of this.journal.listEntries(run.id)) {
      if (entry.status !== 'published') throw new Error(`La acción ${entry.destination_relative_path} no fue publicada.`)
      const destination = observed.get(entry.destination_relative_path)
      if (!entriesHaveSameContent(entry.source, destination, run.source_provider, run.target_provider)) {
        throw new Error(`La verificación final falló en ${entry.destination_relative_path}.`)
      }
    }
  }

  private startCleanup(runId: string): void {
    if (this.inFlight.has(runId)) return
    const controller = new AbortController()
    this.controllers.set(runId, controller)
    const promise = this.cleanupSource(runId, controller.signal).finally(() => {
      this.controllers.delete(runId)
      this.inFlight.delete(runId)
    })
    this.inFlight.set(runId, promise)
  }

  private async cleanupSource(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.journal.requireRun(runId)
    const source = sourceFolderFromRun(run)
    try {
      const inventory = await this.requireAdapter(source.provider).inventory(source, signal)
      if (inventory.rootIdentity !== run.source_root_identity) throw new Error('La raíz original ya no tiene la identidad verificada.')
      this.assertSourcePlan(run, inventory)
      if (this.isProtectedRoot(source)) throw new Error('La raíz original es una raíz protegida y no se puede mover a la papelera.')
      if (source.provider === 'local') {
        if (!this.options.trashLocalRoot) throw new Error('No hay un servicio de papelera local configurado.')
        await this.options.trashLocalRoot(source.path)
      } else {
        if (!this.options.oneDriveClient || !source.drive_id || !source.item_id) {
          throw new Error('La identidad OneDrive de la fuente está incompleta.')
        }
        const item = await this.options.oneDriveClient.getItem(source.drive_id, source.item_id, signal)
        await this.options.oneDriveClient.deleteItemToRecycleBin({
          driveId: source.drive_id,
          itemId: source.item_id,
          ifMatch: item.eTag ?? item.cTag,
          signal,
        })
      }
      this.journal.setRunStatus(runId, 'completed', 'completed')
      this.journal.releaseLocks(runId)
      await this.restoreAfterTerminal(this.journal.requireRun(runId))
      this.emit(runId, 'Migración completada; el original se envió a la papelera.')
    } catch (error) {
      this.journal.setRunStatus(runId, 'cleanup_pending', 'cleanup', null, message(error))
      this.journal.releaseLocks(runId)
      await this.restoreAfterTerminal(this.journal.requireRun(runId))
      this.emit(runId, `Migración confirmada; limpieza pendiente: ${message(error)}`)
    }
  }

  private async restoreAfterTerminal(run: DbLibraryMigrationRun): Promise<void> {
    const ids = [run.source_folder_id, run.target_folder_id]
      .filter((id): id is number => id != null && this.getFolder(id) != null)
    await this.options.restoreLocations?.(ids)
  }

  private emit(runId: string, messageText?: string): void {
    const state = this.journal.state(runId)
    const event: LibraryMigrationProgressEvent = {
      runId,
      sourceFolderId: state.sourceFolderId,
      targetFolderId: state.targetFolderId,
      status: state.status,
      phase: state.phase,
      completedActions: state.completedActions,
      totalActions: state.totalActions,
      completedBytes: state.completedBytes,
      totalBytes: state.totalBytes,
      relativePath: state.relativePath ?? undefined,
      message: messageText,
    }
    for (const listener of this.listeners) listener(event)
  }

  private trackIdsByRelativePath(folder: DbFolder): Map<string, number> {
    const rows = this.db.prepare<[number], DbTrack>(`SELECT * FROM tracks WHERE folder_id = ?`).all(folder.id)
    const result = new Map<string, number>()
    for (const track of rows) {
      const path = relativeTrackPath(folder, track)
      if (!path) throw new Error(`No se pudo calcular la ruta relativa del track ${track.id}.`)
      result.set(path, track.id)
    }
    return result
  }

  private findCanonicalTrackId(target: DbFolder, relativePath: string): number | null {
    const trackPath = target.provider === 'local'
      ? localDestinationPath(target.path, relativePath)
      : null
    if (trackPath) {
      return this.db.prepare<[number, string], { id: number }>(`
        SELECT id FROM tracks WHERE folder_id = ? AND path = ?
      `).get(target.id, trackPath)?.id ?? null
    }
    const remotePath = remoteDestinationPath(target.remote_path, relativePath)
    return this.db.prepare<[number, string], { id: number }>(`
      SELECT id FROM tracks WHERE folder_id = ? AND remote_path = ?
    `).get(target.id, remotePath)?.id ?? null
  }

  private requireLiveSource(run: DbLibraryMigrationRun): DbFolder {
    const source = this.requireFolder(run.source_folder_id)
    if (!storedLocationMatches(source, run, 'source')) {
      throw new Error('La configuración de la fuente cambió durante la migración.')
    }
    return source
  }

  private requireLiveTarget(run: DbLibraryMigrationRun): DbFolder {
    if (run.target_folder_id == null) return targetFolderFromRun(run)
    const target = this.requireFolder(run.target_folder_id)
    if (!storedLocationMatches(target, run, 'target')) {
      throw new Error('La configuración del destino cambió durante la migración.')
    }
    return target
  }

  private isProtectedRoot(folder: DbFolder): boolean {
    if (folder.provider === 'local') {
      const path = resolve(folder.path)
      return dirname(path) === path
    }
    return normalizedRemotePath(folder.remote_path ?? '/') === '/'
  }

  private requireAdapter(provider: LibraryProvider): MirrorAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) throw new Error(`No hay adaptador de migración para ${provider}.`)
    return adapter
  }

  private requireFolder(folderId: number): DbFolder {
    const folder = this.getFolder(folderId)
    if (!folder) throw new Error(`La ubicación ${folderId} no existe.`)
    return folder
  }

  private getFolder(folderId: number): DbFolder | undefined {
    return this.db.prepare<[number], DbFolder>(`SELECT * FROM folders WHERE id = ?`).get(folderId)
  }

  private listFolders(): DbFolder[] {
    return this.db.prepare<unknown[], DbFolder>(`SELECT * FROM folders ORDER BY id`).all()
  }
}
