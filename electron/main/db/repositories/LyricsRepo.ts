import type { Database as BetterSqliteDatabase, Statement } from 'better-sqlite3'
import type { DbTrackLyrics, DbTrackLyricsUpsert, DbLyricsFailure } from '@shared/types/db'
import type { LyricsFailureReason } from '@shared/types/lyrics'

// One active lyrics row per track (track_lyrics has UNIQUE(track_id)); upserts
// key on the conflict. lyrics_failures keeps history so backoff / not-found TTL
// can be reasoned about.
export class LyricsRepo {
  private db: BetterSqliteDatabase
  private stmtByTrackId: Statement
  private stmtHas: Statement
  private stmtUpsert: Statement
  private stmtUserEdit: Statement
  private stmtMarkEmbedded: Statement
  private stmtMarkSidecar: Statement
  private stmtDelete: Statement
  private stmtInsertFailure: Statement
  private stmtLastFailure: Statement

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtByTrackId = db.prepare<[number], DbTrackLyrics>(
      `SELECT * FROM track_lyrics WHERE track_id = ?`,
    )
    this.stmtHas = db.prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM track_lyrics WHERE track_id = ?`,
    )
    // Cache/provider save. Preserves created_at on conflict, bumps updated_at.
    // Does not touch is_user_edited / embedded / sidecar flags.
    this.stmtUpsert = db.prepare(`
      INSERT INTO track_lyrics (
        track_id, plain_lyrics, synced_lyrics_lrc, source, source_id, source_url,
        confidence, instrumental, fetched_at, created_at, updated_at
      ) VALUES (
        @track_id, @plain_lyrics, @synced_lyrics_lrc, @source, @source_id, @source_url,
        @confidence, @instrumental, @ts, @ts, @ts
      )
      ON CONFLICT(track_id) DO UPDATE SET
        plain_lyrics      = excluded.plain_lyrics,
        synced_lyrics_lrc = excluded.synced_lyrics_lrc,
        source            = excluded.source,
        source_id         = excluded.source_id,
        source_url        = excluded.source_url,
        confidence        = excluded.confidence,
        instrumental      = excluded.instrumental,
        fetched_at        = excluded.fetched_at,
        updated_at        = excluded.updated_at
    `)
    // User edit / import. Marks the row authoritative (source='user', confidence=1).
    this.stmtUserEdit = db.prepare(`
      INSERT INTO track_lyrics (
        track_id, plain_lyrics, synced_lyrics_lrc, source, confidence,
        is_user_edited, instrumental, created_at, updated_at
      ) VALUES (
        @track_id, @plain_lyrics, @synced_lyrics_lrc, 'user', 1, 1, 0, @ts, @ts
      )
      ON CONFLICT(track_id) DO UPDATE SET
        plain_lyrics      = excluded.plain_lyrics,
        synced_lyrics_lrc = excluded.synced_lyrics_lrc,
        source            = 'user',
        confidence        = 1,
        is_user_edited    = 1,
        instrumental      = 0,
        updated_at        = excluded.updated_at
    `)
    this.stmtMarkEmbedded = db.prepare(
      `UPDATE track_lyrics SET embedded_in_file = ?, embedded_at = ?, updated_at = ? WHERE track_id = ?`,
    )
    this.stmtMarkSidecar = db.prepare(
      `UPDATE track_lyrics SET sidecar_written = ?, sidecar_path = ?, updated_at = ? WHERE track_id = ?`,
    )
    this.stmtDelete = db.prepare(`DELETE FROM track_lyrics WHERE track_id = ?`)
    this.stmtInsertFailure = db.prepare(`
      INSERT INTO lyrics_failures (track_id, provider, reason, details, failed_at)
      VALUES (@track_id, @provider, @reason, @details, @failed_at)
    `)
    this.stmtLastFailure = db.prepare<[number], DbLyricsFailure>(
      `SELECT * FROM lyrics_failures WHERE track_id = ? ORDER BY failed_at DESC LIMIT 1`,
    )
  }

  getByTrackId(trackId: number): DbTrackLyrics | undefined {
    return this.stmtByTrackId.get(trackId) as DbTrackLyrics | undefined
  }

  hasLyrics(trackId: number): boolean {
    return ((this.stmtHas.get(trackId) as { c: number }).c) > 0
  }

  upsert(input: DbTrackLyricsUpsert): DbTrackLyrics {
    const ts = Date.now()
    this.stmtUpsert.run({
      track_id: input.track_id,
      plain_lyrics: input.plain_lyrics ?? null,
      synced_lyrics_lrc: input.synced_lyrics_lrc ?? null,
      source: input.source,
      source_id: input.source_id ?? null,
      source_url: input.source_url ?? null,
      confidence: input.confidence,
      instrumental: input.instrumental ?? 0,
      ts,
    })
    return this.getByTrackId(input.track_id)!
  }

  setUserEdited(trackId: number, plain: string | null, synced: string | null): DbTrackLyrics {
    this.stmtUserEdit.run({ track_id: trackId, plain_lyrics: plain, synced_lyrics_lrc: synced, ts: Date.now() })
    return this.getByTrackId(trackId)!
  }

  markEmbedded(trackId: number, embedded: boolean): void {
    this.stmtMarkEmbedded.run(embedded ? 1 : 0, embedded ? Date.now() : null, Date.now(), trackId)
  }

  markSidecarWritten(trackId: number, written: boolean, sidecarPath: string | null): void {
    this.stmtMarkSidecar.run(written ? 1 : 0, sidecarPath, Date.now(), trackId)
  }

  delete(trackId: number): void {
    this.stmtDelete.run(trackId)
  }

  recordFailure(trackId: number, provider: string, reason: LyricsFailureReason, details?: string): void {
    this.stmtInsertFailure.run({
      track_id: trackId,
      provider,
      reason,
      details: details ?? null,
      failed_at: Date.now(),
    })
  }

  lastFailure(trackId: number): DbLyricsFailure | undefined {
    return this.stmtLastFailure.get(trackId) as DbLyricsFailure | undefined
  }
}
