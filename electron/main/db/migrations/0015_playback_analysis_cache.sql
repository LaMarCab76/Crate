-- Persistent playback/visualization analysis cache.
-- Holds compact analysis blobs used to rebuild player graphs without
-- re-decoding audio files on later views.

CREATE TABLE IF NOT EXISTS playback_analysis_cache (
    track_id             INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE ON UPDATE CASCADE,
    analysis_version     INTEGER NOT NULL,
    track_path           TEXT NOT NULL,
    file_size            INTEGER,
    file_mtime_ms        INTEGER,
    track_date_modified  TEXT,
    waveform_buckets     INTEGER NOT NULL,
    spectrum_bins        INTEGER NOT NULL,
    spectrum_frames      INTEGER NOT NULL,
    waveform_peaks       BLOB NOT NULL,
    spectrum_preview     BLOB NOT NULL,
    dr_approx            REAL NOT NULL,
    peak_db              REAL NOT NULL,
    byte_size            INTEGER NOT NULL,
    created_at           TEXT NOT NULL,
    last_accessed_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playback_analysis_cache_access
  ON playback_analysis_cache (last_accessed_at);

CREATE INDEX IF NOT EXISTS idx_playback_analysis_cache_size
  ON playback_analysis_cache (byte_size);

CREATE TABLE IF NOT EXISTS playback_cache_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO playback_cache_settings (key, value, updated_at)
VALUES ('max_bytes', '1073741824', datetime('now'));
