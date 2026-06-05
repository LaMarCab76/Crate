-- Add a "source" dimension to tracks and folders so the library can hold
-- OneDrive-backed entries alongside local files. Cloud tracks never touch local
-- disk: their bytes are streamed into RAM at playback time. Their `path` column
-- holds a synthetic, unique URI (onedrive://{driveId}/{itemId}) so every existing
-- code path keyed on a non-null, UNIQUE `path` keeps working unchanged.
--
-- Existing rows default to source='local' so no backfill is needed.

ALTER TABLE tracks ADD COLUMN source TEXT NOT NULL DEFAULT 'local'
  CHECK (source IN ('local','onedrive'));
ALTER TABLE tracks ADD COLUMN cloud_drive_id    TEXT;
ALTER TABLE tracks ADD COLUMN cloud_item_id     TEXT;
ALTER TABLE tracks ADD COLUMN cloud_etag        TEXT;   -- eTag/cTag for delta change detection
ALTER TABLE tracks ADD COLUMN cloud_remote_path TEXT;   -- human-readable path inside the drive

CREATE INDEX IF NOT EXISTS idx_tracks_cloud_item
  ON tracks(cloud_drive_id, cloud_item_id);

-- A folders row can now represent a cloud folder. `path` for such a row is
-- onedrive://{driveId}/{folderItemId}; cloud_delta_link persists the Graph
-- @odata.deltaLink cursor for cheap incremental re-syncs.
ALTER TABLE folders ADD COLUMN source TEXT NOT NULL DEFAULT 'local'
  CHECK (source IN ('local','onedrive'));
ALTER TABLE folders ADD COLUMN cloud_drive_id   TEXT;
ALTER TABLE folders ADD COLUMN cloud_item_id    TEXT;
ALTER TABLE folders ADD COLUMN cloud_delta_link TEXT;
