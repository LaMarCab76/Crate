import type { Database as BetterSqliteDatabase, Statement } from 'better-sqlite3'
import type {
  LibraryScanEvent,
  LibraryScanEventType,
  LibraryScanReason,
  LibraryScanRun,
  LibraryScanStatus,
} from '@shared/types/ipc-contract'

interface StartRunArgs {
  folderId: number
  reason: LibraryScanReason
}

interface FinishRunArgs {
  id: number
  status: LibraryScanStatus
  added: number
  updated: number
  removed: number
  skipped: number
  error?: string | null
}

interface AddEventArgs {
  runId: number
  folderId: number
  type: LibraryScanEventType
  path?: string | null
  title?: string | null
  detail?: string | null
  occurredAt?: number
}

export class LibraryScanLogRepo {
  private db: BetterSqliteDatabase
  private stmtByRunId: Statement
  private stmtStartRun: Statement
  private stmtFinishRun: Statement
  private stmtAddEvent: Statement

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtByRunId = db.prepare<[number], LibraryScanRun>(`
      SELECT
        id,
        folder_id AS folderId,
        reason,
        status,
        started_at AS startedAt,
        finished_at AS finishedAt,
        added,
        updated,
        removed,
        skipped,
        error
      FROM library_scan_runs
      WHERE id = ?
    `)
    this.stmtStartRun = db.prepare(`
      INSERT INTO library_scan_runs (folder_id, reason, status, started_at)
      VALUES (@folderId, @reason, 'running', @startedAt)
    `)
    this.stmtFinishRun = db.prepare(`
      UPDATE library_scan_runs
      SET
        status = @status,
        finished_at = @finishedAt,
        added = @added,
        updated = @updated,
        removed = @removed,
        skipped = @skipped,
        error = @error
      WHERE id = @id
    `)
    this.stmtAddEvent = db.prepare(`
      INSERT INTO library_scan_events (
        run_id, folder_id, type, path, title, detail, occurred_at
      ) VALUES (
        @runId, @folderId, @type, @path, @title, @detail, @occurredAt
      )
    `)
  }

  startRun(args: StartRunArgs): LibraryScanRun {
    const result = this.stmtStartRun.run({
      folderId: args.folderId,
      reason: args.reason,
      startedAt: Date.now(),
    })
    return this.getRun(Number(result.lastInsertRowid))!
  }

  finishRun(args: FinishRunArgs): LibraryScanRun {
    this.stmtFinishRun.run({
      id: args.id,
      status: args.status,
      finishedAt: Date.now(),
      added: args.added,
      updated: args.updated,
      removed: args.removed,
      skipped: args.skipped,
      error: args.error ?? null,
    })
    return this.getRun(args.id)!
  }

  getRun(id: number): LibraryScanRun | undefined {
    return this.stmtByRunId.get(id) as LibraryScanRun | undefined
  }

  addEvent(args: AddEventArgs): void {
    this.stmtAddEvent.run({
      runId: args.runId,
      folderId: args.folderId,
      type: args.type,
      path: args.path ?? null,
      title: args.title ?? null,
      detail: args.detail ?? null,
      occurredAt: args.occurredAt ?? Date.now(),
    })
  }

  addEvents(events: AddEventArgs[]): void {
    if (events.length === 0) return
    const tx = this.db.transaction((batch: AddEventArgs[]) => {
      for (const event of batch) this.addEvent(event)
    })
    tx(events)
  }

  listRuns(folderId: number | null, limit: number): LibraryScanRun[] {
    const cappedLimit = Math.min(Math.max(limit, 1), 500)
    if (folderId != null) {
      return this.db
        .prepare<[number, number], LibraryScanRun>(`
          SELECT
            id,
            folder_id AS folderId,
            reason,
            status,
            started_at AS startedAt,
            finished_at AS finishedAt,
            added,
            updated,
            removed,
            skipped,
            error
          FROM library_scan_runs
          WHERE folder_id = ?
          ORDER BY started_at DESC
          LIMIT ?
        `)
        .all(folderId, cappedLimit) as LibraryScanRun[]
    }

    return this.db
      .prepare<[number], LibraryScanRun>(`
        SELECT
          id,
          folder_id AS folderId,
          reason,
          status,
          started_at AS startedAt,
          finished_at AS finishedAt,
          added,
          updated,
          removed,
          skipped,
          error
        FROM library_scan_runs
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .all(cappedLimit) as LibraryScanRun[]
  }

  listEvents(folderId: number | null, limit: number): LibraryScanEvent[] {
    const cappedLimit = Math.min(Math.max(limit, 1), 1000)
    if (folderId != null) {
      return this.db
        .prepare<[number, number], LibraryScanEvent>(`
          SELECT
            id,
            run_id AS runId,
            folder_id AS folderId,
            type,
            path,
            title,
            detail,
            occurred_at AS occurredAt
          FROM library_scan_events
          WHERE folder_id = ?
          ORDER BY occurred_at DESC
          LIMIT ?
        `)
        .all(folderId, cappedLimit) as LibraryScanEvent[]
    }

    return this.db
      .prepare<[number], LibraryScanEvent>(`
        SELECT
          id,
          run_id AS runId,
          folder_id AS folderId,
          type,
          path,
          title,
          detail,
          occurred_at AS occurredAt
        FROM library_scan_events
        ORDER BY occurred_at DESC
        LIMIT ?
      `)
      .all(cappedLimit) as LibraryScanEvent[]
  }

  purgeOlderThan(retentionDays: number | null): void {
    if (retentionDays == null) return
    const days = Math.max(1, Math.floor(retentionDays))
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    this.db
      .prepare<[number]>(`DELETE FROM library_scan_runs WHERE started_at < ?`)
      .run(cutoff)
  }
}
