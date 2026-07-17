-- Durable library relocation/merge journal. A migration never changes the
-- catalog until every planned destination entry has been transferred and
-- verified. Locks are separate from history so completed runs remain
-- inspectable while locations can participate in future migrations.

CREATE TABLE IF NOT EXISTS library_location_migration_runs (
  id                         TEXT PRIMARY KEY,
  -- Keep the numeric source identity in history after a merge removes the
  -- source registration. The active lock below still carries the live FK.
  source_folder_id           INTEGER NOT NULL,
  source_provider            TEXT NOT NULL CHECK (source_provider IN ('local', 'onedrive')),
  target_folder_id           INTEGER REFERENCES folders(id) ON DELETE RESTRICT,
  mode                       TEXT NOT NULL CHECK (mode IN ('relocate', 'merge')),
  source_role                TEXT NOT NULL CHECK (source_role IN ('library', 'backup')),
  source_disposition         TEXT NOT NULL CHECK (source_disposition IN ('keep', 'trash')),
  source_name                TEXT NOT NULL,
  source_path                TEXT NOT NULL,
  source_account_id          TEXT,
  source_drive_id            TEXT,
  source_item_id             TEXT,
  source_remote_path         TEXT,
  target_provider            TEXT NOT NULL CHECK (target_provider IN ('local', 'onedrive')),
  target_name                TEXT NOT NULL,
  target_path                TEXT NOT NULL,
  target_account_id          TEXT,
  target_drive_id            TEXT,
  target_item_id             TEXT,
  target_remote_path         TEXT,
  unified_backup_json        TEXT,
  status                     TEXT NOT NULL CHECK (status IN (
                               'planning', 'awaiting_approval', 'transferring',
                               'publishing', 'committing', 'cleanup_pending',
                               'paused', 'completed', 'failed', 'cancelled'
                             )),
  phase                      TEXT NOT NULL,
  source_root_identity       TEXT,
  target_root_identity       TEXT,
  plan_summary_json          TEXT,
  conflicts_json             TEXT,
  error                      TEXT,
  cleanup_error              TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  started_at                 TEXT,
  committed_at               TEXT,
  completed_at               TEXT,
  CHECK (mode = 'relocate' OR target_folder_id IS NOT NULL),
  CHECK (source_folder_id <> target_folder_id)
);

CREATE INDEX IF NOT EXISTS idx_library_migrations_source_created
  ON library_location_migration_runs(source_folder_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_library_migrations_status
  ON library_location_migration_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS library_location_migration_locks (
  folder_id   INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES library_location_migration_runs(id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_library_migration_locks_run
  ON library_location_migration_locks(run_id);

CREATE TABLE IF NOT EXISTS library_location_migration_entries (
  id                         TEXT PRIMARY KEY,
  run_id                     TEXT NOT NULL REFERENCES library_location_migration_runs(id) ON DELETE CASCADE,
  ordinal                    INTEGER NOT NULL CHECK (ordinal >= 0),
  kind                       TEXT NOT NULL CHECK (kind IN ('directory', 'file')),
  source_relative_path       TEXT NOT NULL,
  destination_relative_path  TEXT NOT NULL,
  source_entry_json          TEXT NOT NULL,
  destination_entry_json     TEXT,
  -- Preserve the incoming track id in the durable mapping even when an
  -- identical source row is deduplicated during commit.
  source_track_id            INTEGER,
  canonical_track_id         INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  conflict                   TEXT CHECK (conflict IS NULL OR conflict IN ('renamed', 'identical')),
  status                     TEXT NOT NULL CHECK (status IN (
                               'pending', 'transferring', 'transferred',
                               'publishing', 'published', 'failed', 'paused'
                             )),
  bytes_total                INTEGER NOT NULL DEFAULT 0 CHECK (bytes_total >= 0),
  bytes_completed            INTEGER NOT NULL DEFAULT 0 CHECK (
                               bytes_completed >= 0 AND bytes_completed <= bytes_total
                             ),
  resume_state_json          TEXT,
  published_entry_json       TEXT,
  error                      TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  completed_at               TEXT,
  UNIQUE(run_id, ordinal),
  UNIQUE(run_id, source_relative_path),
  UNIQUE(run_id, destination_relative_path),
  CHECK (source_relative_path <> '' AND source_relative_path NOT LIKE '/%'),
  CHECK (destination_relative_path <> '' AND destination_relative_path NOT LIKE '/%')
);

CREATE INDEX IF NOT EXISTS idx_library_migration_entries_run_status
  ON library_location_migration_entries(run_id, status, ordinal);
