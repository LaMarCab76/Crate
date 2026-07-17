import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { applyMigrationPlan, buildMigrationCatalog, planMigrations } from '../migrationCore.ts'
import { FolderRepo } from './FolderRepo.ts'

function migratedDatabase(): Database.Database {
  const db = new Database(':memory:')
  const directory = new URL('../migrations/', import.meta.url)
  const catalog = buildMigrationCatalog(Object.fromEntries(
    readdirSync(directory)
      .filter(name => name.endsWith('.sql'))
      .map(name => [`./migrations/${name}`, readFileSync(new URL(name, directory), 'utf8')]),
  ))
  db.pragma('foreign_keys = ON')
  applyMigrationPlan(db, planMigrations(catalog, 0))
  return db
}

function insertTrack(db: Database.Database, folderId: number, path: string): number {
  return Number(db.prepare(`
    INSERT INTO tracks (
      path, filename, title, artist, album, duration, format, folder_id, date_added
    ) VALUES (?, 'song.flac', 'Song', 'Artist', 'Album', 1, 'FLAC', ?, ?)
  `).run(path, folderId, new Date().toISOString()).lastInsertRowid)
}

test('track existence is authoritative even when folders.track_count is stale', () => {
  const db = migratedDatabase()
  try {
    const folders = new FolderRepo(db)
    const folder = folders.add('/music/catalog', 'Catalog')

    db.prepare(`UPDATE folders SET track_count = 99 WHERE id = ?`).run(folder.id)
    assert.equal(folders.hasTracks(folder.id), false)

    insertTrack(db, folder.id, '/music/catalog/song.flac')
    db.prepare(`UPDATE folders SET track_count = 0 WHERE id = ?`).run(folder.id)
    assert.equal(folders.hasTracks(folder.id), true)
  } finally {
    db.close()
  }
})

test('new backup registration and assignment are atomic on validation failures', () => {
  const db = migratedDatabase()
  try {
    const folders = new FolderRepo(db)
    const source = folders.add('/music/source', 'Source')
    const first = folders.addLocalBackup(source.id, '/backups/source', 'Backup')
    assert.equal(first.role, 'backup')
    assert.equal(first.backup_source_folder_id, source.id)

    assert.throws(
      () => folders.addLocalBackup(source.id, '/backups/ghost', 'Ghost'),
      /already has a backup/i,
    )
    assert.equal(folders.getByPath('/backups/ghost'), undefined)

    const secondSource = folders.add('/music/second', 'Second')
    assert.throws(
      () => folders.addLocalBackup(secondSource.id, '/music/second/nested', 'Overlap'),
      /same or overlap/i,
    )
    assert.equal(folders.getByPath('/music/second/nested'), undefined)
  } finally {
    db.close()
  }
})

test('a library that owns a backup cannot become a backup and keeps its catalog', () => {
  const db = migratedDatabase()
  try {
    const folders = new FolderRepo(db)
    const destination = folders.add('/music/destination', 'Destination')
    const destinationBackup = folders.add('/backups/destination', 'Destination backup')
    const source = folders.add('/music/source', 'Source')
    const trackId = insertTrack(db, destination.id, '/music/destination/song.flac')
    folders.assignBackup(destination.id, destinationBackup.id)

    assert.throws(
      () => folders.assignBackup(source.id, destination.id),
      /with its own linked backup/i,
    )
    assert.ok(db.prepare(`SELECT id FROM tracks WHERE id = ?`).get(trackId))
    assert.equal(folders.getById(destination.id)?.role, 'library')
  } finally {
    db.close()
  }
})

test('OneDrive combinations and remote destination overlaps are revalidated transactionally', () => {
  const db = migratedDatabase()
  try {
    const folders = new FolderRepo(db)
    const cloudSource = folders.addOneDrive({
      accountId: 'account',
      driveId: 'drive',
      itemId: 'source',
      name: 'Cloud source',
      remotePath: '/Music',
    })
    const cloudBackup = folders.addOneDriveBackup(cloudSource.id, {
      accountId: 'account',
      driveId: 'drive',
      itemId: 'backup',
      name: 'Cloud backup',
      remotePath: '/Backup',
    })
    assert.equal(cloudBackup.role, 'backup')
    assert.equal(cloudBackup.backup_source_folder_id, cloudSource.id)

    const localSource = folders.add('/music/local', 'Local')
    assert.throws(
      () => folders.addOneDriveBackup(localSource.id, {
        accountId: 'account',
        driveId: 'drive',
        itemId: 'nested',
        name: 'Nested cloud root',
        remotePath: '/Music/Nested',
      }),
      /overlaps registered location/i,
    )
    assert.equal(folders.getByPath('onedrive://drive/nested'), undefined)

    folders.unlinkBackup(cloudBackup.id)
    const cloudToLocal = folders.addLocalBackup(cloudSource.id, '/backups/cloud', 'Cloud backup')
    assert.equal(cloudToLocal.role, 'backup')
    assert.equal(cloudToLocal.backup_source_folder_id, cloudSource.id)
  } finally {
    db.close()
  }
})
