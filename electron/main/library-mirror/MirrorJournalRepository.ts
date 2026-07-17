import { randomUUID } from 'node:crypto'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type {
  DbLibraryMirrorAction,
  DbLibraryMirrorRun,
  DbLibraryMirrorSnapshot,
} from '@shared/types/db'
import type { BackupPlanSummary, BackupRunStatus, BackupTrigger } from '@shared/types/library-locations'
import type { MirrorDivergence, MirrorEntry, MirrorPlannedAction, MirrorSnapshotEntry } from './types.ts'

export interface StoredMirrorAction extends DbLibraryMirrorAction {
  source: MirrorEntry | null
  destinationBefore: MirrorEntry | null
  phase: number
  resumeState: unknown | null
}

interface StoredActionPayload {
  source: MirrorEntry | null
  destinationBefore: MirrorEntry | null
  phase: number
}

function now(): string {
  return new Date().toISOString()
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  return JSON.parse(value) as T
}

export class MirrorJournalRepository {
  private readonly db: BetterSqliteDatabase

  constructor(db: BetterSqliteDatabase) {
    this.db = db
  }

  createRun(args: {
    sourceFolderId: number
    backupFolderId: number
    trigger: BackupTrigger
  }): DbLibraryMirrorRun {
    const id = randomUUID()
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO library_mirror_runs (
        id, source_folder_id, backup_folder_id, trigger, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'planning', ?, ?)
    `).run(id, args.sourceFolderId, args.backupFolderId, args.trigger, timestamp, timestamp)
    return this.getRun(id)!
  }

  getRun(runId: string): DbLibraryMirrorRun | undefined {
    return this.db.prepare<[string], DbLibraryMirrorRun>(`
      SELECT * FROM library_mirror_runs WHERE id = ?
    `).get(runId)
  }

  getLatestRun(backupFolderId: number): DbLibraryMirrorRun | undefined {
    return this.db.prepare<[number], DbLibraryMirrorRun>(`
      SELECT * FROM library_mirror_runs WHERE backup_folder_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(backupFolderId)
  }

  getActiveRun(backupFolderId: number): DbLibraryMirrorRun | undefined {
    return this.db.prepare<[number], DbLibraryMirrorRun>(`
      SELECT * FROM library_mirror_runs
      WHERE backup_folder_id = ?
        AND status IN ('pending', 'planning', 'awaiting_approval', 'running', 'paused')
      ORDER BY created_at DESC LIMIT 1
    `).get(backupFolderId)
  }

  listResumableRuns(): DbLibraryMirrorRun[] {
    return this.db.prepare<unknown[], DbLibraryMirrorRun>(`
      SELECT * FROM library_mirror_runs
      WHERE status IN ('pending', 'running')
      ORDER BY created_at ASC
    `).all()
  }

  savePlan(
    runId: string,
    summary: BackupPlanSummary,
    actions: readonly MirrorPlannedAction[],
    divergences: readonly MirrorDivergence[],
    rootIdentities?: {
      sourceRootIdentity: string
      backupRootIdentity: string
    },
  ): void {
    const save = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM library_mirror_actions WHERE run_id = ?`).run(runId)
      const timestamp = now()
      const insert = this.db.prepare(`
        INSERT INTO library_mirror_actions (
          id, run_id, ordinal, kind, relative_path, entry_json, destination_etag,
          requires_approval, status, bytes_total, bytes_completed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)
      `)
      actions.forEach((action, ordinal) => {
        const payload: StoredActionPayload = {
          source: action.source,
          destinationBefore: action.destinationBefore,
          phase: action.phase,
        }
        insert.run(
          randomUUID(),
          runId,
          ordinal,
          action.kind,
          action.relativePath,
          JSON.stringify(payload),
          action.destinationBefore?.etag ?? null,
          action.requiresApproval ? 1 : 0,
          action.bytesTotal,
          timestamp,
          timestamp,
        )
      })
      this.db.prepare(`
        UPDATE library_mirror_runs
        SET status = ?,
            source_root_identity = COALESCE(?, source_root_identity),
            backup_root_identity = COALESCE(?, backup_root_identity),
            plan_summary_json = ?, divergence_json = ?, updated_at = ?, error = NULL
        WHERE id = ?
      `).run(
        summary.status,
        rootIdentities?.sourceRootIdentity ?? null,
        rootIdentities?.backupRootIdentity ?? null,
        JSON.stringify(summary),
        JSON.stringify(divergences),
        timestamp,
        runId,
      )
    })
    save.immediate()
  }

  getPlanSummary(runId: string): BackupPlanSummary | null {
    const run = this.getRun(runId)
    return run ? parseJson<BackupPlanSummary | null>(run.plan_summary_json, null) : null
  }

  getDivergences(runId: string): MirrorDivergence[] {
    return parseJson<MirrorDivergence[]>(this.getRun(runId)?.divergence_json ?? null, [])
  }

  listActions(runId: string): StoredMirrorAction[] {
    const rows = this.db.prepare<[string], DbLibraryMirrorAction>(`
      SELECT * FROM library_mirror_actions WHERE run_id = ? ORDER BY ordinal ASC
    `).all(runId)
    return rows.map(row => {
      const payload = parseJson<StoredActionPayload>(row.entry_json, {
        source: null,
        destinationBefore: null,
        phase: 0,
      })
      return {
        ...row,
        source: payload.source,
        destinationBefore: payload.destinationBefore,
        phase: payload.phase,
        resumeState: parseJson<unknown | null>(row.resume_state_json, null),
      }
    })
  }

  approve(runId: string): void {
    const timestamp = now()
    const result = this.db.prepare(`
      UPDATE library_mirror_runs
      SET status = 'pending', approved_at = ?, updated_at = ?, error = NULL
      WHERE id = ? AND status = 'awaiting_approval'
    `).run(timestamp, timestamp, runId)
    if (result.changes === 0) throw new Error(`Mirror run ${runId} is not awaiting approval.`)
  }

  setRunStatus(runId: string, status: BackupRunStatus, error: string | null = null): void {
    const timestamp = now()
    const startedAt = status === 'running' ? timestamp : null
    const completedAt = ['completed', 'failed', 'cancelled'].includes(status) ? timestamp : null
    this.db.prepare(`
      UPDATE library_mirror_runs
      SET status = ?,
          started_at = COALESCE(started_at, ?),
          updated_at = ?,
          completed_at = ?,
          error = ?
      WHERE id = ?
    `).run(status, startedAt, timestamp, completedAt, error, runId)
  }

  setActionRunning(actionId: string): void {
    this.db.prepare(`
      UPDATE library_mirror_actions
      SET status = 'running', updated_at = ?, error = NULL
      WHERE id = ? AND status <> 'completed'
    `).run(now(), actionId)
  }

  setActionProgress(actionId: string, bytesCompleted: number, resumeState?: unknown | null): void {
    this.db.prepare(`
      UPDATE library_mirror_actions
      SET bytes_completed = MIN(bytes_total, MAX(0, ?)),
          resume_state_json = CASE WHEN ? IS NULL THEN resume_state_json ELSE ? END,
          updated_at = ?
      WHERE id = ?
    `).run(
      Math.floor(bytesCompleted),
      resumeState === undefined ? null : 'replace',
      resumeState === undefined ? null : JSON.stringify(resumeState),
      now(),
      actionId,
    )
  }

  setActionCompleted(actionId: string): void {
    const timestamp = now()
    this.db.prepare(`
      UPDATE library_mirror_actions
      SET status = 'completed', bytes_completed = bytes_total,
          resume_state_json = NULL, error = NULL, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(timestamp, timestamp, actionId)
  }

  setActionStopped(actionId: string, status: 'paused' | 'failed', error: string | null): void {
    this.db.prepare(`
      UPDATE library_mirror_actions SET status = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(status, error, now(), actionId)
  }

  resetIncompleteActions(runId: string): void {
    this.db.prepare(`
      UPDATE library_mirror_actions
      SET status = 'pending', error = NULL, updated_at = ?
      WHERE run_id = ? AND status IN ('running', 'paused', 'failed')
    `).run(now(), runId)
  }

  loadSnapshot(backupFolderId: number): MirrorSnapshotEntry[] {
    const rows = this.db.prepare<[number], DbLibraryMirrorSnapshot>(`
      SELECT * FROM library_mirror_snapshots WHERE backup_folder_id = ? ORDER BY relative_path ASC
    `).all(backupFolderId)
    return rows.map(row => ({
      relativePath: row.relative_path,
      kind: row.kind,
      size: row.size,
      modifiedAtMs: row.source_modified_at_ms,
      sha256: row.sha256,
      quickXorHash: row.quickxor_hash,
      etag: row.source_etag,
      sourceEtag: row.source_etag,
      destinationEtag: row.destination_etag,
    }))
  }

  hasSnapshotBaseline(backupFolderId: number): boolean {
    return this.db.prepare(`
      SELECT 1 FROM library_mirror_state WHERE backup_folder_id = ?
    `).get(backupFolderId) !== undefined
  }

  getRootIdentities(backupFolderId: number): {
    sourceRootIdentity: string
    backupRootIdentity: string
  } | null {
    const row = this.db.prepare<[number], {
      source_root_identity: string
      backup_root_identity: string
    }>(`
      SELECT source_root_identity, backup_root_identity
      FROM library_mirror_state WHERE backup_folder_id = ?
    `).get(backupFolderId)
    return row ? {
      sourceRootIdentity: row.source_root_identity,
      backupRootIdentity: row.backup_root_identity,
    } : null
  }

  replaceSnapshot(
    backupFolderId: number,
    runId: string,
    sourceEntries: readonly MirrorEntry[],
    destinationEntries: readonly MirrorEntry[],
    sourceRootIdentity: string,
    backupRootIdentity: string,
  ): void {
    const destinations = new Map(destinationEntries.map(entry => [entry.relativePath, entry]))
    const replace = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM library_mirror_snapshots WHERE backup_folder_id = ?`).run(backupFolderId)
      const insert = this.db.prepare(`
        INSERT INTO library_mirror_snapshots (
          backup_folder_id, relative_path, kind, size, sha256, quickxor_hash,
          source_etag, destination_etag, source_modified_at_ms,
          destination_modified_at_ms, run_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const timestamp = now()
      for (const source of sourceEntries) {
        const destination = destinations.get(source.relativePath)
        if (!destination) throw new Error(`Cannot snapshot missing destination entry: ${source.relativePath}`)
        insert.run(
          backupFolderId,
          source.relativePath,
          source.kind,
          source.size,
          source.sha256,
          source.quickXorHash,
          source.etag,
          destination.etag,
          source.modifiedAtMs,
          destination.modifiedAtMs,
          runId,
          timestamp,
        )
      }
      this.db.prepare(`
        INSERT INTO library_mirror_state (
          backup_folder_id, last_successful_run_id,
          source_root_identity, backup_root_identity, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(backup_folder_id) DO UPDATE SET
          last_successful_run_id = excluded.last_successful_run_id,
          source_root_identity = excluded.source_root_identity,
          backup_root_identity = excluded.backup_root_identity,
          updated_at = excluded.updated_at
      `).run(backupFolderId, runId, sourceRootIdentity, backupRootIdentity, timestamp)
    })
    replace.immediate()
  }
}
