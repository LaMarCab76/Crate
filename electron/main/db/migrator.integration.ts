import { strict as assert } from 'node:assert'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import {
  applyMigrationPlan,
  buildMigrationCatalog,
  normalizeLegacyOneDriveVersion,
  planMigrations,
  readUserVersion,
  repairLegacyOneDriveRows,
  type Migration,
} from './migrationCore.ts'

function realCatalog() {
  const directory = new URL('./migrations/', import.meta.url)
  return buildMigrationCatalog(Object.fromEntries(
    readdirSync(directory)
      .filter(name => name.endsWith('.sql'))
      .map(name => [`./migrations/${name}`, readFileSync(new URL(name, directory), 'utf8')]),
  ))
}

function migration(version: number, sql: string): Migration {
  return {
    version,
    name: `${String(version).padStart(4, '0')}_test.sql`,
    sql,
  }
}

const LEGACY_ONEDRIVE_SCHEMA = `
  ALTER TABLE tracks ADD COLUMN source TEXT NOT NULL DEFAULT 'local'
    CHECK (source IN ('local','onedrive'));
  ALTER TABLE tracks ADD COLUMN cloud_drive_id TEXT;
  ALTER TABLE tracks ADD COLUMN cloud_item_id TEXT;
  ALTER TABLE tracks ADD COLUMN cloud_etag TEXT;
  ALTER TABLE tracks ADD COLUMN cloud_remote_path TEXT;
  CREATE INDEX idx_tracks_cloud_item ON tracks(cloud_drive_id, cloud_item_id);

  ALTER TABLE folders ADD COLUMN source TEXT NOT NULL DEFAULT 'local'
    CHECK (source IN ('local','onedrive'));
  ALTER TABLE folders ADD COLUMN cloud_drive_id TEXT;
  ALTER TABLE folders ADD COLUMN cloud_item_id TEXT;
  ALTER TABLE folders ADD COLUMN cloud_delta_link TEXT;
`

function seedLegacyOneDriveProfile(db: Database.Database, catalog: readonly Migration[]): {
  localFolderId: number
  cloudFolderId: number
  localTrackId: number
  cloudTrackId: number
} {
  applyMigrationPlan(db, planMigrations(catalog.slice(0, 24), 0))
  db.exec(LEGACY_ONEDRIVE_SCHEMA)

  const timestamp = '2026-06-16T12:00:00.000Z'
  const insertFolder = db.prepare(`
    INSERT INTO folders (
      name, path, track_count, date_added, date_updated, bookmark_data,
      source, cloud_drive_id, cloud_item_id, cloud_delta_link
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `)
  const localFolderId = Number(insertFolder.run(
    'Local', '/music/local', 1, timestamp, timestamp, 'local', null, null, null,
  ).lastInsertRowid)
  const cloudFolderId = Number(insertFolder.run(
    'Music', 'onedrive://drive-legacy/root-item', 1, timestamp, timestamp,
    'onedrive', 'drive-legacy', 'root-item', 'https://graph.example/delta/cursor-7',
  ).lastInsertRowid)

  const insertTrack = db.prepare(`
    INSERT INTO tracks (
      path, filename, title, artist, album, duration, format, folder_id, date_added,
      source, cloud_drive_id, cloud_item_id, cloud_etag, cloud_remote_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const localTrackId = Number(insertTrack.run(
    '/music/local/local.flac', 'local.flac', 'Local', 'Artist', 'Album', 60,
    'FLAC', localFolderId, timestamp, 'local', null, null, null, null,
  ).lastInsertRowid)
  const cloudTrackId = Number(insertTrack.run(
    'onedrive://drive-legacy/song-item', 'song.flac', 'Cloud song', 'Artist', 'Album', 183.5,
    'FLAC', cloudFolderId, timestamp, 'onedrive', 'drive-legacy', 'song-item', 'etag-7',
    '/drives/drive-legacy/root:/Music/Album/song.flac',
  ).lastInsertRowid)

  const playlistId = Number(db.prepare(`
    INSERT INTO playlists (
      name, created_date, modified_date, track_count, total_duration
    ) VALUES ('Legacy playlist', ?, ?, 99, 999)
  `).run(timestamp, timestamp).lastInsertRowid)
  db.prepare(`
    INSERT INTO playlist_tracks (playlist_id, track_id, position, date_added)
    VALUES (?, ?, 0, ?)
  `).run(playlistId, cloudTrackId, timestamp)
  db.prepare(`
    UPDATE playlists SET track_count = 99, total_duration = 999 WHERE id = ?
  `).run(playlistId)

  // The old migrator counted files instead of parsing their numeric prefix.
  db.pragma('user_version = 25')
  return { localFolderId, cloudFolderId, localTrackId, cloudTrackId }
}

test('real migrations apply through 0030, resume, and are idempotent', () => {
  const catalog = realCatalog()
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    applyMigrationPlan(db, planMigrations(catalog.slice(0, 24), 0))
    assert.equal(readUserVersion(db), 24)

    applyMigrationPlan(db, planMigrations(catalog, 24))
    assert.equal(readUserVersion(db), 30)
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get('update_playlist_metrics_on_track_duration'))
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get('idx_download_jobs_active_reservation'))
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get('idx_folders_one_backup_per_source'))
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get('library_mirror_actions'))
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get('library_location_migration_runs'))
    assert.ok((db.pragma('table_info(folders)') as Array<{ name: string }>).some(column => column.name === 'display_icon'))

    applyMigrationPlan(db, planMigrations(catalog, 30))
    assert.equal(readUserVersion(db), 30)
  } finally {
    db.close()
  }
})

test('legacy origin/onedrive user_version 25 is normalized and backfilled safely', () => {
  const catalog = realCatalog()
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    const seeded = seedLegacyOneDriveProfile(db, catalog)

    assert.equal(readUserVersion(db), 25)
    assert.equal(normalizeLegacyOneDriveVersion(db), true)
    assert.equal(readUserVersion(db), 24)
    applyMigrationPlan(db, planMigrations(catalog, readUserVersion(db)))
    assert.equal(repairLegacyOneDriveRows(db), true)
    assert.equal(readUserVersion(db), 30)

    const localFolder = db.prepare(`SELECT * FROM folders WHERE id = ?`).get(seeded.localFolderId) as Record<string, unknown>
    const cloudFolder = db.prepare(`SELECT * FROM folders WHERE id = ?`).get(seeded.cloudFolderId) as Record<string, unknown>
    assert.equal(localFolder.provider, 'local')
    assert.equal(localFolder.role, 'library')
    assert.equal(cloudFolder.provider, 'onedrive')
    assert.equal(cloudFolder.role, 'library')
    assert.equal(cloudFolder.account_id, 'legacy-drive:drive-legacy')
    assert.equal(cloudFolder.drive_id, 'drive-legacy')
    assert.equal(cloudFolder.item_id, 'root-item')
    assert.equal(cloudFolder.remote_path, '/Music')
    assert.equal(cloudFolder.delta_cursor, 'https://graph.example/delta/cursor-7')

    const localTrack = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(seeded.localTrackId) as Record<string, unknown>
    const cloudTrack = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(seeded.cloudTrackId) as Record<string, unknown>
    assert.equal(localTrack.provider, 'local')
    assert.equal(cloudTrack.provider, 'onedrive')
    assert.equal(cloudTrack.path, 'onedrive://drive-legacy/song-item')
    assert.equal(cloudTrack.drive_id, 'drive-legacy')
    assert.equal(cloudTrack.item_id, 'song-item')
    assert.equal(cloudTrack.etag, 'etag-7')
    assert.equal(cloudTrack.remote_path, '/Music/Album/song.flac')

    const cloudIndex = (db.pragma('index_list(tracks)') as Array<{
      name: string
      unique: number
      partial: number
    }>).find(index => index.name === 'idx_tracks_cloud_item')
    assert.deepEqual(cloudIndex && { unique: cloudIndex.unique, partial: cloudIndex.partial }, {
      unique: 1,
      partial: 1,
    })
    assert.deepEqual(
      db.prepare(`SELECT track_count, total_duration FROM playlists WHERE name = 'Legacy playlist'`).get(),
      { track_count: 1, total_duration: 183.5 },
    )
    assert.ok(db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'trigger' AND name = 'update_playlist_metrics_on_track_duration'
    `).get())
    assert.equal(repairLegacyOneDriveRows(db), false)
  } finally {
    db.close()
  }
})

test('legacy rows already marked user_version 28 are repaired on startup', () => {
  const catalog = realCatalog()
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    const seeded = seedLegacyOneDriveProfile(db, catalog)
    assert.equal(normalizeLegacyOneDriveVersion(db), true)
    applyMigrationPlan(db, planMigrations(catalog, readUserVersion(db)))

    // Reproduce an older 0027 result: new columns/tables exist, cloud rows kept
    // their provider='local' defaults, and the legacy non-unique index survived.
    db.exec(`
      DROP INDEX idx_tracks_cloud_item;
      CREATE INDEX idx_tracks_cloud_item ON tracks(cloud_drive_id, cloud_item_id);
    `)
    db.pragma('user_version = 28')
    assert.equal(readUserVersion(db), 28)
    assert.equal(repairLegacyOneDriveRows(db), true)
    assert.equal(
      (db.prepare(`SELECT provider FROM folders WHERE id = ?`).get(seeded.cloudFolderId) as { provider: string }).provider,
      'onedrive',
    )
    assert.equal(
      (db.prepare(`SELECT provider FROM tracks WHERE id = ?`).get(seeded.cloudTrackId) as { provider: string }).provider,
      'onedrive',
    )
    assert.match(
      (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_tracks_cloud_item'`).get() as { sql: string }).sql,
      /CREATE UNIQUE INDEX/,
    )
  } finally {
    db.close()
  }
})

test('a failing migration rolls back itself, stops later work, and preserves prior commits', () => {
  const catalog = [
    migration(1, `CREATE TABLE first_commit (id INTEGER PRIMARY KEY); INSERT INTO first_commit VALUES (1);`),
    migration(2, `CREATE TABLE rolled_back (id INTEGER PRIMARY KEY); INSERT INTO rolled_back VALUES (1); INVALID SQL;`),
    migration(3, `CREATE TABLE must_not_run (id INTEGER PRIMARY KEY);`),
  ]
  const db = new Database(':memory:')
  try {
    assert.throws(
      () => applyMigrationPlan(db, planMigrations(catalog, 0)),
      /Migration 0002_test\.sql failed/,
    )
    assert.equal(readUserVersion(db), 1)
    assert.equal(db.inTransaction, false)
    assert.deepEqual(db.prepare('SELECT id FROM first_commit').all(), [{ id: 1 }])
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'rolled_back'`).get(), undefined)
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'must_not_run'`).get(), undefined)
  } finally {
    db.close()
  }
})

test('migration execution rejects an active outer transaction before running SQL', () => {
  const db = new Database(':memory:')
  try {
    db.exec('BEGIN')
    assert.throws(
      () => applyMigrationPlan(db, planMigrations([migration(1, 'CREATE TABLE no_run (id INTEGER);')], 0)),
      /cannot run inside an existing transaction/i,
    )
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'no_run'`).get(), undefined)
    db.exec('ROLLBACK')
  } finally {
    db.close()
  }
})

test('library locations enforce provider metadata, one backup per source, and delete restriction', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    const catalog = realCatalog()
    applyMigrationPlan(db, planMigrations(catalog, 0))
    const insertLocal = db.prepare(`
      INSERT INTO folders (name, path, track_count, date_added, date_updated, bookmark_data)
      VALUES (?, ?, 0, ?, ?, NULL)
    `)
    const timestamp = new Date().toISOString()
    const sourceId = Number(insertLocal.run('Source', '/music/source', timestamp, timestamp).lastInsertRowid)
    const backupId = Number(insertLocal.run('Backup', '/music/backup', timestamp, timestamp).lastInsertRowid)
    const otherId = Number(insertLocal.run('Other', '/music/other', timestamp, timestamp).lastInsertRowid)

    db.prepare(`UPDATE folders SET role = 'backup', backup_source_folder_id = ? WHERE id = ?`).run(sourceId, backupId)
    assert.throws(
      () => db.prepare(`UPDATE folders SET role = 'backup', backup_source_folder_id = ? WHERE id = ?`).run(sourceId, otherId),
      /UNIQUE constraint failed/,
    )
    assert.throws(() => db.prepare(`DELETE FROM folders WHERE id = ?`).run(sourceId), /FOREIGN KEY constraint failed/)
    assert.throws(
      () => db.prepare(`
        INSERT INTO folders (
          id, name, path, track_count, date_added, date_updated, bookmark_data,
          provider, role, backup_source_folder_id
        ) VALUES (99, 'Self', '/self', 0, ?, ?, NULL, 'local', 'backup', 99)
      `).run(timestamp, timestamp),
      /different source library/,
    )
    assert.throws(
      () => db.prepare(`UPDATE folders SET drive_id = 'invalid' WHERE id = ?`).run(sourceId),
      /local locations cannot carry OneDrive metadata/,
    )

    const cloud = db.prepare(`
      INSERT INTO folders (
        name, path, track_count, date_added, date_updated, bookmark_data,
        provider, role, account_id, drive_id, item_id, remote_path
      ) VALUES ('Cloud', 'onedrive://drive/item', 0, ?, ?, NULL,
                'onedrive', 'library', 'account', 'drive', 'item', '/Music')
    `).run(timestamp, timestamp)
    assert.ok(Number(cloud.lastInsertRowid) > 0)
    assert.throws(
      () => db.prepare(`
        INSERT INTO folders (
          name, path, track_count, date_added, date_updated, bookmark_data,
          provider, role, account_id, drive_id, item_id, remote_path
        ) VALUES ('Bad cloud', 'onedrive://wrong/path', 0, ?, ?, NULL,
                  'onedrive', 'library', 'account', 'drive-2', 'item-2', '/Music')
      `).run(timestamp, timestamp),
      /stable URI/,
    )
  } finally {
    db.close()
  }
})

test('a stale prepared plan skips compatible external progress and rejects future schemas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crate-migrator-'))
  const path = join(dir, 'migration.db')
  const first = new Database(path)
  const second = new Database(path)
  const catalog = [
    migration(1, 'CREATE TABLE one (id INTEGER);'),
    migration(2, 'CREATE TABLE two (id INTEGER);'),
    migration(3, 'CREATE TABLE three (id INTEGER);'),
  ]
  try {
    applyMigrationPlan(first, planMigrations(catalog.slice(0, 1), 0))
    const stalePlan = planMigrations(catalog, 1)

    applyMigrationPlan(second, planMigrations(catalog.slice(0, 2), 1))
    applyMigrationPlan(first, stalePlan)
    assert.equal(readUserVersion(first), 3)
    assert.ok(first.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'three'`).get())

    first.pragma('user_version = 1')
    const futurePlan = planMigrations(catalog, 1)
    second.pragma('user_version = 4')
    assert.throws(
      () => applyMigrationPlan(first, futurePlan),
      /newer than this application's maximum supported version 3/,
    )
  } finally {
    second.close()
    first.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
