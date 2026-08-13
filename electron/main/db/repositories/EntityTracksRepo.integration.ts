import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { applyMigrationPlan, buildMigrationCatalog, planMigrations } from '../migrationCore.ts'
import { EntityTracksRepo } from './EntityTracksRepo.ts'

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

function trackInsert(args: {
  path: string
  filename: string
  title: string
  trackNumber: number
  folderId: number
  albumId: number
  artistId: number
  genreId: number
  provider?: 'local' | 'onedrive'
  driveId?: string | null
  itemId?: string | null
  remotePath?: string | null
}): Record<string, unknown> {
  return {
    path: args.path,
    filename: args.filename,
    title: args.title,
    artist: 'Nothing But Thieves',
    album: 'Moral Panic',
    duration: 180,
    format: 'FLAC',
    folder_id: args.folderId,
    file_size: 42_000_000,
    date_modified: '2026-08-13T12:00:00.000Z',
    album_artist: 'Nothing But Thieves',
    composer: '',
    genre: 'Alternative',
    year: '2020',
    is_favorite: 0,
    play_count: 0,
    last_played_date: null,
    rating: null,
    track_number: args.trackNumber,
    total_tracks: 11,
    disc_number: 1,
    total_discs: 1,
    compilation: 0,
    release_date: null,
    original_release_date: null,
    bpm: null,
    musical_key: null,
    media_type: null,
    sort_title: null,
    sort_artist: null,
    sort_album: null,
    sort_album_artist: null,
    bitrate: 1_267_000,
    sample_rate: 44_100,
    channels: 2,
    codec: 'FLAC',
    bit_depth: 24,
    artwork_data: null,
    artwork_path: 'moral-panic.jpg',
    date_added: '2026-08-13T12:00:00.000Z',
    is_duplicate: 0,
    primary_track_id: null,
    duplicate_group_id: null,
    extended_metadata: null,
    album_id: args.albumId,
    artist_id: args.artistId,
    genre_id: args.genreId,
    r128_integrated_loudness: null,
    state_updated_at: 1_765_000_000_000,
    provider: args.provider ?? 'local',
    drive_id: args.driveId ?? null,
    item_id: args.itemId ?? null,
    etag: args.provider === 'onedrive' ? 'etag-cloud' : null,
    remote_path: args.remotePath ?? null,
    quickxor_hash: args.provider === 'onedrive' ? 'quickxor-cloud' : null,
  }
}

test('entity track projections preserve local/cloud identity for every relation', () => {
  const db = migratedDatabase()
  try {
    const now = '2026-08-13T12:00:00.000Z'
    const localFolderId = Number(db.prepare(`
      INSERT INTO folders (name, path, date_added, date_updated)
      VALUES ('Catalog', '/music/catalog', ?, ?)
    `).run(now, now).lastInsertRowid)
    const cloudFolderId = Number(db.prepare(`
      INSERT INTO folders (
        name, path, date_added, date_updated, provider, role,
        account_id, drive_id, item_id, remote_path
      ) VALUES (
        'Cloud', 'onedrive://drive/cloud-root', ?, ?, 'onedrive', 'library',
        'account', 'drive', 'cloud-root', '/Music'
      )
    `).run(now, now).lastInsertRowid)
    const albumId = Number(db.prepare(`
      INSERT INTO albums (
        title, normalized_name, sort_name, album_artist, year, date_added
      ) VALUES ('Moral Panic', 'moral panic', 'moral panic', 'Nothing But Thieves', '2020', ?)
    `).run(now).lastInsertRowid)
    const artistId = Number(db.prepare(`
      INSERT INTO artists (name, normalized_name, sort_name, date_added)
      VALUES ('Nothing But Thieves', 'nothing but thieves', 'nothing but thieves', ?)
    `).run(now).lastInsertRowid)
    const genreId = Number(db.prepare(`
      INSERT INTO genres (name, normalized_name, sort_name, date_added)
      VALUES ('Alternative', 'alternative', 'alternative', ?)
    `).run(now).lastInsertRowid)
    const playlistId = Number(db.prepare(`
      INSERT INTO playlists (name, created_date, modified_date)
      VALUES ('Regression', ?, ?)
    `).run(now, now).lastInsertRowid)
    const insertTrack = db.prepare(`
      INSERT INTO tracks (
        path, filename, title, artist, album, duration, format, folder_id,
        file_size, date_modified, album_artist, composer, genre, year,
        is_favorite, play_count, last_played_date, rating,
        track_number, total_tracks, disc_number, total_discs,
        compilation, release_date, original_release_date, bpm, musical_key, media_type,
        sort_title, sort_artist, sort_album, sort_album_artist,
        bitrate, sample_rate, channels, codec, bit_depth,
        artwork_data, artwork_path, date_added, is_duplicate, primary_track_id, duplicate_group_id,
        extended_metadata, album_id, artist_id, genre_id, r128_integrated_loudness,
        state_updated_at, provider, drive_id, item_id, etag, remote_path, quickxor_hash
      ) VALUES (
        @path, @filename, @title, @artist, @album, @duration, @format, @folder_id,
        @file_size, @date_modified, @album_artist, @composer, @genre, @year,
        @is_favorite, @play_count, @last_played_date, @rating,
        @track_number, @total_tracks, @disc_number, @total_discs,
        @compilation, @release_date, @original_release_date, @bpm, @musical_key, @media_type,
        @sort_title, @sort_artist, @sort_album, @sort_album_artist,
        @bitrate, @sample_rate, @channels, @codec, @bit_depth,
        @artwork_data, @artwork_path, @date_added, @is_duplicate, @primary_track_id, @duplicate_group_id,
        @extended_metadata, @album_id, @artist_id, @genre_id, @r128_integrated_loudness,
        @state_updated_at, @provider, @drive_id, @item_id, @etag, @remote_path, @quickxor_hash
      )
    `)
    const localIds: number[] = []

    for (let trackNumber = 1; trackNumber <= 9; trackNumber++) {
      localIds.push(Number(insertTrack.run(trackInsert({
        path: `/music/catalog/Moral Panic/${trackNumber}.flac`,
        filename: `${trackNumber}.flac`,
        title: `Local track ${trackNumber}`,
        trackNumber,
        folderId: localFolderId,
        albumId,
        artistId,
        genreId,
      })).lastInsertRowid))
    }
    const cloudId = Number(insertTrack.run(trackInsert({
      path: 'onedrive://drive/cloud-track',
      filename: 'cloud.flac',
      title: 'Cloud track',
      trackNumber: 10,
      folderId: cloudFolderId,
      albumId,
      artistId,
      genreId,
      provider: 'onedrive',
      driveId: 'drive',
      itemId: 'cloud-track',
      remotePath: '/Music/Moral Panic/cloud.flac',
    })).lastInsertRowid)
    const insertPlaylistTrack = db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, track_id, position, date_added)
      VALUES (?, ?, ?, ?)
    `)
    const playlistTrackIds = [...localIds, cloudId]
    playlistTrackIds.forEach((trackId, position) => {
      insertPlaylistTrack.run(playlistId, trackId, position, now)
    })

    const entities = new EntityTracksRepo(db)
    const relationRows = [
      entities.getTracksForAlbum(albumId),
      entities.getTracksForArtist(artistId),
      entities.getTracksForGenre(genreId),
      entities.getTracksForPlaylist(playlistId),
    ]

    for (const rows of relationRows) {
      assert.equal(rows.length, 10)
      assert.equal(rows.filter(row => row.provider === 'local').length, 9)
      const cloud = rows.find(row => row.id === cloudId)
      assert.equal(cloud?.provider, 'onedrive')
      assert.equal(cloud?.drive_id, 'drive')
      assert.equal(cloud?.item_id, 'cloud-track')
      assert.equal(cloud?.etag, 'etag-cloud')
      assert.equal(cloud?.remote_path, '/Music/Moral Panic/cloud.flac')
      assert.equal(cloud?.quickxor_hash, 'quickxor-cloud')
      assert.equal(cloud?.state_updated_at, 1_765_000_000_000)
    }

    // This is the exact filter used by TrackAlbumMoveService. Before the fix,
    // provider was absent from EntityTracksRepo rows and all nine were dropped.
    const localTargets = entities.getTracksForAlbum(albumId)
      .filter(track => track.provider === 'local')
    assert.equal(localTargets.length, 9)
  } finally {
    db.close()
  }
})
