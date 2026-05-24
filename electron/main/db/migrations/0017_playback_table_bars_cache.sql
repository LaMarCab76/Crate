-- Persistent compact 60 Hz bars for table/row playback indicators.
-- The main visualizers keep using live FFT; this cache is only for compact
-- indicators when the full player visualizer is hidden or unavailable.

CREATE TABLE IF NOT EXISTS playback_table_bars_cache (
    track_id             INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE ON UPDATE CASCADE,
    analysis_version     INTEGER NOT NULL,
    track_path           TEXT NOT NULL,
    file_size            INTEGER,
    file_mtime_ms        INTEGER,
    track_date_modified  TEXT,
    fps                  INTEGER NOT NULL,
    bands                INTEGER NOT NULL,
    frames               INTEGER NOT NULL,
    duration_sec         REAL NOT NULL,
    complete             INTEGER NOT NULL,
    values_blob          BLOB NOT NULL,
    byte_size            INTEGER NOT NULL,
    created_at           TEXT NOT NULL,
    last_accessed_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playback_table_bars_cache_access
  ON playback_table_bars_cache (last_accessed_at);

CREATE INDEX IF NOT EXISTS idx_playback_table_bars_cache_size
  ON playback_table_bars_cache (byte_size);
