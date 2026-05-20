-- Statistics-update triggers + orphan-cleanup triggers.

-- =============================================================================
-- Statistics: album track_count + total_duration on INSERT/DELETE/UPDATE
-- =============================================================================
CREATE TRIGGER IF NOT EXISTS update_album_stats_on_insert
AFTER INSERT ON tracks
FOR EACH ROW
WHEN NEW.album_id IS NOT NULL
BEGIN
    UPDATE albums
    SET track_count    = (SELECT COUNT(*)                FROM tracks WHERE album_id = NEW.album_id),
        total_duration = (SELECT COALESCE(SUM(duration), 0) FROM tracks WHERE album_id = NEW.album_id)
    WHERE id = NEW.album_id;
END;

CREATE TRIGGER IF NOT EXISTS update_album_stats_on_delete
AFTER DELETE ON tracks
FOR EACH ROW
WHEN OLD.album_id IS NOT NULL
BEGIN
    UPDATE albums
    SET track_count    = (SELECT COUNT(*)                FROM tracks WHERE album_id = OLD.album_id),
        total_duration = (SELECT COALESCE(SUM(duration), 0) FROM tracks WHERE album_id = OLD.album_id)
    WHERE id = OLD.album_id;
END;

CREATE TRIGGER IF NOT EXISTS update_album_stats_on_update
AFTER UPDATE OF album_id, duration ON tracks
FOR EACH ROW
WHEN OLD.album_id IS NOT NEW.album_id OR OLD.duration != NEW.duration
BEGIN
    UPDATE albums
    SET track_count    = (SELECT COUNT(*)                FROM tracks WHERE album_id = OLD.album_id),
        total_duration = (SELECT COALESCE(SUM(duration), 0) FROM tracks WHERE album_id = OLD.album_id)
    WHERE id = OLD.album_id AND OLD.album_id IS NOT NULL;

    UPDATE albums
    SET track_count    = (SELECT COUNT(*)                FROM tracks WHERE album_id = NEW.album_id),
        total_duration = (SELECT COALESCE(SUM(duration), 0) FROM tracks WHERE album_id = NEW.album_id)
    WHERE id = NEW.album_id AND NEW.album_id IS NOT NULL;
END;

-- =============================================================================
-- Statistics: artist track_count + album_count
-- =============================================================================
CREATE TRIGGER IF NOT EXISTS update_artist_stats_on_insert
AFTER INSERT ON tracks
FOR EACH ROW
WHEN NEW.artist_id IS NOT NULL
BEGIN
    UPDATE artists
    SET track_count = (SELECT COUNT(*)            FROM tracks WHERE artist_id = NEW.artist_id),
        album_count = (SELECT COUNT(DISTINCT album_id) FROM tracks WHERE artist_id = NEW.artist_id AND album_id IS NOT NULL)
    WHERE id = NEW.artist_id;
END;

CREATE TRIGGER IF NOT EXISTS update_artist_stats_on_delete
AFTER DELETE ON tracks
FOR EACH ROW
WHEN OLD.artist_id IS NOT NULL
BEGIN
    UPDATE artists
    SET track_count = (SELECT COUNT(*)            FROM tracks WHERE artist_id = OLD.artist_id),
        album_count = (SELECT COUNT(DISTINCT album_id) FROM tracks WHERE artist_id = OLD.artist_id AND album_id IS NOT NULL)
    WHERE id = OLD.artist_id;
END;

CREATE TRIGGER IF NOT EXISTS update_artist_stats_on_update
AFTER UPDATE OF artist_id, album_id ON tracks
FOR EACH ROW
WHEN OLD.artist_id IS NOT NEW.artist_id
BEGIN
    UPDATE artists
    SET track_count = (SELECT COUNT(*)            FROM tracks WHERE artist_id = OLD.artist_id),
        album_count = (SELECT COUNT(DISTINCT album_id) FROM tracks WHERE artist_id = OLD.artist_id AND album_id IS NOT NULL)
    WHERE id = OLD.artist_id AND OLD.artist_id IS NOT NULL;

    UPDATE artists
    SET track_count = (SELECT COUNT(*)            FROM tracks WHERE artist_id = NEW.artist_id),
        album_count = (SELECT COUNT(DISTINCT album_id) FROM tracks WHERE artist_id = NEW.artist_id AND album_id IS NOT NULL)
    WHERE id = NEW.artist_id AND NEW.artist_id IS NOT NULL;
END;

-- =============================================================================
-- Statistics: genre track_count
-- =============================================================================
CREATE TRIGGER IF NOT EXISTS update_genre_stats_on_insert
AFTER INSERT ON tracks
FOR EACH ROW
WHEN NEW.genre_id IS NOT NULL
BEGIN
    UPDATE genres
    SET track_count = (SELECT COUNT(*) FROM tracks WHERE genre_id = NEW.genre_id)
    WHERE id = NEW.genre_id;
END;

CREATE TRIGGER IF NOT EXISTS update_genre_stats_on_delete
AFTER DELETE ON tracks
FOR EACH ROW
WHEN OLD.genre_id IS NOT NULL
BEGIN
    UPDATE genres
    SET track_count = (SELECT COUNT(*) FROM tracks WHERE genre_id = OLD.genre_id)
    WHERE id = OLD.genre_id;
END;

CREATE TRIGGER IF NOT EXISTS update_genre_stats_on_update
AFTER UPDATE OF genre_id ON tracks
FOR EACH ROW
WHEN OLD.genre_id IS NOT NEW.genre_id
BEGIN
    UPDATE genres
    SET track_count = (SELECT COUNT(*) FROM tracks WHERE genre_id = OLD.genre_id)
    WHERE id = OLD.genre_id AND OLD.genre_id IS NOT NULL;

    UPDATE genres
    SET track_count = (SELECT COUNT(*) FROM tracks WHERE genre_id = NEW.genre_id)
    WHERE id = NEW.genre_id AND NEW.genre_id IS NOT NULL;
END;

-- =============================================================================
-- Orphan cleanup: drop empty albums/artists/genres when their last track is gone
-- =============================================================================
CREATE TRIGGER IF NOT EXISTS cleanup_orphaned_albums
AFTER DELETE ON tracks
FOR EACH ROW
WHEN OLD.album_id IS NOT NULL
BEGIN
    DELETE FROM albums
    WHERE id = OLD.album_id
      AND NOT EXISTS (SELECT 1 FROM tracks WHERE album_id = OLD.album_id);
END;

CREATE TRIGGER IF NOT EXISTS cleanup_orphaned_artists
AFTER DELETE ON tracks
FOR EACH ROW
WHEN OLD.artist_id IS NOT NULL
BEGIN
    DELETE FROM artists
    WHERE id = OLD.artist_id
      AND NOT EXISTS (SELECT 1 FROM tracks WHERE artist_id = OLD.artist_id);
END;

CREATE TRIGGER IF NOT EXISTS cleanup_orphaned_genres
AFTER DELETE ON tracks
FOR EACH ROW
WHEN OLD.genre_id IS NOT NULL
BEGIN
    DELETE FROM genres
    WHERE id = OLD.genre_id
      AND NOT EXISTS (SELECT 1 FROM tracks WHERE genre_id = OLD.genre_id);
END;
