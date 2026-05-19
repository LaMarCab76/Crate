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

export interface EqOverride {
  enabled: boolean
  bands: number[]  // 10 gains in dB
}

export class TrackRepo {
  private db: BetterSqliteDatabase
  private stmtById: Statement
  private stmtByPath: Statement
  private stmtDeleteByPath: Statement
  private stmtUpdatePlays: Statement
  private stmtSetFavorite: Statement
  private stmtGetExtMeta: Statement
  private stmtSetExtMeta: Statement
  private stmtInsert: Statement
  private listStmtCache = new Map<string, Statement>()

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtById = db.prepare<[number], DbTrack>(`SELECT ${ALL_COLUMNS} FROM tracks WHERE id = ?`)
    this.stmtByPath = db.prepare<[string], DbTrack>(`SELECT ${ALL_COLUMNS} FROM tracks WHERE path = ?`)
    this.stmtDeleteByPath = db.prepare(`DELETE FROM tracks WHERE path = ?`)
    this.stmtUpdatePlays = db.prepare(`
      UPDATE tracks
      SET play_count = play_count + 1, last_played_date = ?, state_updated_at = ?
      WHERE id = ?
    `)
    this.stmtSetFavorite = db.prepare(
      `UPDATE tracks SET is_favorite = ?, state_updated_at = ? WHERE id = ?`,
    )
    this.stmtGetExtMeta = db.prepare<[number], { extended_metadata: string | null }>(
      `SELECT extended_metadata FROM tracks WHERE id = ?`,
    )
    this.stmtSetExtMeta = db.prepare(
      `UPDATE tracks SET extended_metadata = ?, state_updated_at = ? WHERE id = ?`,
    )
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

  updatePlays(id: number): void {
    this.stmtUpdatePlays.run(new Date().toISOString(), Date.now(), id)
  }

  setFavorite(id: number, favorite: boolean): void {
    this.stmtSetFavorite.run(favorite ? 1 : 0, Date.now(), id)
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

  getEqOverride(id: number): EqOverride | null {
    const row = this.stmtGetExtMeta.get(id) as { extended_metadata: string | null } | undefined
    if (!row?.extended_metadata) return null
    try {
      const parsed = JSON.parse(row.extended_metadata) as { eqOverride?: EqOverride }
      const eq = parsed.eqOverride
      if (!eq || !Array.isArray(eq.bands) || eq.bands.length !== 10) return null
      return { enabled: !!eq.enabled, bands: eq.bands.map(n => Number(n) || 0) }
    } catch {
      return null
    }
  }

  setEqOverride(id: number, override: EqOverride | null): void {
    const row = this.stmtGetExtMeta.get(id) as { extended_metadata: string | null } | undefined
    let blob: Record<string, unknown> = {}
    if (row?.extended_metadata) {
      try { blob = JSON.parse(row.extended_metadata) ?? {} } catch { blob = {} }
    }
    if (override === null) {
      delete blob.eqOverride
    } else {
      blob.eqOverride = { enabled: !!override.enabled, bands: override.bands.slice(0, 10) }
    }
    const next = Object.keys(blob).length === 0 ? null : JSON.stringify(blob)
    this.stmtSetExtMeta.run(next, Date.now(), id)
  }
}
