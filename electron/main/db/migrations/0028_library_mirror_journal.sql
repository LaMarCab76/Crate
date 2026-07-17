-- Persistent three-way mirror state. Runs and actions survive restarts; the
-- snapshot is replaced only after an entire run has completed successfully.

CREATE TABLE IF NOT EXISTS library_mirror_runs (
  id                  TEXT PRIMARY KEY,
  source_folder_id    INTEGER NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
  backup_folder_id    INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  trigger             TEXT NOT NULL CHECK (trigger IN (
                        'link', 'startup', 'source_change', 'cloud_delta', 'manual', 'resume'
                      )),
  status              TEXT NOT NULL CHECK (status IN (
                        'pending', 'planning', 'awaiting_approval', 'running',
                        'paused', 'completed', 'failed', 'cancelled'
                      )),
  -- Captured with the inventory that produced the persisted action plan.
  -- These identities prevent a resumed run from applying that plan to a
  -- replacement mount point or a different provider root.
  source_root_identity TEXT,
  backup_root_identity TEXT,
  plan_summary_json   TEXT,
  divergence_json     TEXT,
  approved_at         TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT,
  CHECK (source_folder_id <> backup_folder_id)
);

CREATE INDEX IF NOT EXISTS idx_library_mirror_runs_backup_status
  ON library_mirror_runs(backup_folder_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_library_mirror_runs_one_active
  ON library_mirror_runs(backup_folder_id)
  WHERE status IN ('pending', 'planning', 'awaiting_approval', 'running', 'paused');

CREATE TABLE IF NOT EXISTS library_mirror_snapshots (
  backup_folder_id            INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  relative_path               TEXT NOT NULL,
  kind                        TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  size                        INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
  sha256                      TEXT,
  quickxor_hash               TEXT,
  source_etag                 TEXT,
  destination_etag            TEXT,
  source_modified_at_ms       REAL,
  destination_modified_at_ms  REAL,
  run_id                      TEXT NOT NULL REFERENCES library_mirror_runs(id) ON DELETE RESTRICT,
  updated_at                  TEXT NOT NULL,
  PRIMARY KEY (backup_folder_id, relative_path),
  CHECK (relative_path <> '' AND relative_path NOT LIKE '/%')
);

-- An empty source produces no snapshot rows, so retain an explicit successful
-- baseline marker to distinguish it from a never-linked destination.
CREATE TABLE IF NOT EXISTS library_mirror_state (
  backup_folder_id       INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
  last_successful_run_id TEXT NOT NULL REFERENCES library_mirror_runs(id) ON DELETE RESTRICT,
  source_root_identity   TEXT NOT NULL,
  backup_root_identity   TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_mirror_actions (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES library_mirror_runs(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL CHECK (ordinal >= 0),
  kind                TEXT NOT NULL CHECK (kind IN (
                        'create_directory', 'copy_file', 'delete_file', 'delete_directory'
                      )),
  relative_path       TEXT NOT NULL,
  entry_json          TEXT,
  destination_etag    TEXT,
  requires_approval   INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending', 'running', 'completed', 'failed', 'paused'
                      )),
  bytes_total         INTEGER NOT NULL DEFAULT 0 CHECK (bytes_total >= 0),
  bytes_completed     INTEGER NOT NULL DEFAULT 0 CHECK (
                        bytes_completed >= 0 AND bytes_completed <= bytes_total
                      ),
  resume_state_json   TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT,
  UNIQUE (run_id, ordinal),
  CHECK (relative_path <> '' AND relative_path NOT LIKE '/%')
);

CREATE INDEX IF NOT EXISTS idx_library_mirror_actions_run_status
  ON library_mirror_actions(run_id, status, ordinal);
