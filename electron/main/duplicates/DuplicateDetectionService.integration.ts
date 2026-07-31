import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { applyMigrationPlan, buildMigrationCatalog, planMigrations } from '../db/migrationCore.ts'
import { DuplicateDetectionService } from './DuplicateDetectionService.ts'
import { DuplicateRepository } from './DuplicateRepository.ts'
import { UnavailableFingerprintProvider } from './fingerprint.ts'
import type {
  AudioFingerprint,
  FingerprintProvider,
  FingerprintSource,
} from './fingerprint.ts'

function migratedDatabase(): Database.Database {
  const directory = new URL('../db/migrations/', import.meta.url)
  const catalog = buildMigrationCatalog(Object.fromEntries(
    readdirSync(directory)
      .filter(name => name.endsWith('.sql'))
      .map(name => [`./migrations/${name}`, readFileSync(new URL(name, directory), 'utf8')]),
  ))
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrationPlan(db, planMigrations(catalog, 0))
  return db
}

function seedPair(db: Database.Database): { leftId: number; rightId: number } {
  const now = '2026-01-01T00:00:00.000Z'
  const folderId = Number(db.prepare(`
    INSERT INTO folders (name, path, date_added, date_updated)
    VALUES ('Main library', '/music', ?, ?)
  `).run(now, now).lastInsertRowid)
  const insertAlbum = db.prepare(`
    INSERT INTO albums (
      title, normalized_name, sort_name, album_artist, year, release_type,
      is_compilation, date_added
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const compilationId = Number(insertAlbum.run(
    'Collection', 'collection', 'collection', 'Various Artists', '2020', 'compilation', 1, now,
  ).lastInsertRowid)
  const artistAlbumId = Number(insertAlbum.run(
    'Artist Album', 'artist album', 'artist album', 'Artist', '2020', 'album', 0, now,
  ).lastInsertRowid)
  const insertTrack = db.prepare(`
    INSERT INTO tracks (
      path, filename, title, artist, album, album_artist, duration, format,
      codec, bitrate, sample_rate, bit_depth, channels, folder_id, album_id,
      file_size, date_modified, date_added, compilation
    ) VALUES (?, ?, ?, 'Artist', ?, ?, 200, ?, ?, ?, ?, ?, 2, ?, ?, 10000, ?, ?, ?)
  `)
  const leftId = Number(insertTrack.run(
    '/music/collection.mp3', 'collection.mp3', 'Song (Remastered)',
    'Collection', 'Various Artists', 'MP3', 'MPEG Layer 3', 320_000, 44_100, 16,
    folderId, compilationId, now, now, 1,
  ).lastInsertRowid)
  const rightId = Number(insertTrack.run(
    '/music/album.flac', 'album.flac', 'Song',
    'Artist Album', 'Artist', 'FLAC', 'FLAC', 900_000, 96_000, 24,
    folderId, artistAlbumId, now, '2026-01-02T00:00:00.000Z', 0,
  ).lastInsertRowid)
  return { leftId, rightId }
}

class DeterministicProvider implements FingerprintProvider {
  readonly algorithm = 'test-fingerprint'
  readonly algorithmVersion = '1'
  calls = 0
  readonly changedTracks = new Set<number>()

  async fingerprint(source: FingerprintSource): Promise<AudioFingerprint> {
    this.calls += 1
    const values = [
      0x00000000, 0xffffffff, 0xaaaaaaaa, 0x55555555, 0x0f0f0f0f,
      0xf0f0f0f0, 0x33333333, 0xcccccccc, 0xff00ff00, 0x00ff00ff,
    ]
    if (this.changedTracks.has(source.trackId)) values[0] = 0x12345678
    const frames = Uint32Array.from(values)
    return {
      algorithm: this.algorithm,
      algorithmVersion: this.algorithmVersion,
      framesPerSecond: 1,
      durationSeconds: source.trackId > 0 ? 10 : 0,
      frames,
    }
  }
}

test('persists pair analysis, reuses fingerprints and orients the recommendation to the right', async () => {
  const db = migratedDatabase()
  try {
    const ids = seedPair(db)
    const repo = new DuplicateRepository(db)
    const provider = new DeterministicProvider()
    let comparisonYields = 0
    const service = new DuplicateDetectionService(repo, provider, undefined, {
      comparisonYieldBudgetMs: 0,
      yieldToEventLoop: async () => { comparisonYields += 1 },
    })
    const progress: string[] = []
    service.onProgress(event => progress.push(event.phase))

    const first = await service.analyze()
    assert.equal(first.candidatePairs, 1)
    assert.equal(first.fingerprintsCreated, 2)
    assert.equal(first.detected, 1)
    assert.equal(provider.calls, 2)
    assert.equal(service.getSummary().pendingCount, 1)
    const candidate = service.listCandidates()[0]
    assert.equal(candidate.left.id, ids.leftId)
    assert.equal(candidate.right.id, ids.rightId)
    assert.equal(candidate.recommendedTrackId, ids.rightId)
    assert.equal(service.getCandidate(candidate.id)?.similarity, 1)
    assert.ok(comparisonYields >= 1, 'comparison should yield to the event loop')
    assert.ok(progress.includes('fingerprinting'))
    assert.ok(progress.includes('comparing'))

    const second = await service.analyze()
    assert.equal(second.fingerprintsReused, 2)
    assert.equal(provider.calls, 2)
    assert.equal(service.getCandidate(candidate.id)?.revision, candidate.revision)

    const leftIdentity = repo.getIdentity(ids.leftId)
    const rightIdentity = repo.getIdentity(ids.rightId)
    assert.ok(leftIdentity && rightIdentity)
    repo.saveKeepBothDecision({
      lowIdentity: leftIdentity,
      highIdentity: rightIdentity,
      reason: 'different_versions',
    })
    await service.analyze()
    assert.equal(service.getSummary().pendingCount, 0)
    assert.equal(service.getSummary().dismissedCount, 1)

    // A path/mtime change regenerates the fingerprint but keeps the portable
    // decision when the decoded audio digest is unchanged.
    db.prepare(`UPDATE tracks SET path = ?, date_modified = ? WHERE id = ?`).run(
      '/music/moved-collection.mp3', '2026-02-01T00:00:00.000Z', ids.leftId,
    )
    await service.analyze()
    assert.equal(service.getSummary().dismissedCount, 1)

    // A real audio digest change reopens only this pair.
    provider.changedTracks.add(ids.leftId)
    db.prepare(`UPDATE tracks SET date_modified = ? WHERE id = ?`).run(
      '2026-03-01T00:00:00.000Z', ids.leftId,
    )
    await service.analyze()
    assert.equal(service.getSummary().pendingCount, 1)
    assert.equal(service.getSummary().dismissedCount, 0)
  } finally {
    db.close()
  }
})

test('a missing native provider blocks the run once without mutating or blaming tracks', async () => {
  const db = migratedDatabase()
  try {
    const ids = seedPair(db)
    const repo = new DuplicateRepository(db)
    const legacyProvider = { algorithm: 'chromaprint', algorithmVersion: '1.6.0' }
    repo.failAnalysis({
      trackId: ids.leftId,
      provider: 'local',
      locator: '/music/collection.mp3',
      fileSize: 10_000,
      dateModified: '2026-01-01T00:00:00.000Z',
      etag: null,
    }, 'legacy-left', legacyProvider, new Error('legacy missing native component'))
    repo.failAnalysis({
      trackId: ids.rightId,
      provider: 'local',
      locator: '/music/album.flac',
      fileSize: 10_000,
      dateModified: '2026-01-01T00:00:00.000Z',
      etag: null,
    }, 'legacy-right', legacyProvider, new Error('legacy missing native component'))

    const before = db.prepare(`
      SELECT track_id, status, source_signature, error, updated_at
      FROM duplicate_track_analyses ORDER BY track_id
    `).all()
    const provider = new UnavailableFingerprintProvider(
      'chromaprint',
      '1.6.0',
      'test native binary is absent',
      {
        code: 'native_component_missing',
        message: 'Falta Chromaprint. Las pistas no presentan errores.',
        component: 'Chromaprint',
      },
    )
    const service = new DuplicateDetectionService(repo, provider)
    const phases: string[] = []
    service.onProgress(event => phases.push(event.phase))

    await assert.rejects(
      service.analyze(),
      (error: unknown) =>
        error instanceof Error
        && error.name === 'DuplicateAnalysisUnavailableError'
        && /Falta Chromaprint/.test(error.message),
    )

    const after = db.prepare(`
      SELECT track_id, status, source_signature, error, updated_at
      FROM duplicate_track_analyses ORDER BY track_id
    `).all()
    assert.deepEqual(after, before, 'system availability must be checked before beginAnalysis/failAnalysis')
    assert.deepEqual(phases, ['error'], 'one run-level error replaces per-track failures')
    assert.equal(service.getSummary().failedCount, 0)
    assert.equal(service.getSummary().running, false)
    assert.equal(service.getSummary().blocker?.code, 'native_component_missing')
    assert.match(service.getSummary().blocker?.message ?? '', /pistas no presentan errores/i)
  } finally {
    db.close()
  }
})

test('a disconnected local root blocks before track mutations and can retry in the same process', async () => {
  const db = migratedDatabase()
  try {
    seedPair(db)
    const repo = new DuplicateRepository(db)
    const provider = new DeterministicProvider()
    let rootConnected = false
    let preflightCalls = 0
    const preflightTrackCounts: number[] = []
    const service = new DuplicateDetectionService(repo, provider, undefined, {
      preflight: async ({ tracks }) => {
        preflightCalls += 1
        preflightTrackCounts.push(tracks.length)
        if (tracks.length === 0) return null
        return rootConnected ? null : {
          code: 'local_library_unavailable',
          message: 'La biblioteca “Main library” no está conectada. Volvé a analizar.',
          retryable: true,
          requiresRestart: false,
          affectedFolders: [{
            folderId: 1,
            name: 'Main library',
            path: '/music',
            state: 'unavailable',
          }],
        }
      },
    })

    await assert.rejects(service.analyze(), /no está conectada/i)
    assert.equal(preflightCalls, 1)
    assert.deepEqual(preflightTrackCounts, [2])
    assert.equal(provider.calls, 0)
    const analysisCount = db.prepare(`
      SELECT COUNT(*) AS count FROM duplicate_track_analyses
    `).get() as { count: number }
    assert.equal(analysisCount.count, 0, 'root readiness must be resolved before beginAnalysis creates a row')
    assert.equal(service.getSummary().blocker?.retryable, true)
    assert.equal(service.getSummary().failedCount, 0)

    rootConnected = true
    const result = await service.reanalyze()
    assert.equal(preflightCalls, 2)
    assert.equal(result.fingerprintsCreated, 2)
    assert.equal(provider.calls, 2)
    assert.equal(service.getSummary().blocker, undefined)

    rootConnected = false
    const cached = await service.analyze()
    assert.equal(cached.fingerprintsReused, 2)
    assert.equal(provider.calls, 2)
    assert.deepEqual(preflightTrackCounts, [2, 2, 0], 'cached fingerprints do not require their root')
    await assert.rejects(service.reanalyze(), /no está conectada/i)
    assert.deepEqual(preflightTrackCounts, [2, 2, 0, 2], 'force=true preflights every involved track root')
    assert.equal(service.getSummary().blocker?.code, 'local_library_unavailable')
  } finally {
    db.close()
  }
})

test('migration enforces ordered independent pairs and a score strictly above 60 percent', () => {
  const db = migratedDatabase()
  try {
    const ids = seedPair(db)
    const now = new Date().toISOString()
    const insert = db.prepare(`
      INSERT INTO duplicate_candidates (
        id, track_low_id, track_high_id, similarity, alignment_offset_frames,
        matching_frames, compared_frames, segments_json, acoustic_relation,
        editorial_relation, recommended_track_id, low_fingerprint_digest,
        high_fingerprint_digest, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 6, 10, '[]', 'uncertain', 'unknown', ?, 'a', 'b', ?, ?)
    `)
    assert.throws(() => insert.run('too-low', ids.leftId, ids.rightId, 0.6, ids.rightId, now, now))
    assert.throws(() => insert.run('reversed', ids.rightId, ids.leftId, 0.7, ids.rightId, now, now))
    assert.doesNotThrow(() => insert.run(
      'valid', ids.leftId, ids.rightId, 0.600001, ids.rightId, now, now,
    ))
    db.prepare(`DELETE FROM tracks WHERE id = ?`).run(ids.rightId)
    assert.equal(
      db.prepare(`SELECT 1 FROM duplicate_candidates WHERE id = 'valid'`).get(),
      undefined,
    )
  } finally {
    db.close()
  }
})
