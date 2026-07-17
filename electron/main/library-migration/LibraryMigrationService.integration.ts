import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import type { DbFolder } from '@shared/types/db'
import { applyMigrationPlan, buildMigrationCatalog, planMigrations } from '../db/migrationCore.ts'
import { LocalMirrorAdapter } from '../library-mirror/LocalMirrorAdapter.ts'
import { LibraryMigrationService } from './LibraryMigrationService.ts'

function migrate(db: Database.Database): void {
  const directory = new URL('../db/migrations/', import.meta.url)
  const catalog = buildMigrationCatalog(Object.fromEntries(
    readdirSync(directory)
      .filter(name => name.endsWith('.sql'))
      .map(name => [`./migrations/${name}`, readFileSync(new URL(name, directory), 'utf8')]),
  ))
  applyMigrationPlan(db, planMigrations(catalog, 0))
}

function addFolder(db: Database.Database, path: string, name: string): DbFolder {
  const timestamp = new Date().toISOString()
  const id = Number(db.prepare(`
    INSERT INTO folders (name, path, track_count, date_added, date_updated, provider, role)
    VALUES (?, ?, 0, ?, ?, 'local', 'library')
  `).run(name, path, timestamp, timestamp).lastInsertRowid)
  return db.prepare(`SELECT * FROM folders WHERE id = ?`).get(id) as DbFolder
}

function addBackupFolder(db: Database.Database, sourceFolderId: number, path: string, name: string): DbFolder {
  const timestamp = new Date().toISOString()
  const id = Number(db.prepare(`
    INSERT INTO folders (
      name, path, track_count, date_added, date_updated, provider, role, backup_source_folder_id
    ) VALUES (?, ?, 0, ?, ?, 'local', 'backup', ?)
  `).run(name, path, timestamp, timestamp, sourceFolderId).lastInsertRowid)
  return db.prepare(`SELECT * FROM folders WHERE id = ?`).get(id) as DbFolder
}

function addTrack(db: Database.Database, folderId: number, path: string, state: {
  playCount?: number
  favorite?: number
  stateUpdatedAt?: number
} = {}): number {
  const timestamp = new Date().toISOString()
  return Number(db.prepare(`
    INSERT INTO tracks (
      path, filename, title, artist, album, duration, format, folder_id,
      date_added, provider, play_count, is_favorite, state_updated_at
    ) VALUES (?, 'song.flac', 'Song', 'Artist', 'Album', 60, 'FLAC', ?, ?, 'local', ?, ?, ?)
  `).run(
    path,
    folderId,
    timestamp,
    state.playCount ?? 0,
    state.favorite ?? 0,
    state.stateUpdatedAt ?? null,
  ).lastInsertRowid)
}

function temporaryFolder(path: string, name: string): DbFolder {
  const timestamp = new Date().toISOString()
  return {
    id: 0,
    name,
    path,
    track_count: 0,
    date_added: timestamp,
    date_updated: timestamp,
    bookmark_data: null,
    provider: 'local',
    role: 'library',
    backup_source_folder_id: null,
    account_id: null,
    drive_id: null,
    item_id: null,
    remote_path: null,
    delta_cursor: null,
    display_icon: null,
  }
}

test('local relocation preserves folder and track identities and keeps the original by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crate-migrate-relocate-'))
  const sourcePath = join(root, 'source')
  const targetPath = join(root, 'target')
  mkdirSync(sourcePath)
  mkdirSync(targetPath)
  writeFileSync(join(sourcePath, 'song.flac'), Buffer.from('lossless audio bytes'))
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    migrate(db)
    const source = addFolder(db, sourcePath, 'Source')
    const trackId = addTrack(db, source.id, join(sourcePath, 'song.flac'))
    const service = new LibraryMigrationService({ db, adapters: [new LocalMirrorAdapter()] })
    const planned = await service.create({
      sourceFolderId: source.id,
      mode: 'relocate',
      target: { folder: temporaryFolder(targetPath, 'Moved'), existingFolderId: null },
      sourceDisposition: 'keep',
    })
    assert.equal(planned.status, 'awaiting_approval')
    service.approve(planned.runId)
    const completed = await service.waitForIdle(planned.runId)
    assert.equal(completed.status, 'completed')
    const folder = db.prepare(`SELECT * FROM folders WHERE id = ?`).get(source.id) as DbFolder
    assert.equal(folder.path, targetPath)
    assert.equal(folder.name, 'Moved')
    const track = db.prepare(`SELECT id, folder_id, path FROM tracks WHERE id = ?`).get(trackId) as { id: number; folder_id: number; path: string }
    assert.deepEqual(track, { id: trackId, folder_id: source.id, path: join(targetPath, 'song.flac') })
    assert.equal(readFileSync(join(targetPath, 'song.flac'), 'utf8'), 'lossless audio bytes')
    assert.equal(readFileSync(join(sourcePath, 'song.flac'), 'utf8'), 'lossless audio bytes')
    await service.dispose()
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('merge deduplicates identical files and redirects playlist and user state to the target row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crate-migrate-merge-'))
  const sourcePath = join(root, 'source')
  const targetPath = join(root, 'target')
  mkdirSync(sourcePath)
  mkdirSync(targetPath)
  writeFileSync(join(sourcePath, 'song.flac'), Buffer.from('same bytes'))
  writeFileSync(join(targetPath, 'song.flac'), Buffer.from('same bytes'))
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    migrate(db)
    const source = addFolder(db, sourcePath, 'Incoming')
    const target = addFolder(db, targetPath, 'Canonical')
    const sourceTrackId = addTrack(db, source.id, join(sourcePath, 'song.flac'), { playCount: 9, favorite: 1, stateUpdatedAt: 20 })
    const targetTrackId = addTrack(db, target.id, join(targetPath, 'song.flac'), { playCount: 2, favorite: 0, stateUpdatedAt: 10 })
    const timestamp = new Date().toISOString()
    const playlistId = Number(db.prepare(`
      INSERT INTO playlists (name, created_date, modified_date, track_count, total_duration)
      VALUES ('Merge', ?, ?, 0, 0)
    `).run(timestamp, timestamp).lastInsertRowid)
    db.prepare(`INSERT INTO playlist_tracks (playlist_id, track_id, position, date_added) VALUES (?, ?, 0, ?)`)
      .run(playlistId, sourceTrackId, timestamp)

    const service = new LibraryMigrationService({ db, adapters: [new LocalMirrorAdapter()] })
    const planned = await service.create({
      sourceFolderId: source.id,
      mode: 'merge',
      target: { folder: target, existingFolderId: target.id },
      sourceDisposition: 'keep',
      unifiedBackup: { kind: 'none' },
    })
    assert.equal(planned.identicalFiles, 1)
    service.approve(planned.runId)
    const completed = await service.waitForIdle(planned.runId)
    assert.equal(completed.status, 'completed')
    assert.equal(db.prepare(`SELECT 1 FROM folders WHERE id = ?`).get(source.id), undefined)
    const canonical = db.prepare(`SELECT id, play_count, is_favorite FROM tracks WHERE id = ?`).get(targetTrackId)
    assert.deepEqual(canonical, { id: targetTrackId, play_count: 9, is_favorite: 1 })
    assert.equal(db.prepare(`SELECT 1 FROM tracks WHERE id = ?`).get(sourceTrackId), undefined)
    assert.deepEqual(
      db.prepare(`SELECT track_id FROM playlist_tracks WHERE playlist_id = ?`).get(playlistId),
      { track_id: targetTrackId },
    )
    await service.dispose()
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('backup relocation preserves its relation and reserves an unregistered target across active runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crate-migrate-backup-'))
  const libraryPath = join(root, 'library')
  const backupPath = join(root, 'backup')
  const backupTargetPath = join(root, 'backup-target')
  const otherPath = join(root, 'other')
  for (const path of [libraryPath, backupPath, backupTargetPath, otherPath]) mkdirSync(path)
  writeFileSync(join(backupPath, 'song.flac'), Buffer.from('backup bytes'))
  writeFileSync(join(otherPath, 'other.flac'), Buffer.from('other bytes'))
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    migrate(db)
    const library = addFolder(db, libraryPath, 'Library')
    const backup = addBackupFolder(db, library.id, backupPath, 'Library backup')
    const other = addFolder(db, otherPath, 'Other library')
    addTrack(db, other.id, join(otherPath, 'other.flac'))
    const service = new LibraryMigrationService({ db, adapters: [new LocalMirrorAdapter()] })
    const planned = await service.create({
      sourceFolderId: backup.id,
      mode: 'relocate',
      target: { folder: temporaryFolder(backupTargetPath, 'Moved backup'), existingFolderId: null },
      sourceDisposition: 'keep',
    })

    await assert.rejects(
      service.create({
        sourceFolderId: other.id,
        mode: 'relocate',
        target: { folder: temporaryFolder(backupTargetPath, 'Same target'), existingFolderId: null },
        sourceDisposition: 'keep',
      }),
      /reservado por otra migración activa/i,
    )

    service.approve(planned.runId)
    assert.equal((await service.waitForIdle(planned.runId)).status, 'completed')
    const moved = db.prepare(`SELECT * FROM folders WHERE id = ?`).get(backup.id) as DbFolder
    assert.equal(moved.path, backupTargetPath)
    assert.equal(moved.role, 'backup')
    assert.equal(moved.backup_source_folder_id, library.id)
    assert.equal(readFileSync(join(backupTargetPath, 'song.flac'), 'utf8'), 'backup bytes')
    assert.equal(readFileSync(join(backupPath, 'song.flac'), 'utf8'), 'backup bytes')
    await service.dispose()
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
