-- Per-device toggle: fetch missing lyrics online (LRCLIB) during PC->device sync.
ALTER TABLE devices ADD COLUMN fetch_lyrics INTEGER NOT NULL DEFAULT 1
  CHECK (fetch_lyrics IN (0,1));
