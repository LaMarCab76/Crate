-- Artists become favorites the user explicitly picks. Library shows all,
-- ArtistsView shows only is_favorite = 1 (or top-N by plays, per settings).
ALTER TABLE artists ADD COLUMN is_favorite INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_artists_favorite ON artists(is_favorite);
