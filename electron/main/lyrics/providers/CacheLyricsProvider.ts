import type { DbTrackLyrics } from '@shared/types/db'
import type { LyricsResult } from '@shared/types/lyrics'

// Adapts a stored track_lyrics row into the uniform LyricsResult shape the
// orchestrator works with. Used as priority step 4 (DB cache).
export function rowToResult(row: DbTrackLyrics | undefined): LyricsResult | null {
  if (!row) return null
  if (!row.plain_lyrics && !row.synced_lyrics_lrc && !row.instrumental) return null
  return {
    source: 'cache',
    sourceId: row.source_id ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    plainLyrics: row.plain_lyrics ?? undefined,
    syncedLyricsLrc: row.synced_lyrics_lrc ?? undefined,
    instrumental: row.instrumental === 1,
    confidence: row.confidence,
  }
}
