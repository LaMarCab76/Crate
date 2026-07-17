import type { Database as BetterSqliteDatabase, Statement } from 'better-sqlite3'
import type { DbTrack, DbTrackInsert } from '@shared/types/db'

const ALL_COLUMNS = `
  id, path, filename, title, artist, album, duration, format, folder_id,
  file_size, date_modified, album_artist, composer, genre, year,
  is_favorite, play_count, last_played_date, rating,
  track_number, total_tracks, disc_number, total_discs,
  compilation, release_date, original_release_date, bpm, musical_key, media_type,
  sort_title, sort_artist, sort_album, sort_album_artist,
  bitrate, sample_rate, channels, codec, bit_depth,
  artwork_data, artwork_path, date_added, is_duplicate, primary_track_id, duplicate_group_id,
  extended_metadata, album_id, artist_id, genre_id, r128_integrated_loudness,
  state_updated_at, provider, drive_id, item_id, etag, remote_path, quickxor_hash
`

export interface ListOpts {
  limit?: number
  offset?: number
  orderBy?: 'date_added_desc' | 'date_added_asc' | 'title' | 'artist' | 'play_count_desc'
}

export class TrackRepo {
  private db: BetterSqliteDatabase
  private stmtById: Statement
  private stmtByPath: Statement
  private stmtByFolder: Statement
  private stmtDeleteByPath: Statement
  private stmtDeleteById: Statement
  private stmtDeleteByFolder: Statement
  private stmtCountByFolder: Statement
  private stmtUpdatePlays: Statement
  private stmtSetFavorite: Statement
  private stmtByFolderWithAlbum: Statement
  private stmtUpdateMetadata: Statement
  private stmtMoveAndUpdateMetadata: Statement
  private stmtUpdatePath: Statement
  private stmtInsert: Statement
  private listStmtCache = new Map<string, Statement>()

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtById = db.prepare<[number], DbTrack>(`SELECT ${ALL_COLUMNS} FROM tracks WHERE id = ?`)
    this.stmtByPath = db.prepare<[string], DbTrack>(`SELECT ${ALL_COLUMNS} FROM tracks WHERE path = ?`)
    this.stmtByFolder = db.prepare<[number], DbTrack>(`
      SELECT ${ALL_COLUMNS} FROM tracks
      WHERE folder_id = ?
      ORDER BY path COLLATE NOCASE ASC
    `)
    this.stmtDeleteByPath = db.prepare(`DELETE FROM tracks WHERE path = ?`)
    this.stmtDeleteById = db.prepare(`DELETE FROM tracks WHERE id = ?`)
    this.stmtDeleteByFolder = db.prepare(`DELETE FROM tracks WHERE folder_id = ?`)
    this.stmtCountByFolder = db.prepare<[number], { c: number }>(`SELECT COUNT(*) as c FROM tracks WHERE folder_id = ?`)
    this.stmtUpdatePlays = db.prepare(`
      UPDATE tracks
      SET play_count = play_count + 1, last_played_date = ?, state_updated_at = ?
      WHERE id = ?
    `)
    this.stmtSetFavorite = db.prepare(
      `UPDATE tracks SET is_favorite = ?, state_updated_at = ? WHERE id = ?`,
    )
    this.stmtByFolderWithAlbum = db.prepare<
      [number], DbTrack
    >(`
      SELECT ${ALL_COLUMNS} FROM tracks
      WHERE folder_id = ? AND album_id IS NOT NULL
      ORDER BY date_added DESC
    `)
    this.stmtUpdateMetadata = db.prepare(`
      UPDATE tracks
      SET
        title = @title,
        artist = @artist,
        album = @album,
        album_artist = @albumArtist,
        composer = @composer,
        genre = @genre,
        year = @year,
        track_number = @trackNumber,
        total_tracks = @totalTracks,
        disc_number = @discNumber,
        total_discs = @totalDiscs,
        compilation = @compilation,
        duration = @duration,
        format = @format,
        codec = @codec,
        bitrate = @bitrate,
        sample_rate = @sampleRate,
        channels = @channels,
        bit_depth = @bitDepth,
        file_size = @fileSize,
        bpm = @bpm,
        musical_key = @musicalKey,
        date_modified = @dateModified,
        artwork_path = @artworkPath,
        filename = @filename,
        artist_id = @artistId,
        album_id = @albumId,
        genre_id = @genreId,
        state_updated_at = @stateUpdatedAt
      WHERE id = @id
    `)
    this.stmtMoveAndUpdateMetadata = db.prepare(`
      UPDATE tracks
      SET
        path = @path,
        filename = @filename,
        folder_id = @folderId,
        title = @title,
        artist = @artist,
        album = @album,
        album_artist = @albumArtist,
        composer = @composer,
        genre = @genre,
        year = @year,
        track_number = @trackNumber,
        total_tracks = @totalTracks,
        disc_number = @discNumber,
        total_discs = @totalDiscs,
        compilation = @compilation,
        duration = @duration,
        format = @format,
        codec = @codec,
        bitrate = @bitrate,
        sample_rate = @sampleRate,
        channels = @channels,
        bit_depth = @bitDepth,
        file_size = @fileSize,
        bpm = @bpm,
        musical_key = @musicalKey,
        date_modified = @dateModified,
        artwork_path = @artworkPath,
        artist_id = @artistId,
        album_id = @albumId,
        genre_id = @genreId,
        state_updated_at = @stateUpdatedAt
      WHERE id = @id
    `)
    this.stmtUpdatePath = db.prepare(`
      UPDATE tracks SET path = ?, filename = ? WHERE id = ?
    `)
    this.stmtInsert = db.prepare(`
      INSERT OR IGNORE INTO tracks (
        path, filename, title, artist, album, duration, format, folder_id,
        file_size, date_modified, album_artist, composer, genre, year,
        is_favorite, play_count, last_played_date, rating,
        track_number, total_tracks, disc_number, total_discs,
        compilation, release_date, original_release_date, bpm, musical_key, media_type,
        sort_title, sort_artist, sort_album, sort_album_artist,
        bitrate, sample_rate, channels, codec, bit_depth,
        artwork_data, artwork_path, date_added, is_duplicate, primary_track_id, duplicate_group_id,
        extended_metadata, album_id, artist_id, genre_id, r128_integrated_loudness,
        provider, drive_id, item_id, etag, remote_path, quickxor_hash
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
        @provider, @drive_id, @item_id, @etag, @remote_path, @quickxor_hash
      )
    `)
  }

  getById(id: number): DbTrack | undefined {
    return this.stmtById.get(id) as DbTrack | undefined
  }

  getByPath(path: string): DbTrack | undefined {
    return this.stmtByPath.get(path) as DbTrack | undefined
  }

  getByFolder(folderId: number): DbTrack[] {
    return this.stmtByFolder.all(folderId) as DbTrack[]
  }

  deleteByPath(path: string): void {
    this.stmtDeleteByPath.run(path)
  }

  deleteById(id: number): void {
    this.stmtDeleteById.run(id)
  }

  deleteByIds(ids: number[]): void {
    const uniqueIds = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))]
    if (uniqueIds.length === 0) return
    const tx = this.db.transaction((batch: number[]) => {
      for (const id of batch) this.stmtDeleteById.run(id)
    })
    tx(uniqueIds)
  }

  deleteByFolder(folderId: number): void {
    this.stmtDeleteByFolder.run(folderId)
  }

  countByFolder(folderId: number): number {
    return (this.stmtCountByFolder.get(folderId) as { c: number } | undefined)?.c ?? 0
  }

  updatePlays(id: number): void {
    this.stmtUpdatePlays.run(new Date().toISOString(), Date.now(), id)
  }

  setFavorite(id: number, favorite: boolean): void {
    this.stmtSetFavorite.run(favorite ? 1 : 0, Date.now(), id)
  }

  getByFolderWithAlbum(folderId: number): DbTrack[] {
    return this.stmtByFolderWithAlbum.all(folderId) as DbTrack[]
  }

  updatePath(id: number, path: string, filename: string): void {
    this.stmtUpdatePath.run(path, filename, id)
  }

  updateMetadata(args: {
    id: number
    title: string
    artist: string
    album: string
    albumArtist: string | null
    composer: string
    genre: string
    year: string
    trackNumber: number | null
    totalTracks: number | null
    discNumber: number | null
    totalDiscs: number | null
    compilation: number
    duration: number
    format: string
    codec: string | null
    bitrate: number | null
    sampleRate: number | null
    channels: number | null
    bitDepth: number | null
    fileSize: number | null
    bpm: number | null
    musicalKey: string | null
    dateModified: string | null
    artworkPath: string | null
    filename: string
    artistId: number | null
    albumId: number | null
    genreId: number | null
  }): void {
    this.stmtUpdateMetadata.run({
      id: args.id,
      title: args.title,
      artist: args.artist,
      album: args.album,
      albumArtist: args.albumArtist,
      composer: args.composer,
      genre: args.genre,
      year: args.year,
      trackNumber: args.trackNumber,
      totalTracks: args.totalTracks,
      discNumber: args.discNumber,
      totalDiscs: args.totalDiscs,
      compilation: args.compilation,
      duration: args.duration,
      format: args.format,
      codec: args.codec,
      bitrate: args.bitrate,
      sampleRate: args.sampleRate,
      channels: args.channels,
      bitDepth: args.bitDepth,
      fileSize: args.fileSize,
      bpm: args.bpm,
      musicalKey: args.musicalKey,
      dateModified: args.dateModified,
      artworkPath: args.artworkPath,
      filename: args.filename,
      artistId: args.artistId,
      albumId: args.albumId,
      genreId: args.genreId,
      stateUpdatedAt: Date.now(),
    })
  }

  moveAndUpdateMetadata(args: {
    id: number
    path: string
    filename: string
    folderId: number
    title: string
    artist: string
    album: string
    albumArtist: string | null
    composer: string
    genre: string
    year: string
    trackNumber: number | null
    totalTracks: number | null
    discNumber: number | null
    totalDiscs: number | null
    compilation: number
    duration: number
    format: string
    codec: string | null
    bitrate: number | null
    sampleRate: number | null
    channels: number | null
    bitDepth: number | null
    fileSize: number | null
    bpm: number | null
    musicalKey: string | null
    dateModified: string | null
    artworkPath: string | null
    artistId: number | null
    albumId: number | null
    genreId: number | null
  }): void {
    this.stmtMoveAndUpdateMetadata.run({
      id: args.id,
      path: args.path,
      filename: args.filename,
      folderId: args.folderId,
      title: args.title,
      artist: args.artist,
      album: args.album,
      albumArtist: args.albumArtist,
      composer: args.composer,
      genre: args.genre,
      year: args.year,
      trackNumber: args.trackNumber,
      totalTracks: args.totalTracks,
      discNumber: args.discNumber,
      totalDiscs: args.totalDiscs,
      compilation: args.compilation,
      duration: args.duration,
      format: args.format,
      codec: args.codec,
      bitrate: args.bitrate,
      sampleRate: args.sampleRate,
      channels: args.channels,
      bitDepth: args.bitDepth,
      fileSize: args.fileSize,
      bpm: args.bpm,
      musicalKey: args.musicalKey,
      dateModified: args.dateModified,
      artworkPath: args.artworkPath,
      artistId: args.artistId,
      albumId: args.albumId,
      genreId: args.genreId,
      stateUpdatedAt: Date.now(),
    })
  }

  insert(track: DbTrackInsert): number {
    // Keep older/local import call sites source-compatible with the cloud-aware
    // schema. better-sqlite3 requires every named parameter to be present even
    // when the corresponding database column has a default value.
    const row: DbTrackInsert = {
      provider: 'local',
      drive_id: null,
      item_id: null,
      etag: null,
      remote_path: null,
      quickxor_hash: null,
      ...track,
    }
    const result = this.stmtInsert.run(row as unknown as Record<string, unknown>)
    // INSERT OR IGNORE returns changes=0 when the row was a UNIQUE conflict —
    // surface that to callers as id 0 so they can skip downstream broadcasts.
    if (result.changes === 0) return 0
    return Number(result.lastInsertRowid)
  }

  insertBatch(tracks: DbTrackInsert[]): number[] {
    const ids: number[] = []
    const tx = this.db.transaction((batch: DbTrackInsert[]) => {
      for (const t of batch) {
        const id = this.insert(t)
        if (id !== 0) ids.push(id)
      }
    })
    tx(tracks)
    return ids
  }

  getAll(opts: ListOpts = {}): DbTrack[] {
    const { orderBy = 'date_added_desc' } = opts
    // opts crosses the IPC boundary, so never trust limit/offset: coerce to safe
    // integers. A non-positive/garbage limit becomes -1 (SQLite idiom for "no
    // upper bound") so it behaves like the unlimited library view.
    const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? (opts.limit as number) : -1
    const offset = Number.isInteger(opts.offset) && (opts.offset as number) > 0 ? (opts.offset as number) : 0
    const orderClause = (() => {
      switch (orderBy) {
        case 'date_added_asc':   return 'date_added ASC, id ASC'
        case 'title':            return 'title COLLATE NOCASE ASC, id ASC'
        case 'artist':           return 'artist COLLATE NOCASE ASC, id ASC'
        case 'play_count_desc':  return 'play_count DESC, id DESC'
        case 'date_added_desc':
        default:                 return 'date_added DESC, id DESC'
      }
    })()

    // Cache one prepared statement per ORDER BY (5 max). limit/offset are bound at
    // execution, so the cache can't grow unbounded and the values can't be injected
    // into the SQL string.
    let stmt = this.listStmtCache.get(orderClause)
    if (!stmt) {
      stmt = this.db.prepare(`SELECT ${ALL_COLUMNS} FROM tracks ORDER BY ${orderClause} LIMIT ? OFFSET ?`)
      this.listStmtCache.set(orderClause, stmt)
    }
    return stmt.all(limit, offset) as DbTrack[]
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) as c FROM tracks`).get() as { c: number }).c
  }
}
