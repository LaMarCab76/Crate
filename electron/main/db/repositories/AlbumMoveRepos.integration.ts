import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { applyMigrationPlan, buildMigrationCatalog, planMigrations } from '../migrationCore.ts'
import { AlbumRepo } from './AlbumRepo.ts'
import { TrackRepo } from './TrackRepo.ts'

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

const NOW = '2026-10-13T12:00:00.000Z'

function seedCompilationTrack(db: Database.Database, albums: AlbumRepo): { trackId: number; folderId: number; compilationId: number } {
  const folderId = Number(db.prepare(`
    INSERT INTO folders (name, path, date_added, date_updated) VALUES ('Library', '/music/library', ?, ?)
  `).run(NOW, NOW).lastInsertRowid)
  const artistId = Number(db.prepare(`
    INSERT INTO artists (name, normalized_name, sort_name, date_added) VALUES ('The Band', 'the band', 'band', ?)
  `).run(NOW).lastInsertRowid)
  const compilation = albums.getOrCreate('Now Hits 42', 'Various Artists', '2015')
  albums.enrichReleaseMetadata(compilation.id, {
    releaseTypes: ['album', 'compilation'],
    isCompilation: true,
    musicbrainzAlbumId: 'comp-release',
    musicbrainzReleaseGroupId: 'comp-rg',
  })
  const trackId = Number(db.prepare(`
    INSERT INTO tracks (
      path, filename, title, artist, album, duration, format, folder_id, date_added,
      album_artist, year, track_number, total_tracks, compilation, album_id, artist_id
    ) VALUES (
      '/music/library/Crate Downloads/Now Hits 42/07 - Borrowed Song.flac', '07 - Borrowed Song.flac',
      'Borrowed Song', 'The Band', 'Now Hits 42', 214, 'FLAC', ?, ?,
      'Various Artists', '2015', 7, 20, 1, ?, ?
    )
  `).run(folderId, NOW, compilation.id, artistId).lastInsertRowid)
  // An unrelated track with populated text columns. The legacy tracks_fts
  // update trigger deletes the NEW tokens (external-content FTS5 reads the
  // already-updated row), so on a near-empty index the per-column token totals
  // go negative and SQLite reports SQLITE_CORRUPT_VTAB. Real libraries never
  // get there; this keeps the fixture representative.
  db.prepare(`
    INSERT INTO tracks (path, filename, title, artist, album, album_artist, genre, composer, duration, format, folder_id, date_added)
    VALUES (
      '/music/library/Other/01 - Other Song.flac', '01 - Other Song.flac', 'Other Song', 'Other Act', 'Other Album',
      'Other Act', 'Alternative Rock', 'Some Writer', 200, 'FLAC', ?, ?
    )
  `).run(folderId, NOW)
  return { trackId, folderId, compilationId: compilation.id }
}

function moveArgs(trackId: number, folderId: number, albumId: number) {
  return {
    id: trackId,
    path: '/music/library/The Band/Original Album/04 - Borrowed Song.flac',
    filename: '04 - Borrowed Song.flac',
    folderId,
    title: 'Borrowed Song',
    artist: 'The Band',
    album: 'Original Album',
    albumArtist: 'The Band',
    composer: '',
    genre: 'Rock',
    year: '2009',
    trackNumber: 4,
    totalTracks: 12,
    discNumber: 1,
    totalDiscs: 1,
    compilation: 0,
    releaseDate: '2009-05-01',
    originalReleaseDate: null,
    mediaType: 'CD',
    extendedMetadata: JSON.stringify({ musicbrainzAlbumId: 'orig-release' }),
    duration: 214,
    format: 'FLAC',
    codec: 'FLAC',
    bitrate: 1_000_000,
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    fileSize: 30_000_000,
    bpm: null,
    musicalKey: null,
    dateModified: NOW,
    artworkPath: null,
    artistId: null,
    albumId,
    genreId: null,
  }
}

const originalRelease = {
  releaseTypes: ['album'],
  isCompilation: false,
  musicbrainzAlbumId: 'orig-release',
  musicbrainzReleaseGroupId: 'orig-rg',
  releaseDate: '2009-05-01',
}

test('moving a compilation track into a new album leaves no compilation identity behind', () => {
  const db = migratedDatabase()
  try {
    const albums = new AlbumRepo(db)
    const tracks = new TrackRepo(db)
    const { trackId, folderId, compilationId } = seedCompilationTrack(db, albums)

    // A stale, empty row (e.g. left by an older bad merge) carrying the
    // compilation's identity must be reset, not merged.
    const stale = albums.getOrCreate('Original Album', 'The Band', '2009')
    albums.enrichReleaseMetadata(stale.id, { isCompilation: true, musicbrainzAlbumId: 'comp-release', musicbrainzReleaseGroupId: 'comp-rg' })

    db.transaction(() => {
      const album = albums.getOrCreate('Original Album', 'The Band', '2009')
      assert.equal(album.id, stale.id)
      assert.equal(albums.replaceReleaseMetadataIfEmpty(album.id, originalRelease), true)
      tracks.moveAndUpdateMetadata(moveArgs(trackId, folderId, album.id))
    })()

    const moved = tracks.getById(trackId)!
    assert.equal(moved.album_id, stale.id)
    assert.equal(moved.compilation, 0)
    assert.equal(moved.release_date, '2009-05-01')
    assert.equal(moved.media_type, 'CD')
    assert.equal(moved.extended_metadata, JSON.stringify({ musicbrainzAlbumId: 'orig-release' }))
    assert.equal(moved.path, '/music/library/The Band/Original Album/04 - Borrowed Song.flac')

    const album = albums.getById(stale.id)!
    assert.equal(album.is_compilation, 0)
    assert.equal(album.musicbrainz_album_id, 'orig-release')
    assert.equal(album.musicbrainz_release_group_id, 'orig-rg')
    assert.equal(album.release_type, 'album')
    assert.equal(album.track_count, 1)
    assert.equal(albums.getById(compilationId), undefined, 'the emptied compilation album is cleaned up')
  } finally {
    db.close()
  }
})

test('replaceReleaseMetadataIfEmpty never rewrites an album that already has tracks', () => {
  const db = migratedDatabase()
  try {
    const albums = new AlbumRepo(db)
    const { compilationId } = seedCompilationTrack(db, albums)
    assert.equal(albums.replaceReleaseMetadataIfEmpty(compilationId, originalRelease), false)
    const compilation = albums.getById(compilationId)!
    assert.equal(compilation.is_compilation, 1)
    assert.equal(compilation.musicbrainz_album_id, 'comp-release')
  } finally {
    db.close()
  }
})
