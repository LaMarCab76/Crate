import type { Database as BetterSqliteDatabase } from 'better-sqlite3'

// Vite bundles each migration .sql file as a raw string at build time and
// inlines it into the main-process bundle, so we don't need to ship the
// migrations directory alongside out/main/index.js in production builds.
const MIGRATIONS = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function listMigrationFiles(): Array<{ name: string; sql: string }> {
  return Object.entries(MIGRATIONS)
    .map(([path, sql]) => ({ name: path.split('/').pop()!, sql }))
    .filter(m => /^\d{4}_.+\.sql$/.test(m.name))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function currentUserVersion(db: BetterSqliteDatabase): number {
  return db.pragma('user_version', { simple: true }) as number
}

function setUserVersion(db: BetterSqliteDatabase, n: number): void {
  db.pragma(`user_version = ${n}`)
}

// Thin wrapper around better-sqlite3's batch SQL runner. Each .sql migration
// file is a multi-statement script applied atomically inside a transaction.
function runSql(db: BetterSqliteDatabase, sql: string): void {
  db.exec(sql)
}

export function runMigrations(db: BetterSqliteDatabase): void {
  const files = listMigrationFiles()
  if (files.length === 0) {
    console.warn('[db] no migration files bundled')
    return
  }

  const applied = currentUserVersion(db)
  const pending = files.filter((_, idx) => idx + 1 > applied)

  for (let i = 0; i < pending.length; i++) {
    const { name, sql } = pending[i]
    const version = applied + i + 1

    runSql(db, 'BEGIN')
    try {
      runSql(db, sql)
      setUserVersion(db, version)
      runSql(db, 'COMMIT')
      console.log(`[db] applied migration ${name} (user_version=${version})`)
    } catch (err) {
      runSql(db, 'ROLLBACK')
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`)
    }
  }
}
