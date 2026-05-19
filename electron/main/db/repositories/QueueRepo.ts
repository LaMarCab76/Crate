import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbQueueEntry } from '@shared/types/db'

export interface QueueSnapshot {
  trackIds: number[]
  currentIndex: number
}

// Thin wrapper around better-sqlite3's multi-statement runner. Kept as a
// separate function so we can swap the underlying implementation later
// (e.g. add logging or metrics) without touching call sites.
function runMultiStatement(db: BetterSqliteDatabase, sql: string): void {
  db.exec(sql)
}

export class QueueRepo {
  private db: BetterSqliteDatabase
  private stmtClear
  private stmtAll
  private stmtInsert
  private stmtCurrentMeta
  private stmtSetCurrentMeta

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtClear = db.prepare(`DELETE FROM queue`)
    this.stmtAll = db.prepare<unknown[], DbQueueEntry>(`
      SELECT * FROM queue ORDER BY position ASC
    `)
    this.stmtInsert = db.prepare(`
      INSERT INTO queue (track_id, position) VALUES (?, ?)
    `)

    // Tiny key-value table for app-wide metadata such as the current queue
    // pointer. Created lazily so we don't need yet another migration.
    runMultiStatement(this.db, `
      CREATE TABLE IF NOT EXISTS app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
    this.stmtCurrentMeta = db.prepare<[string], { value: string }>(`
      SELECT value FROM app_meta WHERE key = ?
    `)
    this.stmtSetCurrentMeta = db.prepare(`
      INSERT INTO app_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
  }

  save(trackIds: number[], currentIndex: number): void {
    const tx = this.db.transaction((ids: number[]) => {
      this.stmtClear.run()
      for (let i = 0; i < ids.length; i++) {
        this.stmtInsert.run(ids[i], i)
      }
      this.stmtSetCurrentMeta.run('queue.currentIndex', String(currentIndex))
    })
    tx(trackIds)
  }

  load(): QueueSnapshot {
    const rows = this.stmtAll.all()
    const meta = this.stmtCurrentMeta.get('queue.currentIndex')
    return {
      trackIds: rows.map(r => r.track_id),
      currentIndex: meta ? parseInt(meta.value, 10) || 0 : 0,
    }
  }
}
