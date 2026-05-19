import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbLyrics } from '@shared/types/db'

export class LyricsRepo {
  private stmtGet
  private stmtUpsert

  constructor(db: BetterSqliteDatabase) {
    this.stmtGet = db.prepare<[number], DbLyrics>(`
      SELECT * FROM lyrics WHERE track_id = ? LIMIT 1
    `)
    // Lyrics has no UNIQUE(track_id) so we model upsert ourselves: delete then insert.
    this.stmtUpsert = db.transaction(
      (trackId: number, lrc: string, source: string | null, lang: string | null) => {
        db.prepare(`DELETE FROM lyrics WHERE track_id = ?`).run(trackId)
        const now = new Date().toISOString()
        db.prepare(`
          INSERT INTO lyrics (track_id, lrc_content, language, source, date_added, date_modified)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(trackId, lrc, lang, source, now, now)
      },
    )
  }

  get(trackId: number): DbLyrics | undefined {
    return this.stmtGet.get(trackId)
  }

  set(trackId: number, lrcContent: string, source: string | null, language: string | null): void {
    this.stmtUpsert(trackId, lrcContent, source, language)
  }
}
