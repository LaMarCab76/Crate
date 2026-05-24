-- A device can sync from more than one library (folder). This join table holds
-- the set of source libraries selected per device. Empty set = sync every
-- library (backward-compatible default).
CREATE TABLE IF NOT EXISTS device_libraries (
  device_id  TEXT    NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_device_libraries_device ON device_libraries(device_id);
