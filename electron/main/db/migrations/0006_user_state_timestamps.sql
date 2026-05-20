-- Per-row timestamp for "user state" mutations (favorites, ratings, eq overrides,
-- play counts). Used by the portable library backup to perform a smart merge
-- when re-importing a folder whose .crate-library.json carries divergent
-- values: newer stateUpdatedAt wins for booleans, counters take max() either way.
-- NULL = never modified by the user (treated as 0 / "older than everything").

ALTER TABLE tracks  ADD COLUMN state_updated_at INTEGER;
ALTER TABLE artists ADD COLUMN state_updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tracks_state_updated_at  ON tracks(state_updated_at);
CREATE INDEX IF NOT EXISTS idx_artists_state_updated_at ON artists(state_updated_at);
