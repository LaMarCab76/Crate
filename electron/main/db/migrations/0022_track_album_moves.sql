-- Local track moves that need to be reflected on linked MP3/DAP devices.
-- A move is tracked per library track and marked applied per device only after
-- a successful sync shows the old device path gone and the new one present.

CREATE TABLE IF NOT EXISTS track_album_moves (
  id                       TEXT PRIMARY KEY,
  track_id                 INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  old_path                 TEXT NOT NULL,
  new_path                 TEXT NOT NULL,
  old_sync_key             TEXT NOT NULL,
  old_device_relative_path TEXT NOT NULL,
  new_sync_key             TEXT NOT NULL,
  new_device_relative_path TEXT NOT NULL,
  created_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_track_album_moves_track
  ON track_album_moves(track_id, created_at DESC);

CREATE TABLE IF NOT EXISTS track_album_move_device_applies (
  move_id    TEXT NOT NULL REFERENCES track_album_moves(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (move_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_track_album_move_device_applies_device
  ON track_album_move_device_applies(device_id, applied_at DESC);
