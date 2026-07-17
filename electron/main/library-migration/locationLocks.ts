import type { Database as BetterSqliteDatabase } from 'better-sqlite3'

let runtimeDatabase: BetterSqliteDatabase | null = null

/** Keeps the lock helper independent from Electron's database bootstrap so
 * adapter/integration tests can import it under Node's native TS runner. */
export function setLibraryLocationLockDatabase(db: BetterSqliteDatabase | null): void {
  runtimeDatabase = db
}

function hasMigrationTable(db: BetterSqliteDatabase): boolean {
  return db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'library_location_migration_locks'
  `).get() != null
}

export function isLibraryLocationMigrationLocked(
  folderId: number,
  db: BetterSqliteDatabase | null = runtimeDatabase,
): boolean {
  if (!db) return false
  if (!hasMigrationTable(db)) return false
  return db.prepare(`
    SELECT 1 FROM library_location_migration_locks WHERE folder_id = ?
  `).get(folderId) != null
}

export function assertLibraryLocationMigrationUnlocked(
  folderId: number,
  operation = 'esta operación',
  db: BetterSqliteDatabase | null = runtimeDatabase,
): void {
  if (isLibraryLocationMigrationLocked(folderId, db)) {
    throw new Error(`La biblioteca está bloqueada por una migración; ${operation} se reanudará al finalizar.`)
  }
}
