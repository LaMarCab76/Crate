import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbArtist } from '@shared/types/db'
import { normalizeName, sortKey } from './normalize'

export class ArtistRepo {
  private db: BetterSqliteDatabase
  private stmtByNormalized
  private stmtById
  private stmtAll
  private stmtSetFavorite
  private stmtSetArtwork
  private stmtInsert

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtByNormalized = db.prepare<[string], DbArtist>(`SELECT * FROM artists WHERE normalized_name = ?`)
    this.stmtById = db.prepare<[number], DbArtist>(`SELECT * FROM artists WHERE id = ?`)
    this.stmtAll = db.prepare<unknown[], DbArtist>(`SELECT * FROM artists ORDER BY sort_name COLLATE NOCASE ASC`)
    this.stmtSetFavorite = db.prepare<[number, number, number]>(
      `UPDATE artists SET is_favorite = ?, state_updated_at = ? WHERE id = ?`,
    )
    this.stmtSetArtwork = db.prepare<[string | null, string | null, number]>(
      `UPDATE artists SET artwork_path = ?, artwork_source_type = ? WHERE id = ?`,
    )
    this.stmtInsert = db.prepare(`
      INSERT INTO artists (name, normalized_name, sort_name, date_added)
      VALUES (?, ?, ?, ?)
    `)
  }

  getOrCreate(name: string): DbArtist {
    const normalized = normalizeName(name)
    const existing = this.stmtByNormalized.get(normalized)
    if (existing) return existing
    const result = this.stmtInsert.run(name, normalized, sortKey(name), new Date().toISOString())
    return this.stmtById.get(Number(result.lastInsertRowid))!
  }

  getById(id: number): DbArtist | undefined {
    return this.stmtById.get(id)
  }

  getAll(): DbArtist[] {
    return this.stmtAll.all()
  }

  setFavorite(id: number, favorite: boolean): void {
    this.stmtSetFavorite.run(favorite ? 1 : 0, Date.now(), id)
  }

  setArtwork(id: number, artworkPath: string | null, sourceType: 'album' | 'custom' | null): void {
    this.stmtSetArtwork.run(artworkPath, sourceType, id)
  }
}
