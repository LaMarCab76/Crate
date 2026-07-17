import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import {
  applyMigrationPlan,
  buildMigrationCatalog,
  normalizeLegacyOneDriveVersion,
  planMigrations,
  readUserVersion,
  repairLegacyOneDriveRows,
  type MigrationPlan,
} from './migrationCore'

// Vite bundles each migration .sql file as a raw string at build time and
// inlines it into the main-process bundle, so we don't need to ship the
// migrations directory alongside out/main/index.js in production builds.
const MIGRATIONS = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const CATALOG = buildMigrationCatalog(MIGRATIONS)

export function prepareMigrations(db: BetterSqliteDatabase): MigrationPlan {
  return planMigrations(CATALOG, readUserVersion(db))
}

export function runPreparedMigrations(
  db: BetterSqliteDatabase,
  plan: MigrationPlan,
): void {
  const normalized = normalizeLegacyOneDriveVersion(db)
  applyMigrationPlan(db, normalized ? planMigrations(CATALOG, readUserVersion(db)) : plan)
  repairLegacyOneDriveRows(db)
}

export function runMigrations(db: BetterSqliteDatabase): void {
  runPreparedMigrations(db, prepareMigrations(db))
}
