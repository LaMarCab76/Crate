import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbPlaylist } from '@shared/types/db'

export class PlaylistRepo {
  private db: BetterSqliteDatabase
  private stmtList
  private stmtById
  private stmtInsert
  private stmtDelete
  private stmtAddTrack
  private stmtNextPosition
  private stmtRemoveTrack

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtList = db.prepare<unknown[], DbPlaylist>(`
      SELECT * FROM playlists ORDER BY sort_order ASC, name COLLATE NOCASE ASC
    `)
    this.stmtById = db.prepare<[number], DbPlaylist>(`SELECT * FROM playlists WHERE id = ?`)
    this.stmtInsert = db.prepare(`
      INSERT INTO playlists (name, description, created_date, modified_date, is_smart)
      VALUES (?, ?, ?, ?, ?)
    `)
    this.stmtDelete = db.prepare(`DELETE FROM playlists WHERE id = ?`)
    this.stmtAddTrack = db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, track_id, position, date_added)
      VALUES (?, ?, ?, ?)
    `)
    this.stmtNextPosition = db.prepare<[number], { next: number }>(`
      SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_tracks WHERE playlist_id = ?
    `)
    this.stmtRemoveTrack = db.prepare(`
      DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?
    `)
  }

  list(): DbPlaylist[] {
    return this.stmtList.all()
  }

  getById(id: number): DbPlaylist | undefined {
    return this.stmtById.get(id)
  }

  create(name: string, description: string | null, isSmart = false): DbPlaylist {
    const now = new Date().toISOString()
    const result = this.stmtInsert.run(name, description, now, now, isSmart ? 1 : 0)
    return this.getById(Number(result.lastInsertRowid))!
  }

  delete(id: number): void {
    this.stmtDelete.run(id)
  }

  addTracks(playlistId: number, trackIds: number[]): void {
    const tx = this.db.transaction((ids: number[]) => {
      const now = new Date().toISOString()
      for (const tid of ids) {
        const next = this.stmtNextPosition.get(playlistId)?.next ?? 0
        this.stmtAddTrack.run(playlistId, tid, next, now)
      }
    })
    tx(trackIds)
  }

  removeTrack(playlistId: number, trackId: number): void {
    this.stmtRemoveTrack.run(playlistId, trackId)
  }
}
