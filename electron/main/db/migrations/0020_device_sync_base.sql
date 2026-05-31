-- Per-device conflict base for bidirectional sync: which side wins when a track
-- changed on both. 'review' decides per track. Persisted so the choice in the
-- device's Configuración tab is remembered across sessions.
ALTER TABLE devices ADD COLUMN sync_base TEXT NOT NULL DEFAULT 'review'
  CHECK (sync_base IN ('pc','device','review'));
