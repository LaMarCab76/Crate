-- Per-album favorite state for library entity.
ALTER TABLE albums ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE albums ADD COLUMN state_updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_albums_favorite ON albums(is_favorite);
CREATE INDEX IF NOT EXISTS idx_albums_state_updated_at ON albums(state_updated_at);

