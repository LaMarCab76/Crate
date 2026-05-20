import { app } from 'electron'
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from './migrator'

let dbInstance: BetterSqliteDatabase | null = null

function databasePath(): string {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  return join(userData, 'crate.db')
}

export function getDatabase(): BetterSqliteDatabase {
  if (dbInstance) return dbInstance

  const path = databasePath()
  const db = new Database(path)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')

  const compileOptions = db.pragma('compile_options') as Array<{ compile_options: string }>
  const flatOptions = compileOptions.map(r => r.compile_options)
  if (!flatOptions.some(o => o.includes('ENABLE_FTS5'))) {
    throw new Error(
      'SQLite was compiled without FTS5 support; Crate requires FTS5 for search. ' +
        'Reinstall better-sqlite3 or check the bundled SQLite version.',
    )
  }

  runMigrations(db)

  dbInstance = db
  return db
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

export type { BetterSqliteDatabase as DB }
