import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbArtist } from '@shared/types/db'
import { normalizeName, sortKey } from './normalize'

export class ArtistRepo {
  private db: BetterSqliteDatabase
  private stmtByNormalized
  private stmtById
  private stmtAll
  private stmtInsert

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtByNormalized = db.prepare<[string], DbArtist>(`SELECT * FROM artists WHERE normalized_name = ?`)
    this.stmtById = db.prepare<[number], DbArtist>(`SELECT * FROM artists WHERE id = ?`)
    this.stmtAll = db.prepare<unknown[], DbArtist>(`SELECT * FROM artists ORDER BY sort_name COLLATE NOCASE ASC`)
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
}
