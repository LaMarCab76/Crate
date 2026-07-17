-- Lyrics are no longer stored in the database. The `.lrc` sidecar next to the
-- audio file (plus embedded tags as a read source) is now the single source of
-- truth. Before this migration runs, materializeLyricsSidecars() writes a
-- checksummed recovery archive under userData and then materializes/verifies
-- sidecars. The retained archive covers rows whose volume was unavailable.
DROP INDEX IF EXISTS idx_lyrics_failures_track;
DROP TABLE IF EXISTS lyrics_failures;

DROP INDEX IF EXISTS idx_track_lyrics_embedded;
DROP INDEX IF EXISTS idx_track_lyrics_track;
DROP TABLE IF EXISTS track_lyrics;
