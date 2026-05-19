import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbTrack } from '@shared/types/db'

const ALL_COLUMNS = `
  id, path, filename, title, artist, album, duration, format, folder_id,
  file_size, date_modified, album_artist, composer, genre, year,
  is_favorite, play_count, last_played_date, rating,
  track_number, total_tracks, disc_number, total_discs,
  compilation, release_date, original_release_date, bpm, media_type,
  sort_title, sort_artist, sort_album, sort_album_artist,
  bitrate, sample_rate, channels, codec, bit_depth,
  artwork_data, artwork_path, date_added, is_duplicate, primary_track_id, duplicate_group_id,
  extended_metadata, album_id, artist_id, genre_id, r128_integrated_loudness
`

export class EntityTracksRepo {
  private stmtByAlbum
  private stmtByArtist
  private stmtByGenre
  private stmtByPlaylist

  constructor(db: BetterSqliteDatabase) {
    this.stmtByAlbum = db.prepare<[number], DbTrack>(`
      SELECT ${ALL_COLUMNS} FROM tracks
      WHERE album_id = ?
      ORDER BY disc_number ASC, track_number ASC, title COLLATE NOCASE ASC
    `)
    this.stmtByArtist = db.prepare<[number], DbTrack>(`
      SELECT ${ALL_COLUMNS} FROM tracks
      WHERE artist_id = ?
      ORDER BY year DESC, album COLLATE NOCASE ASC, disc_number ASC, track_number ASC
    `)
    this.stmtByGenre = db.prepare<[number], DbTrack>(`
      SELECT ${ALL_COLUMNS} FROM tracks
      WHERE genre_id = ?
      ORDER BY date_added DESC
    `)
    this.stmtByPlaylist = db.prepare<[number], DbTrack>(`
      SELECT ${ALL_COLUMNS.split(',').map(c => `t.${c.trim()}`).join(', ')}
      FROM tracks t
      INNER JOIN playlist_tracks pt ON pt.track_id = t.id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position ASC
    `)
  }

  getTracksForAlbum(albumId: number): DbTrack[] {
    return this.stmtByAlbum.all(albumId)
  }

  getTracksForArtist(artistId: number): DbTrack[] {
    return this.stmtByArtist.all(artistId)
  }

  getTracksForGenre(genreId: number): DbTrack[] {
    return this.stmtByGenre.all(genreId)
  }

  getTracksForPlaylist(playlistId: number): DbTrack[] {
    return this.stmtByPlaylist.all(playlistId)
  }
}
