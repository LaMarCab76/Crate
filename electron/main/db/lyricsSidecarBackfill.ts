import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { sidecarPathFor } from '../lyrics/providers/SidecarLrcProvider'
import { writeSidecarLrc } from '../lyrics/writers/SidecarLrcWriter'

interface BackfillRow {
  path: string
  synced: string | null
  plain: string | null
}

// One-time data migration that runs BEFORE the lyrics tables are dropped
// (migration 0019). Lyrics now live only on disk (the `.lrc` sidecar next to the
// audio), so any lyrics that were cached in `track_lyrics` but never written to a
// sidecar are materialized here to avoid losing them.
//
// Idempotent / self-disabling:
//   - On a DB where 0019 already dropped `track_lyrics`, the guard returns early.
//   - On a brand-new DB this runs before any migration, so the table does not
//     exist yet and the guard also returns early.
//   - Per-row best-effort: a single failed write never aborts the rest, and an
//     existing sidecar is never overwritten (a newer on-disk file wins).
export function materializeLyricsSidecars(db: BetterSqliteDatabase): void {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'track_lyrics'`)
    .get()
  if (!tableExists) return

  let rows: BackfillRow[]
  try {
    rows = db
      .prepare(
        `SELECT t.path AS path, l.synced_lyrics_lrc AS synced, l.plain_lyrics AS plain
           FROM track_lyrics l
           JOIN tracks t ON t.id = l.track_id
          WHERE l.synced_lyrics_lrc IS NOT NULL OR l.plain_lyrics IS NOT NULL`,
      )
      .all() as BackfillRow[]
  } catch {
    // Schema not as expected (older/newer) — skip rather than block startup.
    return
  }

  let written = 0
  for (const row of rows) {
    const content = row.synced ?? row.plain
    if (!content || !row.path) continue
    try {
      if (existsSync(sidecarPathFor(row.path))) continue
      writeSidecarLrc(row.path, content)
      written++
    } catch {
      // best-effort per row; never abort the rest or block startup
    }
  }
  if (written > 0) console.log(`[db] materialized ${written} lyrics sidecar(s) before drop`)
}
