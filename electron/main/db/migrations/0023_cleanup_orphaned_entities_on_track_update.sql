-- Track album moves update the existing track row instead of deleting/reinserting
-- it. Clean up normalized entities that became orphaned through UPDATE paths,
-- and repair any rows left behind by older builds.

DELETE FROM albums
WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = albums.id);

DELETE FROM artists
WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.artist_id = artists.id);

DELETE FROM genres
WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.genre_id = genres.id);

DROP TRIGGER IF EXISTS update_artist_stats_on_update;

CREATE TRIGGER IF NOT EXISTS update_artist_stats_on_update
AFTER UPDATE OF artist_id, album_id ON tracks
FOR EACH ROW
WHEN OLD.artist_id IS NOT NEW.artist_id OR OLD.album_id IS NOT NEW.album_id
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

CREATE TRIGGER IF NOT EXISTS cleanup_orphaned_albums_on_update
AFTER UPDATE OF album_id ON tracks
FOR EACH ROW
WHEN OLD.album_id IS NOT NEW.album_id AND OLD.album_id IS NOT NULL
BEGIN
    DELETE FROM albums
    WHERE id = OLD.album_id
      AND NOT EXISTS (SELECT 1 FROM tracks WHERE album_id = OLD.album_id);
END;

CREATE TRIGGER IF NOT EXISTS cleanup_orphaned_artists_on_update
AFTER UPDATE OF artist_id ON tracks
FOR EACH ROW
WHEN OLD.artist_id IS NOT NEW.artist_id AND OLD.artist_id IS NOT NULL
BEGIN
    DELETE FROM artists
    WHERE id = OLD.artist_id
      AND NOT EXISTS (SELECT 1 FROM tracks WHERE artist_id = OLD.artist_id);
END;

CREATE TRIGGER IF NOT EXISTS cleanup_orphaned_genres_on_update
AFTER UPDATE OF genre_id ON tracks
FOR EACH ROW
WHEN OLD.genre_id IS NOT NEW.genre_id AND OLD.genre_id IS NOT NULL
BEGIN
    DELETE FROM genres
    WHERE id = OLD.genre_id
      AND NOT EXISTS (SELECT 1 FROM tracks WHERE genre_id = OLD.genre_id);
END;
