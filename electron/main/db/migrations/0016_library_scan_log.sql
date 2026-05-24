-- Library reconciliation history and folder counter maintenance.

CREATE TABLE IF NOT EXISTS library_scan_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    added       INTEGER NOT NULL DEFAULT 0,
    updated     INTEGER NOT NULL DEFAULT 0,
    removed     INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0,
    error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_library_scan_runs_folder_started
    ON library_scan_runs(folder_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_scan_runs_started
    ON library_scan_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS library_scan_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES library_scan_runs(id) ON DELETE CASCADE,
    folder_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    path        TEXT,
    title       TEXT,
    detail      TEXT,
    occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_library_scan_events_folder_occurred
    ON library_scan_events(folder_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_scan_events_run
    ON library_scan_events(run_id);

CREATE TRIGGER IF NOT EXISTS update_folder_stats_on_insert
AFTER INSERT ON tracks
FOR EACH ROW
BEGIN
    UPDATE folders
    SET track_count = (SELECT COUNT(*) FROM tracks WHERE folder_id = NEW.folder_id),
        date_updated = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.folder_id;
END;

CREATE TRIGGER IF NOT EXISTS update_folder_stats_on_delete
AFTER DELETE ON tracks
FOR EACH ROW
BEGIN
    UPDATE folders
    SET track_count = (SELECT COUNT(*) FROM tracks WHERE folder_id = OLD.folder_id),
        date_updated = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = OLD.folder_id;
END;

CREATE TRIGGER IF NOT EXISTS update_folder_stats_on_update
AFTER UPDATE OF folder_id ON tracks
FOR EACH ROW
WHEN OLD.folder_id IS NOT NEW.folder_id
BEGIN
    UPDATE folders
    SET track_count = (SELECT COUNT(*) FROM tracks WHERE folder_id = OLD.folder_id),
        date_updated = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = OLD.folder_id;

    UPDATE folders
    SET track_count = (SELECT COUNT(*) FROM tracks WHERE folder_id = NEW.folder_id),
        date_updated = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = NEW.folder_id;
END;

UPDATE folders
SET track_count = (SELECT COUNT(*) FROM tracks WHERE tracks.folder_id = folders.id);
