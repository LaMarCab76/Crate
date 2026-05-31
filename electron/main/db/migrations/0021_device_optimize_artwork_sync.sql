-- Per-device toggle: run embedded artwork optimization as part of device sync.
ALTER TABLE devices ADD COLUMN optimize_artwork_on_sync INTEGER NOT NULL DEFAULT 1
  CHECK (optimize_artwork_on_sync IN (0,1));
