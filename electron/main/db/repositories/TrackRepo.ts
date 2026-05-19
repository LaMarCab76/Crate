import type { Database as BetterSqliteDatabase, Statement } from 'better-sqlite3'
import type { DbTrack, DbTrackInsert } from '@shared/types/db'

const ALL_COLUMNS = `
  id, path, filename, title, artist, album, duration, format, folder_id,
  file_size, date_modified, album_artist, composer, genre, year,
  is_favorite, play_count, last_played_date, rating,
  track_number, total_tracks, disc_number, total_discs,
  compilation, release_date, original_release_date, bpm, media_type,
  sort_title, sort_artist, sort_album, sort_album_artist,
  bitrate, sample_rate, channels, codec, bit_depth,
  artwork_data, artwork_path, date_added, is_duplicate, primary_track_id, duplicate_group_id,
  extended_metadata, album_id, artist_id, genre_id, r128_integrated_loudness,
  state_updated_at
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
  private stmtDeleteByPath: Statement
  private stmtDeleteById: Statement
  private stmtCountByFolder: Statement
  private stmtUpdatePlays: Statement
  private stmtSetFavorite: Statement
  private stmtByFolderWithAlbum: Statement
  private stmtUpdateMetadata: Statement
  private stmtInsert: Statement
  private listStmtCache = new Map<string, Statement>()

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtById = db.prepare<[number], DbTrack>(`SELECT ${ALL_COLUMNS} FROM tracks WHERE id = ?`)
    this.stmtByPath = db.prepare<[string], DbTrack>(`SELECT ${ALL_COLUMNS} FROM tracks WHERE path = ?`)
    this.stmtDeleteByPath = db.prepare(`DELETE FROM tracks WHERE path = ?`)
    this.stmtDeleteById = db.prepare(`DELETE FROM tracks WHERE id = ?`)
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
        date_modified = @dateModified,
        artwork_path = @artworkPath,
        filename = @filename,
        artist_id = @artistId,
        album_id = @albumId,
        genre_id = @genreId,
        state_updated_at = @stateUpdatedAt
      WHERE id = @id
    `)
    this.stmtInsert = db.prepare(`
      INSERT INTO tracks (
        path, filename, title, artist, album, duration, format, folder_id,
        file_size, date_modified, album_artist, composer, genre, year,
        is_favorite, play_count, last_played_date, rating,
        track_number, total_tracks, disc_number, total_discs,
        compilation, release_date, original_release_date, bpm, media_type,
        sort_title, sort_artist, sort_album, sort_album_artist,
        bitrate, sample_rate, channels, codec, bit_depth,
        artwork_data, artwork_path, date_added, is_duplicate, primary_track_id, duplicate_group_id,
        extended_metadata, album_id, artist_id, genre_id, r128_integrated_loudness
      ) VALUES (
        @path, @filename, @title, @artist, @album, @duration, @format, @folder_id,
        @file_size, @date_modified, @album_artist, @composer, @genre, @year,
        @is_favorite, @play_count, @last_played_date, @rating,
        @track_number, @total_tracks, @disc_number, @total_discs,
        @compilation, @release_date, @original_release_date, @bpm, @media_type,
        @sort_title, @sort_artist, @sort_album, @sort_album_artist,
        @bitrate, @sample_rate, @channels, @codec, @bit_depth,
        @artwork_data, @artwork_path, @date_added, @is_duplicate, @primary_track_id, @duplicate_group_id,
        @extended_metadata, @album_id, @artist_id, @genre_id, @r128_integrated_loudness
      )
    `)
  }

  getById(id: number): DbTrack | undefined {
    return this.stmtById.get(id) as DbTrack | undefined
  }

  getByPath(path: string): DbTrack | undefined {
    return this.stmtByPath.get(path) as DbTrack | undefined
  }

  deleteByPath(path: string): void {
    this.stmtDeleteByPath.run(path)
  }

  deleteById(id: number): void {
    this.stmtDeleteById.run(id)
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
      dateModified: args.dateModified,
      artworkPath: args.artworkPath,
      filename: args.filename,
      artistId: args.artistId,
      albumId: args.albumId,
      genreId: args.genreId,
      stateUpdatedAt: Date.now(),
    })
  }

  insert(track: DbTrackInsert): number {
    const result = this.stmtInsert.run(track as unknown as Record<string, unknown>)
    return Number(result.lastInsertRowid)
  }

  insertBatch(tracks: DbTrackInsert[]): number[] {
    const ids: number[] = []
    const tx = this.db.transaction((batch: DbTrackInsert[]) => {
      for (const t of batch) ids.push(this.insert(t))
    })
    tx(tracks)
    return ids
  }

  getAll(opts: ListOpts = {}): DbTrack[] {
    const { limit, offset = 0, orderBy = 'date_added_desc' } = opts
    const orderClause = (() => {
      switch (orderBy) {
        case 'date_added_asc':   return 'date_added ASC'
        case 'title':            return 'title COLLATE NOCASE ASC'
        case 'artist':           return 'artist COLLATE NOCASE ASC'
        case 'play_count_desc':  return 'play_count DESC'
        case 'date_added_desc':
        default:                 return 'date_added DESC'
      }
    })()

    const key = `${orderClause}|${limit ?? 'all'}|${offset}`
    let stmt = this.listStmtCache.get(key)
    if (!stmt) {
      const limitClause = limit != null ? `LIMIT ${limit} OFFSET ${offset}` : ''
      stmt = this.db.prepare(`SELECT ${ALL_COLUMNS} FROM tracks ORDER BY ${orderClause} ${limitClause}`)
      this.listStmtCache.set(key, stmt)
    }
    return stmt.all() as DbTrack[]
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) as c FROM tracks`).get() as { c: number }).c
  }
}
