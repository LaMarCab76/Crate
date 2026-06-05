-- Legacy per-device toggle. Kept for migrated rows/YAML compatibility; device
-- sync now propagates local .lrc sidecars only and never fetches LRCLIB online.
ALTER TABLE devices ADD COLUMN fetch_lyrics INTEGER NOT NULL DEFAULT 1
  CHECK (fetch_lyrics IN (0,1));
