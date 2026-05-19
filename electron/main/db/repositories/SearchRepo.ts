import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbAlbum, DbArtist, DbTrack } from '@shared/types/db'

export interface SearchResults {
  tracks: DbTrack[]
  albums: DbAlbum[]
  artists: DbArtist[]
}

// Sanitize the user query for FTS5 MATCH: escape double-quotes, then wrap
// each term in double quotes and append a prefix wildcard.
function buildFtsQuery(raw: string): string {
  const cleaned = raw.replace(/"/g, '""').trim()
  if (cleaned.length === 0) return ''
  const terms = cleaned.split(/\s+/).filter(Boolean)
  return terms.map(t => `"${t}"*`).join(' ')
}

export class SearchRepo {
  private db: BetterSqliteDatabase
  private stmtTracks
  private stmtAlbums
  private stmtArtists

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtTracks = db.prepare<[string, number], DbTrack>(`
      SELECT t.* FROM tracks t
      INNER JOIN tracks_fts fts ON fts.rowid = t.id
      WHERE tracks_fts MATCH ?
      ORDER BY bm25(tracks_fts)
      LIMIT ?
    `)
    this.stmtAlbums = db.prepare<[string, number], DbAlbum>(`
      SELECT a.* FROM albums a
      INNER JOIN albums_fts fts ON fts.rowid = a.id
      WHERE albums_fts MATCH ?
      ORDER BY bm25(albums_fts)
      LIMIT ?
    `)
    this.stmtArtists = db.prepare<[string, number], DbArtist>(`
      SELECT a.* FROM artists a
      INNER JOIN artists_fts fts ON fts.rowid = a.id
      WHERE artists_fts MATCH ?
      ORDER BY bm25(artists_fts)
      LIMIT ?
    `)
  }

  search(query: string, limit = 20): SearchResults {
    const fts = buildFtsQuery(query)
    if (!fts) return { tracks: [], albums: [], artists: [] }
    return {
      tracks: this.stmtTracks.all(fts, limit),
      albums: this.stmtAlbums.all(fts, limit),
      artists: this.stmtArtists.all(fts, limit),
    }
  }
}
