import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbTrack } from '@shared/types/db'
import { dbTrackSelectColumns } from './trackColumns.ts'

const ALL_COLUMNS = dbTrackSelectColumns()
const QUALIFIED_TRACK_COLUMNS = dbTrackSelectColumns('t')

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
      SELECT ${QUALIFIED_TRACK_COLUMNS}
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
