-- Lyrics cache + per-track lyrics state, plus a failure log for fetch/embed
-- attempts. Re-introduces lyrics storage (the original 0001 table was dropped in
-- 0007). Adapted from the feature spec to Crate conventions: INTEGER track FKs,
-- snake_case columns, epoch-millisecond timestamps (like state_updated_at).

CREATE TABLE IF NOT EXISTS track_lyrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id          INTEGER NOT NULL UNIQUE
                      REFERENCES tracks(id) ON DELETE CASCADE ON UPDATE CASCADE,

  -- Content. Either/both may be present. Both NULL + instrumental=1 => instrumental.
  plain_lyrics      TEXT,
  synced_lyrics_lrc TEXT,

  -- Provenance. CHECK mirrors the LyricsSource union in shared/types/lyrics.ts.
  source            TEXT NOT NULL
                      CHECK (source IN ('user','embedded','sidecar','cache','lrclib')),
  source_id         TEXT,                     -- e.g. lrclib numeric id as text
  source_url        TEXT,
  confidence        REAL NOT NULL DEFAULT 0
                      CHECK (confidence >= 0 AND confidence <= 1),  -- 0..1
  instrumental      INTEGER NOT NULL DEFAULT 0,

  -- Lifecycle flags.
  is_user_edited    INTEGER NOT NULL DEFAULT 0,
  embedded_in_file  INTEGER NOT NULL DEFAULT 0,
  sidecar_written   INTEGER NOT NULL DEFAULT 0,

  -- Timestamps (epoch milliseconds).
  fetched_at        INTEGER,
  embedded_at       INTEGER,
  sidecar_path      TEXT,                     -- absolute path of the .lrc we wrote, if any
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_track_lyrics_track    ON track_lyrics(track_id);
CREATE INDEX IF NOT EXISTS idx_track_lyrics_embedded ON track_lyrics(embedded_in_file);

CREATE TABLE IF NOT EXISTS lyrics_failures (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id  INTEGER NOT NULL
              REFERENCES tracks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  provider  TEXT NOT NULL,   -- 'lrclib'|'flac-writer'|'sidecar-writer'|'matcher'
  reason    TEXT NOT NULL,   -- LyricsFailureReason code
  details   TEXT,
  failed_at INTEGER NOT NULL
);

-- Composite so the per-track "most recent failure" lookup
-- (WHERE track_id = ? ORDER BY failed_at DESC LIMIT 1) is served by the index.
CREATE INDEX IF NOT EXISTS idx_lyrics_failures_track ON lyrics_failures(track_id, failed_at DESC);
