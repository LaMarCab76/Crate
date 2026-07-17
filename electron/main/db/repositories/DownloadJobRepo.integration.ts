import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { DownloadJobRepo } from './DownloadJobRepo.ts'

const MIGRATION_SQL = readFileSync(
  new URL('../migrations/0026_download_job_reservations.sql', import.meta.url),
  'utf8',
)

function createDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE folders (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
    INSERT INTO folders (id, path) VALUES (1, '/music');
    CREATE TABLE download_jobs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_track_id TEXT NOT NULL,
      status TEXT NOT NULL,
      quality TEXT NOT NULL,
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      artwork_url TEXT,
      source_url TEXT,
      metadata_json TEXT,
      path TEXT,
      error TEXT,
      bytes_received INTEGER NOT NULL DEFAULT 0,
      bytes_total INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `)
  return db
}

function insertLegacyJob(db: Database.Database, id: string, createdAt: number): void {
  db.prepare(`
    INSERT INTO download_jobs (
      id, provider, provider_track_id, status, quality, folder_id,
      title, artist, album, bytes_received, created_at, updated_at
    ) VALUES (?, 'qobuz', 'track-1', 'queued', 'lossless', 1, 'Title', 'Artist', 'Album', 0, ?, ?)
  `).run(id, createdAt, createdAt)
}

test('migration retires legacy duplicates and repository reserves and claims atomically', () => {
  const db = createDatabase()
  try {
    insertLegacyJob(db, 'keeper', 1)
    insertLegacyJob(db, 'duplicate', 2)
    db.exec(MIGRATION_SQL)

    const statuses = db.prepare('SELECT id, status FROM download_jobs ORDER BY id').all() as Array<{
      id: string
      status: string
    }>
    assert.deepEqual(statuses, [
      { id: 'duplicate', status: 'cancelled' },
      { id: 'keeper', status: 'queued' },
    ])

    const repo = new DownloadJobRepo(db)
    const track = {
      provider: 'qobuz' as const,
      providerTrackId: 'track-1',
      title: 'Title',
      artist: 'Artist',
      album: 'Album',
      durationSec: 180,
      artworkUrl: null,
      qualityLabel: null,
      bitDepth: null,
      sampleRate: null,
      explicit: false,
      availability: 'downloadable' as const,
      unavailableReason: null,
      sourceUrl: null,
    }

    const duplicateReservation = repo.reserve(track, { id: 'not-created', folderId: 1, quality: 'lossless' })
    assert.equal(duplicateReservation.created, false)
    assert.equal(duplicateReservation.job.id, 'keeper')

    repo.setStatus('keeper', 'completed')
    const fresh = repo.reserve(track, { id: 'fresh', folderId: 1, quality: 'lossless' })
    assert.equal(fresh.created, true)
    assert.equal(fresh.job.id, 'fresh')

    assert.equal(repo.claimQueued('fresh')?.status, 'authenticating')
    assert.equal(repo.claimQueued('fresh'), null)

    const interrupted = repo.recoverInterrupted()
    assert.equal(interrupted.some(job => job.id === 'fresh'), true)
    assert.equal(repo.getById('fresh')?.status, 'queued')

    const retry = repo.resetForRetry('keeper')
    assert.equal(retry?.id, 'fresh')
    assert.equal(repo.getById('keeper')?.status, 'completed')
  } finally {
    db.close()
  }
})
