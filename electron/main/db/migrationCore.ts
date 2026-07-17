import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { posix } from 'node:path'

export interface Migration {
  version: number
  name: string
  sql: string
}

export interface MigrationPlan {
  currentVersion: number
  targetVersion: number
  pending: readonly Migration[]
}

const MIGRATION_NAME = /^(\d{4})_([^/]+)\.sql$/

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function formatVersion(version: number): string {
  return String(version).padStart(4, '0')
}

export function buildMigrationCatalog(
  sources: Readonly<Record<string, string>>,
): readonly Migration[] {
  const entries = Object.entries(sources)
  if (entries.length === 0) throw new Error('No migration files were bundled.')

  const migrations = entries.map(([path, sql]) => {
    const name = basename(path)
    const match = MIGRATION_NAME.exec(name)
    if (!match) throw new Error(`Invalid migration filename: ${name}`)
    const version = Number(match[1])
    if (version <= 0) throw new Error(`Migration versions must start at 0001: ${name}`)
    return { version, name, sql }
  }).sort((a, b) => a.version - b.version || compareNames(a.name, b.name))

  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index]
    const previous = migrations[index - 1]
    if (previous?.version === migration.version) {
      const names = [previous.name, migration.name].sort(compareNames)
      throw new Error(
        `Duplicate migration version ${formatVersion(migration.version)}: ${names.join(', ')}`,
      )
    }
    const expected = index + 1
    if (migration.version !== expected) {
      throw new Error(
        `Missing migration ${formatVersion(expected)} before ${migration.name}.`,
      )
    }
  }

  return migrations
}

export function planMigrations(
  catalog: readonly Migration[],
  currentVersion: number,
): MigrationPlan {
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new Error(`Invalid database schema version: ${String(currentVersion)}`)
  }
  if (catalog.length === 0) throw new Error('No migration files were bundled.')

  const targetVersion = catalog[catalog.length - 1].version
  if (currentVersion > targetVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than this application's maximum supported version ${targetVersion}.`,
    )
  }

  return {
    currentVersion,
    targetVersion,
    pending: catalog.filter(migration => migration.version > currentVersion),
  }
}

export function readUserVersion(db: BetterSqliteDatabase): number {
  return db.pragma('user_version', { simple: true }) as number
}

interface TableColumnRow {
  name: string
}

interface LegacyCloudFolderRow {
  id: number
  name: string
  path: string
  cloud_drive_id: string | null
  cloud_item_id: string | null
  cloud_delta_link: string | null
}

interface LegacyCloudTrackRow {
  id: number
  folder_id: number
  filename: string
  path: string
  cloud_drive_id: string | null
  cloud_item_id: string | null
  cloud_etag: string | null
  cloud_remote_path: string | null
}

function tableColumns(db: BetterSqliteDatabase, table: 'folders' | 'tracks'): Set<string> {
  return new Set(
    (db.pragma(`table_info(${table})`) as TableColumnRow[]).map(column => column.name),
  )
}

function hasColumns(columns: Set<string>, expected: readonly string[]): boolean {
  return expected.every(column => columns.has(column))
}

function hasLegacyOneDriveColumns(db: BetterSqliteDatabase): boolean {
  return hasColumns(tableColumns(db, 'folders'), [
    'source', 'cloud_drive_id', 'cloud_item_id', 'cloud_delta_link',
  ]) && hasColumns(tableColumns(db, 'tracks'), [
    'source', 'cloud_drive_id', 'cloud_item_id', 'cloud_etag', 'cloud_remote_path',
  ])
}

function hasLibraryLocationColumns(db: BetterSqliteDatabase): boolean {
  return hasColumns(tableColumns(db, 'folders'), [
    'provider', 'role', 'account_id', 'drive_id', 'item_id', 'remote_path', 'delta_cursor',
  ]) && hasColumns(tableColumns(db, 'tracks'), [
    'provider', 'drive_id', 'item_id', 'etag', 'remote_path', 'quickxor_hash',
  ])
}

/**
 * `origin/onedrive` shipped two lexicographically ordered 0022 files under the
 * old ordinal migrator. A fully migrated profile therefore reports version 25,
 * even though it never ran today's 0025 migration. Rewind only that exact
 * schema fingerprint so the current numbered catalog applies 0025 and 0026.
 */
export function normalizeLegacyOneDriveVersion(db: BetterSqliteDatabase): boolean {
  if (readUserVersion(db) !== 25 || !hasLegacyOneDriveColumns(db)) return false
  if (tableColumns(db, 'folders').has('provider')) return false

  return db.transaction(() => {
    if (readUserVersion(db) !== 25 || !hasLegacyOneDriveColumns(db)) return false
    if (tableColumns(db, 'folders').has('provider')) return false
    db.pragma('user_version = 24')
    return true
  }).immediate()
}

function parseOneDriveUri(value: string): { driveId: string; itemId: string } | null {
  const match = /^onedrive:\/\/([^/]+)\/([^/]+)$/.exec(value)
  if (!match) return null
  return { driveId: match[1], itemId: match[2] }
}

function normalizeLegacyRemotePath(value: string | null): string | null {
  if (!value?.trim()) return null
  const graphPath = value.trim().replace(/^.*root:/i, '')
  const normalized = posix.normalize(graphPath.startsWith('/') ? graphPath : `/${graphPath}`)
  return normalized === '.' ? '/' : normalized
}

function safeFolderFallback(name: string, itemId: string): string {
  const leaf = name.trim().replaceAll('/', '_') || `legacy-${itemId}`
  return normalizeLegacyRemotePath(`/legacy-${itemId}-${leaf}`) ?? `/legacy-${itemId}`
}

function deriveLegacyFolderRemotePath(
  folder: LegacyCloudFolderRow,
  tracks: readonly LegacyCloudTrackRow[],
  itemId: string,
): string {
  const leaf = folder.name.trim().toLocaleLowerCase('en-US')
  const candidates = tracks.flatMap(track => {
    const remotePath = normalizeLegacyRemotePath(track.cloud_remote_path)
    if (!remotePath || !leaf) return []
    const parts = remotePath.split('/').filter(Boolean)
    let index = -1
    for (let cursor = parts.length - 1; cursor >= 0; cursor--) {
      if (parts[cursor].toLocaleLowerCase('en-US') === leaf) {
        index = cursor
        break
      }
    }
    return index < 0 ? [] : [`/${parts.slice(0, index + 1).join('/')}`]
  })
  if (candidates.length > 0 && candidates.every(candidate => candidate === candidates[0])) {
    return candidates[0]
  }
  return safeFolderFallback(folder.name, itemId)
}

function cloudIndexIsUnique(db: BetterSqliteDatabase): boolean {
  const row = db.prepare<[], { sql: string | null }>(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_tracks_cloud_item'
  `).get()
  return Boolean(row?.sql && /CREATE\s+UNIQUE\s+INDEX/i.test(row.sql) && /\bprovider\b/i.test(row.sql))
}

/**
 * Backfill the cloud rows created by the legacy OneDrive build into the
 * first-class location schema. This runs after numbered migrations as well as
 * for databases already marked version 28, because an older 0027 could have
 * left every legacy cloud row mislabeled as local.
 */
export function repairLegacyOneDriveRows(db: BetterSqliteDatabase): boolean {
  if (!hasLegacyOneDriveColumns(db) || !hasLibraryLocationColumns(db)) return false

  const pendingFolders = db.prepare<[], LegacyCloudFolderRow>(`
    SELECT id, name, path, cloud_drive_id, cloud_item_id, cloud_delta_link
    FROM folders WHERE source = 'onedrive' AND provider <> 'onedrive'
    ORDER BY id
  `).all()
  const pendingTracks = db.prepare<[], LegacyCloudTrackRow>(`
    SELECT id, folder_id, filename, path, cloud_drive_id, cloud_item_id,
           cloud_etag, cloud_remote_path
    FROM tracks WHERE source = 'onedrive' AND provider <> 'onedrive'
    ORDER BY id
  `).all()
  const repairIndex = !cloudIndexIsUnique(db)
  if (pendingFolders.length === 0 && pendingTracks.length === 0 && !repairIndex) return false

  return db.transaction(() => {
    const tracksByFolder = new Map<number, LegacyCloudTrackRow[]>()
    for (const track of pendingTracks) {
      const rows = tracksByFolder.get(track.folder_id) ?? []
      rows.push(track)
      tracksByFolder.set(track.folder_id, rows)
    }

    db.exec('DROP INDEX IF EXISTS idx_tracks_cloud_item')

    const updateFolder = db.prepare(`
      UPDATE folders
      SET path = ?, provider = 'onedrive', role = 'library',
          backup_source_folder_id = NULL, account_id = ?, drive_id = ?, item_id = ?,
          remote_path = ?, delta_cursor = ?
      WHERE id = ? AND source = 'onedrive' AND provider <> 'onedrive'
    `)
    const repairedFolders = new Map<number, { driveId: string; remotePath: string }>()
    for (const folder of pendingFolders) {
      const uri = parseOneDriveUri(folder.path)
      const driveId = folder.cloud_drive_id?.trim() || uri?.driveId
      const itemId = folder.cloud_item_id?.trim() || uri?.itemId
      if (!driveId || !itemId) {
        throw new Error(`Cannot repair legacy OneDrive folder ${folder.id}: drive/item identity is missing.`)
      }
      const remotePath = deriveLegacyFolderRemotePath(
        folder,
        tracksByFolder.get(folder.id) ?? [],
        itemId,
      )
      const stablePath = `onedrive://${driveId}/${itemId}`
      const result = updateFolder.run(
        stablePath,
        `legacy-drive:${driveId}`,
        driveId,
        itemId,
        remotePath,
        folder.cloud_delta_link,
        folder.id,
      )
      if (result.changes !== 1) throw new Error(`Legacy OneDrive folder ${folder.id} changed during repair.`)
      repairedFolders.set(folder.id, { driveId, remotePath })
    }

    const updateTrack = db.prepare(`
      UPDATE tracks
      SET path = ?, provider = 'onedrive', drive_id = ?, item_id = ?, etag = ?,
          remote_path = ?, quickxor_hash = NULL
      WHERE id = ? AND source = 'onedrive' AND provider <> 'onedrive'
    `)
    for (const track of pendingTracks) {
      const repairedFolder = repairedFolders.get(track.folder_id)
      const existingFolder = repairedFolder ? undefined : db.prepare<[number], {
        provider: string
        drive_id: string | null
        remote_path: string | null
      }>('SELECT provider, drive_id, remote_path FROM folders WHERE id = ?').get(track.folder_id)
      const folderDriveId = repairedFolder?.driveId ?? existingFolder?.drive_id
      const folderRemotePath = repairedFolder?.remotePath ?? existingFolder?.remote_path ?? '/'
      if (!folderDriveId || (!repairedFolder && existingFolder?.provider !== 'onedrive')) {
        throw new Error(`Cannot repair legacy OneDrive track ${track.id}: its folder is not a cloud library.`)
      }
      const uri = parseOneDriveUri(track.path)
      const driveId = track.cloud_drive_id?.trim() || uri?.driveId || folderDriveId
      const itemId = track.cloud_item_id?.trim() || uri?.itemId
      if (!driveId || !itemId || driveId !== folderDriveId) {
        throw new Error(`Cannot repair legacy OneDrive track ${track.id}: drive/item identity is invalid.`)
      }
      const remotePath = normalizeLegacyRemotePath(track.cloud_remote_path)
        ?? posix.join(folderRemotePath, track.filename)
      const result = updateTrack.run(
        `onedrive://${driveId}/${itemId}`,
        driveId,
        itemId,
        track.cloud_etag,
        remotePath,
        track.id,
      )
      if (result.changes !== 1) throw new Error(`Legacy OneDrive track ${track.id} changed during repair.`)
    }

    db.exec(`
      CREATE UNIQUE INDEX idx_tracks_cloud_item
      ON tracks(provider, drive_id, item_id)
      WHERE provider = 'onedrive'
    `)
    return true
  }).immediate()
}

export function applyMigrationPlan(
  db: BetterSqliteDatabase,
  plan: MigrationPlan,
): void {
  if (db.inTransaction) {
    throw new Error('Migrations cannot run inside an existing transaction.')
  }

  const observed = readUserVersion(db)
  if (!Number.isInteger(observed) || observed < 0) {
    throw new Error(`Invalid database schema version: ${String(observed)}`)
  }
  if (observed < plan.currentVersion) {
    throw new Error(
      `Database schema version moved backwards from ${plan.currentVersion} to ${observed} after migration preparation.`,
    )
  }
  if (observed > plan.targetVersion) {
    throw new Error(
      `Database schema version ${observed} is newer than this application's maximum supported version ${plan.targetVersion}.`,
    )
  }

  for (const migration of plan.pending) {
    const applyOne = db.transaction((): boolean => {
      const actual = readUserVersion(db)
      if (actual > plan.targetVersion) {
        throw new Error(
          `Database schema version ${actual} is newer than this application's maximum supported version ${plan.targetVersion}.`,
        )
      }
      if (actual >= migration.version) return false
      if (actual !== migration.version - 1) {
        throw new Error(
          `Cannot apply migration ${migration.name}: database is at version ${actual}, expected ${migration.version - 1}.`,
        )
      }

      db.exec(migration.sql)
      db.pragma(`user_version = ${migration.version}`)
      return true
    }).immediate

    try {
      if (applyOne()) {
        console.log(`[db] applied migration ${migration.name} (user_version=${migration.version})`)
      }
    } catch (error) {
      throw new Error(`Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      })
    }
  }

  const finalVersion = readUserVersion(db)
  if (finalVersion !== plan.targetVersion) {
    throw new Error(
      `Migration run ended at schema version ${finalVersion}; expected ${plan.targetVersion}.`,
    )
  }
}
