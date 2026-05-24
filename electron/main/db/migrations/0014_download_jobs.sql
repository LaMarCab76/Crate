CREATE TABLE IF NOT EXISTS download_jobs (
    id                 TEXT PRIMARY KEY,
    provider           TEXT NOT NULL,
    provider_track_id  TEXT NOT NULL,
    status             TEXT NOT NULL,
    quality            TEXT NOT NULL,
    folder_id          INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    title              TEXT NOT NULL,
    artist             TEXT NOT NULL,
    album              TEXT NOT NULL,
    artwork_url        TEXT,
    source_url         TEXT,
    metadata_json      TEXT,
    path               TEXT,
    error              TEXT,
    bytes_received     INTEGER NOT NULL DEFAULT 0,
    bytes_total        INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    completed_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_download_jobs_provider_track ON download_jobs (provider, provider_track_id);
CREATE INDEX IF NOT EXISTS idx_download_jobs_folder ON download_jobs (folder_id);
