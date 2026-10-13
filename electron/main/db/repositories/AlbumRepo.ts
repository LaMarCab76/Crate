import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbAlbum } from '@shared/types/db'
import { normalizeName, sortKey } from './normalize.ts'

export class AlbumRepo {
  private db: BetterSqliteDatabase
  private stmtByKey
  private stmtById
  private stmtAll
  private stmtByArtist
  private stmtInsert
  private stmtSetFavorite

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtByKey = db.prepare<[string, string | null, string | null], DbAlbum>(`
      SELECT * FROM albums
      WHERE normalized_name = ?
        AND (album_artist IS ? OR album_artist = ?)
        AND (year IS ? OR year = ?)
    `)
    this.stmtById = db.prepare<[number], DbAlbum>(`SELECT * FROM albums WHERE id = ?`)
    this.stmtAll = db.prepare<unknown[], DbAlbum>(`
      SELECT * FROM albums
      WHERE track_count > 0
      ORDER BY sort_name COLLATE NOCASE ASC
    `)
    this.stmtByArtist = db.prepare<[string], DbAlbum>(`
      SELECT * FROM albums
      WHERE album_artist = ? AND track_count > 0
      ORDER BY year DESC
    `)
    this.stmtInsert = db.prepare(`
      INSERT INTO albums (title, normalized_name, sort_name, album_artist, year, date_added)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.stmtSetFavorite = db.prepare<[number, number, number]>(
      `UPDATE albums SET is_favorite = ?, state_updated_at = ? WHERE id = ?`,
    )
  }

  getOrCreate(title: string, albumArtist: string | null, year: string | null): DbAlbum {
    const normalized = normalizeName(title)
    // Two-arg trick for IS NULL or = ?: we need to bind albumArtist twice and year twice.
    const existing = this.findExisting(normalized, albumArtist, year)
    if (existing) return existing
    const result = this.stmtInsert.run(title, normalized, sortKey(title), albumArtist, year, new Date().toISOString())
    return this.stmtById.get(Number(result.lastInsertRowid))!
  }

  private findExisting(normalized: string, albumArtist: string | null, year: string | null): DbAlbum | undefined {
    // Use a query that handles NULLs explicitly because SQLite's = treats NULL = NULL as false.
    if (albumArtist === null && year === null) {
      const r = this.db
        .prepare<[string], DbAlbum>(`SELECT * FROM albums WHERE normalized_name = ? AND album_artist IS NULL AND year IS NULL`)
        .get(normalized)
      return r
    }
    if (albumArtist === null) {
      const r = this.db
        .prepare<[string, string], DbAlbum>(`SELECT * FROM albums WHERE normalized_name = ? AND album_artist IS NULL AND year = ?`)
        .get(normalized, year as string)
      return r
    }
    if (year === null) {
      const r = this.db
        .prepare<[string, string], DbAlbum>(`SELECT * FROM albums WHERE normalized_name = ? AND album_artist = ? AND year IS NULL`)
        .get(normalized, albumArtist)
      return r
    }
    const r = this.db
      .prepare<[string, string, string], DbAlbum>(`SELECT * FROM albums WHERE normalized_name = ? AND album_artist = ? AND year = ?`)
      .get(normalized, albumArtist, year)
    return r
  }

  getById(id: number): DbAlbum | undefined {
    return this.stmtById.get(id)
  }

  getAll(): DbAlbum[] {
    return this.stmtAll.all()
  }

  getByArtist(albumArtist: string): DbAlbum[] {
    return this.stmtByArtist.all(albumArtist)
  }

  setFavorite(id: number, favorite: boolean): void {
    this.stmtSetFavorite.run(favorite ? 1 : 0, Date.now(), id)
  }

  enrichReleaseMetadata(id: number, metadata: {
    releaseTypes?: readonly string[]
    isCompilation?: boolean
    musicbrainzAlbumId?: string | null
    musicbrainzReleaseGroupId?: string | null
    releaseDate?: string | null
  }): void {
    const releaseType = metadata.releaseTypes?.map(value => value.trim()).filter(Boolean).join(', ') || null
    this.db.prepare(`
      UPDATE albums
      SET release_type = COALESCE(?, release_type),
          is_compilation = MAX(is_compilation, ?),
          musicbrainz_album_id = COALESCE(?, musicbrainz_album_id),
          musicbrainz_release_group_id = COALESCE(?, musicbrainz_release_group_id),
          release_date = COALESCE(?, release_date)
      WHERE id = ?
    `).run(
      releaseType,
      metadata.isCompilation ? 1 : 0,
      metadata.musicbrainzAlbumId ?? null,
      metadata.musicbrainzReleaseGroupId ?? null,
      metadata.releaseDate ?? null,
      id,
    )
  }

  // Sets the release identity outright instead of merging it like
  // enrichReleaseMetadata (MAX/COALESCE can never clear a value). Only touches
  // an album with no tracks yet — a row just created for a track moved out of a
  // compilation, where merging would keep a stale compilation flag or the
  // compilation's MusicBrainz ids. Returns whether the row was updated.
  replaceReleaseMetadataIfEmpty(id: number, metadata: {
    releaseTypes?: readonly string[]
    isCompilation?: boolean
    musicbrainzAlbumId?: string | null
    musicbrainzReleaseGroupId?: string | null
    releaseDate?: string | null
  }): boolean {
    const releaseType = metadata.releaseTypes?.map(value => value.trim()).filter(Boolean).join(', ') || null
    const result = this.db.prepare(`
      UPDATE albums
      SET release_type = ?,
          is_compilation = ?,
          musicbrainz_album_id = ?,
          musicbrainz_release_group_id = ?,
          release_date = ?
      WHERE id = ? AND track_count = 0
    `).run(
      releaseType,
      metadata.isCompilation ? 1 : 0,
      metadata.musicbrainzAlbumId ?? null,
      metadata.musicbrainzReleaseGroupId ?? null,
      metadata.releaseDate ?? null,
      id,
    )
    return result.changes > 0
  }
}
