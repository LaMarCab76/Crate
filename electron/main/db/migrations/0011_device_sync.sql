-- Remember linked Rockbox/DAP devices and audit completed sync attempts.
-- Portable state still lives on the device under .crate/*.yaml; these tables
-- make the local UI fast and keep a minimal local history.

CREATE TABLE IF NOT EXISTS devices (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  root_path       TEXT NOT NULL UNIQUE,
  music_root      TEXT NOT NULL DEFAULT '.',
  sync_mode       TEXT NOT NULL DEFAULT 'bidirectional_safe'
                    CHECK (sync_mode IN ('pc_to_device','device_to_pc','bidirectional_safe')),
  pc_target_path  TEXT NOT NULL,
  has_rockbox     INTEGER NOT NULL DEFAULT 0,
  track_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  last_scan_at    TEXT,
  last_sync_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS device_sync_runs (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL CHECK (mode IN ('pc_to_device','device_to_pc','bidirectional_safe')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  plan_json    TEXT NOT NULL,
  result_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_sync_runs_device
  ON device_sync_runs(device_id, started_at DESC);
