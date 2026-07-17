import { app } from 'electron'
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { prepareMigrations, runPreparedMigrations } from './migrator'
import { materializeLyricsSidecars } from './lyricsSidecarBackfill'

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

  try {
    db.pragma('busy_timeout = 5000')

    // Validate the bundled migration sequence and database compatibility before
    // any startup preflight can write recovery files or alter SQLite settings.
    const migrationPlan = prepareMigrations(db)

    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('synchronous = NORMAL')

    const compileOptions = db.pragma('compile_options') as Array<{ compile_options: string }>
    const flatOptions = compileOptions.map(r => r.compile_options)
    if (!flatOptions.some(o => o.includes('ENABLE_FTS5'))) {
      throw new Error(
        'SQLite was compiled without FTS5 support; Crate requires FTS5 for search. ' +
          'Reinstall better-sqlite3 or check the bundled SQLite version.',
      )
    }

    // Write any DB-cached lyrics out to `.lrc` sidecars before migration 0019
    // drops the lyrics tables, so the move to sidecar-only storage loses no data.
    materializeLyricsSidecars(db, dirname(path))
    runPreparedMigrations(db, migrationPlan)

    dbInstance = db
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

export type { BetterSqliteDatabase as DB }
