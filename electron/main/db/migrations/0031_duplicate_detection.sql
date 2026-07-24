-- Durable, pair-oriented duplicate detection state. The legacy duplicate
-- columns on tracks intentionally remain untouched: duplicate similarity is
-- not transitive, so it cannot be represented safely as a single group id.

CREATE TABLE IF NOT EXISTS duplicate_track_analyses (
  track_id               INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  source_provider        TEXT NOT NULL CHECK (source_provider IN ('local', 'onedrive')),
  source_locator         TEXT NOT NULL,
  source_file_size       INTEGER CHECK (source_file_size IS NULL OR source_file_size >= 0),
  source_modified        TEXT,
  source_etag            TEXT,
  source_signature       TEXT NOT NULL,
  algorithm              TEXT NOT NULL,
  algorithm_version      TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'error')),
  fingerprint_blob       BLOB,
  fingerprint_digest     TEXT,
  frame_count            INTEGER NOT NULL DEFAULT 0 CHECK (frame_count >= 0),
  frames_per_second      REAL NOT NULL DEFAULT 0 CHECK (frames_per_second >= 0),
  delay_seconds          REAL NOT NULL DEFAULT 0 CHECK (delay_seconds >= 0),
  duration_seconds       REAL NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  error                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK (
    status <> 'ready' OR (
      fingerprint_blob IS NOT NULL AND fingerprint_digest IS NOT NULL
      AND frame_count > 0 AND frames_per_second > 0
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_duplicate_analyses_status
  ON duplicate_track_analyses(status, updated_at);

-- The UUID is portable and deliberately independent of path/provider. Audio
-- changes update acoustic_digest while a move or metadata edit preserves id.
CREATE TABLE IF NOT EXISTS duplicate_track_identities (
  id                    TEXT PRIMARY KEY,
  track_id              INTEGER NOT NULL UNIQUE REFERENCES tracks(id) ON DELETE CASCADE,
  acoustic_digest       TEXT NOT NULL,
  algorithm             TEXT NOT NULL,
  algorithm_version     TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_duplicate_identities_digest
  ON duplicate_track_identities(algorithm, algorithm_version, acoustic_digest);

CREATE TABLE IF NOT EXISTS duplicate_candidates (
  id                         TEXT PRIMARY KEY,
  track_low_id               INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  track_high_id              INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  revision                   INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status                     TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'dismissed', 'stale')),
  similarity                 REAL NOT NULL CHECK (similarity > 0.60 AND similarity <= 1),
  alignment_offset_frames    INTEGER NOT NULL,
  matching_frames            INTEGER NOT NULL CHECK (matching_frames >= 0),
  compared_frames            INTEGER NOT NULL CHECK (compared_frames > 0),
  segments_json              TEXT NOT NULL,
  acoustic_relation          TEXT NOT NULL CHECK (acoustic_relation IN (
                               'near_identical', 'possible_different_edition', 'uncertain'
                             )),
  editorial_relation         TEXT NOT NULL CHECK (editorial_relation IN (
                               'same_release', 'album_vs_single_ep',
                               'album_vs_compilation', 'different_releases', 'unknown'
                             )),
  evidence_json              TEXT NOT NULL DEFAULT '[]',
  recommendation_reasons_json TEXT NOT NULL DEFAULT '[]',
  recommended_track_id       INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  low_fingerprint_digest     TEXT NOT NULL,
  high_fingerprint_digest    TEXT NOT NULL,
  prefilter_json             TEXT NOT NULL DEFAULT '{}',
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  UNIQUE (track_low_id, track_high_id),
  CHECK (track_low_id < track_high_id),
  CHECK (recommended_track_id IS NULL OR recommended_track_id IN (track_low_id, track_high_id))
);

CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_status
  ON duplicate_candidates(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_recommended
  ON duplicate_candidates(recommended_track_id);

-- These rows mirror the records written to .crate/duplicate-decisions.yaml.
-- Identity ids are copied, rather than referenced, so decisions survive a
-- catalog row being temporarily absent during a rebuild.
CREATE TABLE IF NOT EXISTS duplicate_pair_decisions (
  id                         TEXT PRIMARY KEY,
  pair_key                   TEXT NOT NULL UNIQUE,
  low_identity_id            TEXT NOT NULL,
  high_identity_id           TEXT NOT NULL,
  low_acoustic_digest        TEXT NOT NULL,
  high_acoustic_digest       TEXT NOT NULL,
  algorithm                  TEXT NOT NULL,
  algorithm_version          TEXT NOT NULL,
  reason                     TEXT NOT NULL CHECK (reason IN ('different_versions', 'not_duplicates')),
  source                     TEXT NOT NULL DEFAULT 'database'
                               CHECK (source IN ('database', 'portable')),
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  CHECK (low_identity_id < high_identity_id)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_pair_decisions_digests
  ON duplicate_pair_decisions(
    algorithm, algorithm_version, low_acoustic_digest, high_acoustic_digest
  );

-- Two-phase removal journal. Track/candidate ids are snapshots rather than
-- foreign keys so the audit row remains after the catalog commit removes them.
CREATE TABLE IF NOT EXISTS duplicate_resolution_runs (
  id                    TEXT PRIMARY KEY,
  candidate_id          TEXT NOT NULL,
  action                TEXT NOT NULL CHECK (action IN ('keep_both', 'trash_left', 'trash_right')),
  kept_track_id         INTEGER,
  removed_track_id      INTEGER,
  expected_revision     INTEGER NOT NULL CHECK (expected_revision >= 1),
  source_snapshot_json  TEXT NOT NULL,
  device_intents_json   TEXT NOT NULL DEFAULT '[]',
  storage_receipt_json  TEXT,
  state                 TEXT NOT NULL DEFAULT 'planned'
                          CHECK (state IN ('planned', 'storage_done', 'committed', 'failed')),
  error                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  storage_done_at       TEXT,
  committed_at          TEXT,
  CHECK (
    (action = 'keep_both' AND kept_track_id IS NULL AND removed_track_id IS NULL)
    OR
    (action IN ('trash_left', 'trash_right') AND kept_track_id IS NOT NULL
      AND removed_track_id IS NOT NULL AND kept_track_id <> removed_track_id)
  )
);

CREATE INDEX IF NOT EXISTS idx_duplicate_resolution_runs_state
  ON duplicate_resolution_runs(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_duplicate_resolution_runs_candidate
  ON duplicate_resolution_runs(candidate_id, created_at DESC);

-- Per-device deletion intents prevent a device-to-library plan from
-- resurrecting a duplicate removed from the primary library. They remain
-- reviewable and only become applied after a post-delete rescan.
CREATE TABLE IF NOT EXISTS device_duplicate_deletions (
  id                    TEXT PRIMARY KEY,
  resolution_run_id     TEXT REFERENCES duplicate_resolution_runs(id) ON DELETE SET NULL,
  device_id             TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  track_identity_id     TEXT REFERENCES duplicate_track_identities(id) ON DELETE SET NULL,
  sync_key              TEXT NOT NULL,
  relative_path         TEXT NOT NULL,
  expected_fingerprint  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'applied', 'conflict')),
  reason                TEXT NOT NULL DEFAULT 'Corrección de duplicado',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  applied_at            TEXT,
  CHECK (sync_key <> '' AND relative_path <> '' AND relative_path NOT LIKE '/%'),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_duplicate_deletions_active
  ON device_duplicate_deletions(device_id, sync_key)
  WHERE status IN ('pending', 'conflict');
CREATE INDEX IF NOT EXISTS idx_device_duplicate_deletions_device_status
  ON device_duplicate_deletions(device_id, status, created_at);
