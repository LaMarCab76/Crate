-- Keep denormalized playlist metrics correct for both existing and future data.

UPDATE playlists
SET track_count = (
      SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = playlists.id
    ),
    total_duration = COALESCE((
      SELECT SUM(t.duration)
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = playlists.id
    ), 0);

DROP TRIGGER IF EXISTS update_playlist_metrics_on_insert;
CREATE TRIGGER update_playlist_metrics_on_insert
AFTER INSERT ON playlist_tracks
FOR EACH ROW
BEGIN
  UPDATE playlists
  SET track_count = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = NEW.playlist_id),
      total_duration = COALESCE((
        SELECT SUM(t.duration)
        FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = NEW.playlist_id
      ), 0),
      modified_date = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.playlist_id;
END;

DROP TRIGGER IF EXISTS update_playlist_metrics_on_delete;
CREATE TRIGGER update_playlist_metrics_on_delete
AFTER DELETE ON playlist_tracks
FOR EACH ROW
BEGIN
  UPDATE playlists
  SET track_count = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = OLD.playlist_id),
      total_duration = COALESCE((
        SELECT SUM(t.duration)
        FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = OLD.playlist_id
      ), 0),
      modified_date = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = OLD.playlist_id;
END;

DROP TRIGGER IF EXISTS update_playlist_metrics_on_move;
DROP TRIGGER IF EXISTS update_playlist_metrics_on_update;
CREATE TRIGGER update_playlist_metrics_on_update
AFTER UPDATE ON playlist_tracks
FOR EACH ROW
BEGIN
  UPDATE playlists
  SET track_count = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = OLD.playlist_id),
      total_duration = COALESCE((
        SELECT SUM(t.duration)
        FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = OLD.playlist_id
      ), 0),
      modified_date = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = OLD.playlist_id;

  UPDATE playlists
  SET track_count = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = NEW.playlist_id),
      total_duration = COALESCE((
        SELECT SUM(t.duration)
        FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = NEW.playlist_id
      ), 0),
      modified_date = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.playlist_id;
END;

DROP TRIGGER IF EXISTS update_playlist_metrics_on_track_duration;
CREATE TRIGGER update_playlist_metrics_on_track_duration
AFTER UPDATE OF duration ON tracks
FOR EACH ROW
WHEN OLD.duration IS NOT NEW.duration
BEGIN
  UPDATE playlists
  SET total_duration = COALESCE((
        SELECT SUM(t.duration)
        FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = playlists.id
      ), 0)
  WHERE id IN (SELECT playlist_id FROM playlist_tracks WHERE track_id = NEW.id);
END;
