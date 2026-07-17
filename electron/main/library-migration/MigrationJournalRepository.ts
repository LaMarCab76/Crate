import { randomUUID } from 'node:crypto'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type {
  DbFolder,
  DbLibraryMigrationEntry,
  DbLibraryMigrationEntryStatus,
  DbLibraryMigrationRun,
} from '@shared/types/db'
import type {
  LibraryMigrationConflict,
  LibraryMigrationPlanSummary,
  LibraryMigrationState,
  LibraryMigrationStatus,
  UnifiedBackupChoice,
} from '@shared/types/library-locations'
import type { MirrorEntry } from '../library-mirror/types.ts'
import type { PlannedMigrationEntry } from './planner.ts'

function now(): string {
  return new Date().toISOString()
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  return JSON.parse(value) as T
}

export interface StoredMigrationEntry extends DbLibraryMigrationEntry {
  source: MirrorEntry
  destinationBefore: MirrorEntry | null
  latestDestination: MirrorEntry | null
  resumeState: unknown | null
}

export interface CreateJournalRunArgs {
  id?: string
  source: DbFolder
  target: DbFolder
  targetFolderId: number | null
  mode: 'relocate' | 'merge'
  sourceDisposition: 'keep' | 'trash'
  unifiedBackup?: unknown | null
}

export class MigrationJournalRepository {
  private readonly db: BetterSqliteDatabase

  constructor(db: BetterSqliteDatabase) {
    this.db = db
  }

  createRun(args: CreateJournalRunArgs): DbLibraryMigrationRun {
    const id = args.id ?? randomUUID()
    const timestamp = now()
    const create = this.db.transaction(() => {
      this.assertUnlocked(args.source.id)
      if (args.targetFolderId != null) this.assertUnlocked(args.targetFolderId)
      this.db.prepare(`
        INSERT INTO library_location_migration_runs (
          id, source_folder_id, source_provider, target_folder_id, mode, source_role,
          source_disposition, source_name, source_path, source_account_id,
          source_drive_id, source_item_id, source_remote_path, target_provider,
          target_name, target_path, target_account_id, target_drive_id,
          target_item_id, target_remote_path, unified_backup_json, status, phase,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'planning', 'planning', ?, ?
        )
      `).run(
        id,
        args.source.id,
        args.source.provider,
        args.targetFolderId,
        args.mode,
        args.source.role,
        args.sourceDisposition,
        args.source.name,
        args.source.path,
        args.source.account_id,
        args.source.drive_id,
        args.source.item_id,
        args.source.remote_path,
        args.target.provider,
        args.target.name,
        args.target.path,
        args.target.account_id,
        args.target.drive_id,
        args.target.item_id,
        args.target.remote_path,
        args.unifiedBackup ? JSON.stringify(args.unifiedBackup) : null,
        timestamp,
        timestamp,
      )
      const insertLock = this.db.prepare(`
        INSERT INTO library_location_migration_locks (folder_id, run_id, acquired_at)
        VALUES (?, ?, ?)
      `)
      insertLock.run(args.source.id, id, timestamp)
      if (args.targetFolderId != null) insertLock.run(args.targetFolderId, id, timestamp)
    })
    try {
      create.immediate()
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new Error('Una de las ubicaciones ya participa en otra migración activa.')
      }
      throw error
    }
    return this.requireRun(id)
  }

  private assertUnlocked(folderId: number): void {
    const lock = this.db.prepare<[number], { run_id: string }>(`
      SELECT run_id FROM library_location_migration_locks WHERE folder_id = ?
    `).get(folderId)
    if (lock) throw new Error(`La ubicación está bloqueada por la migración ${lock.run_id}.`)
  }

  getRun(runId: string): DbLibraryMigrationRun | undefined {
    return this.db.prepare<[string], DbLibraryMigrationRun>(`
      SELECT * FROM library_location_migration_runs WHERE id = ?
    `).get(runId)
  }

  requireRun(runId: string): DbLibraryMigrationRun {
    const run = this.getRun(runId)
    if (!run) throw new Error(`Library migration ${runId} does not exist.`)
    return run
  }

  listRuns(): DbLibraryMigrationRun[] {
    return this.db.prepare<unknown[], DbLibraryMigrationRun>(`
      SELECT * FROM library_location_migration_runs ORDER BY created_at DESC
    `).all()
  }

  listRecoverableRuns(): DbLibraryMigrationRun[] {
    return this.db.prepare<unknown[], DbLibraryMigrationRun>(`
      SELECT * FROM library_location_migration_runs
      WHERE status IN ('planning', 'transferring', 'publishing', 'committing', 'cleanup_pending')
      ORDER BY created_at ASC
    `).all()
  }

  savePlan(args: {
    runId: string
    sourceRootIdentity: string
    targetRootIdentity: string
    summary: LibraryMigrationPlanSummary
    entries: readonly PlannedMigrationEntry[]
    sourceTrackIds: ReadonlyMap<string, number>
    canonicalTrackIds: ReadonlyMap<string, number>
  }): void {
    const save = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM library_location_migration_entries WHERE run_id = ?`).run(args.runId)
      const timestamp = now()
      const insert = this.db.prepare(`
        INSERT INTO library_location_migration_entries (
          id, run_id, ordinal, kind, source_relative_path,
          destination_relative_path, source_entry_json, destination_entry_json,
          source_track_id, canonical_track_id, conflict, status,
          bytes_total, bytes_completed, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      args.entries.forEach((entry, ordinal) => {
        const completed = !entry.needsTransfer
        insert.run(
          randomUUID(),
          args.runId,
          ordinal,
          entry.kind,
          entry.sourceRelativePath,
          entry.destinationRelativePath,
          JSON.stringify(entry.source),
          entry.destinationBefore ? JSON.stringify(entry.destinationBefore) : null,
          args.sourceTrackIds.get(entry.sourceRelativePath) ?? null,
          args.canonicalTrackIds.get(entry.destinationRelativePath) ?? null,
          entry.conflict,
          completed ? 'published' : 'pending',
          entry.kind === 'file' ? entry.source.size : 0,
          completed ? (entry.kind === 'file' ? entry.source.size : 0) : 0,
          timestamp,
          timestamp,
          completed ? timestamp : null,
        )
      })
      this.db.prepare(`
        UPDATE library_location_migration_runs
        SET status = 'awaiting_approval', phase = 'approval',
            source_root_identity = ?, target_root_identity = ?,
            plan_summary_json = ?, conflicts_json = ?,
            updated_at = ?, error = NULL
        WHERE id = ? AND status = 'planning'
      `).run(
        args.sourceRootIdentity,
        args.targetRootIdentity,
        JSON.stringify(args.summary),
        JSON.stringify(args.summary.conflicts),
        timestamp,
        args.runId,
      )
    })
    save.immediate()
  }

  listEntries(runId: string): StoredMigrationEntry[] {
    return this.db.prepare<[string], DbLibraryMigrationEntry>(`
      SELECT * FROM library_location_migration_entries WHERE run_id = ? ORDER BY ordinal ASC
    `).all(runId).map(row => ({
      ...row,
      source: parseJson<MirrorEntry>(row.source_entry_json, null as never),
      destinationBefore: parseJson<MirrorEntry | null>(row.destination_entry_json, null),
      latestDestination: parseJson<MirrorEntry | null>(row.published_entry_json, null),
      resumeState: parseJson<unknown | null>(row.resume_state_json, null),
    }))
  }

  approve(runId: string): void {
    const timestamp = now()
    const result = this.db.prepare(`
      UPDATE library_location_migration_runs
      SET status = 'transferring', phase = 'transferring',
          started_at = COALESCE(started_at, ?), updated_at = ?, error = NULL
      WHERE id = ? AND status = 'awaiting_approval'
    `).run(timestamp, timestamp, runId)
    if (result.changes !== 1) throw new Error('La migración ya no espera aprobación.')
  }

  setRunStatus(
    runId: string,
    status: LibraryMigrationStatus,
    phase: string,
    error: string | null = null,
    cleanupError: string | null = null,
  ): void {
    const timestamp = now()
    const completedAt = status === 'completed' || status === 'cancelled' ? timestamp : null
    const committedAt = status === 'cleanup_pending' || status === 'completed' ? timestamp : null
    this.db.prepare(`
      UPDATE library_location_migration_runs
      SET status = ?, phase = ?, error = ?, cleanup_error = ?, updated_at = ?,
          started_at = CASE WHEN ? IN ('transferring', 'publishing', 'committing')
                            THEN COALESCE(started_at, ?) ELSE started_at END,
          committed_at = CASE WHEN ? IS NOT NULL THEN COALESCE(committed_at, ?) ELSE committed_at END,
          completed_at = ?
      WHERE id = ?
    `).run(
      status,
      phase,
      error,
      cleanupError,
      timestamp,
      status,
      timestamp,
      committedAt,
      timestamp,
      completedAt,
      runId,
    )
  }

  setEntryStatus(
    entryId: string,
    status: DbLibraryMigrationEntryStatus,
    options: {
      bytesCompleted?: number
      resumeState?: unknown | null
      latestDestination?: MirrorEntry | null
      error?: string | null
    } = {},
  ): void {
    const timestamp = now()
    const completed = status === 'published' ? timestamp : null
    this.db.prepare(`
      UPDATE library_location_migration_entries
      SET status = ?,
          bytes_completed = CASE WHEN ? IS NULL THEN bytes_completed
                                 ELSE MIN(bytes_total, MAX(0, ?)) END,
          resume_state_json = CASE WHEN ? = 0 THEN resume_state_json ELSE ? END,
          published_entry_json = CASE WHEN ? = 0 THEN published_entry_json ELSE ? END,
          error = ?, updated_at = ?,
          completed_at = CASE WHEN ? IS NULL THEN completed_at ELSE ? END
      WHERE id = ?
    `).run(
      status,
      options.bytesCompleted ?? null,
      options.bytesCompleted ?? null,
      'resumeState' in options ? 1 : 0,
      options.resumeState == null ? null : JSON.stringify(options.resumeState),
      'latestDestination' in options ? 1 : 0,
      options.latestDestination == null ? null : JSON.stringify(options.latestDestination),
      options.error ?? null,
      timestamp,
      completed,
      completed,
      entryId,
    )
  }

  resetIncompleteEntries(runId: string): void {
    this.db.prepare(`
      UPDATE library_location_migration_entries
      SET status = CASE
            WHEN status IN ('paused', 'failed', 'transferring') THEN 'pending'
            WHEN status = 'publishing' THEN 'transferred'
            ELSE status END,
          error = NULL, updated_at = ?
      WHERE run_id = ?
    `).run(now(), runId)
  }

  releaseLocks(runId: string): void {
    this.db.prepare(`DELETE FROM library_location_migration_locks WHERE run_id = ?`).run(runId)
  }

  planSummary(run: DbLibraryMigrationRun): LibraryMigrationPlanSummary {
    return parseJson(run.plan_summary_json, {
      runId: run.id,
      sourceFolderId: run.source_folder_id,
      targetFolderId: run.target_folder_id,
      mode: run.mode,
      status: run.status,
      filesToTransfer: 0,
      directoriesToCreate: 0,
      identicalFiles: 0,
      renamedFiles: 0,
      bytesToTransfer: 0,
      warnings: [],
      conflicts: [],
    })
  }

  state(runId: string): LibraryMigrationState {
    const run = this.requireRun(runId)
    const entries = this.listEntries(runId)
    const summary = this.planSummary(run)
    const current = entries.find(entry => ['transferring', 'publishing'].includes(entry.status))
      ?? entries.find(entry => ['pending', 'transferred'].includes(entry.status))
    return {
      ...summary,
      status: run.status,
      sourceRole: run.source_role,
      targetProvider: run.target_provider,
      targetName: run.target_name,
      targetPath: run.target_path,
      sourceDisposition: run.source_disposition,
      phase: run.phase,
      completedActions: entries.filter(entry => entry.status === 'published').length,
      totalActions: entries.length,
      completedBytes: entries.reduce((sum, entry) => sum + entry.bytes_completed, 0),
      totalBytes: entries.reduce((sum, entry) => sum + entry.bytes_total, 0),
      relativePath: current?.destination_relative_path ?? null,
      error: run.error,
      cleanupError: run.cleanup_error,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      completedAt: run.completed_at,
    }
  }

  conflicts(runId: string): LibraryMigrationConflict[] {
    return parseJson(this.requireRun(runId).conflicts_json, [])
  }
}
