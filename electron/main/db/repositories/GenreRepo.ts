import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbGenre } from '@shared/types/db'
import { normalizeName, sortKey } from './normalize'

export class GenreRepo {
  private db: BetterSqliteDatabase
  private stmtByNormalized
  private stmtById
  private stmtAll
  private stmtInsert

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtByNormalized = db.prepare<[string], DbGenre>(`SELECT * FROM genres WHERE normalized_name = ?`)
    this.stmtById = db.prepare<[number], DbGenre>(`SELECT * FROM genres WHERE id = ?`)
    this.stmtAll = db.prepare<unknown[], DbGenre>(`SELECT * FROM genres ORDER BY sort_name COLLATE NOCASE ASC`)
    this.stmtInsert = db.prepare(`
      INSERT INTO genres (name, normalized_name, sort_name, date_added)
      VALUES (?, ?, ?, ?)
    `)
  }

  getOrCreate(name: string): DbGenre {
    const normalized = normalizeName(name)
    const existing = this.stmtByNormalized.get(normalized)
    if (existing) return existing
    const result = this.stmtInsert.run(name, normalized, sortKey(name), new Date().toISOString())
    return this.stmtById.get(Number(result.lastInsertRowid))!
  }

  getById(id: number): DbGenre | undefined {
    return this.stmtById.get(id)
  }

  getAll(): DbGenre[] {
    return this.stmtAll.all()
  }
}
