-- Disk-cached artwork: hash-named files under userData/artwork/<sha1>.<ext>
-- referenced via TEXT path. The legacy artwork_data BLOB columns stay for
-- compatibility but are no longer written.

ALTER TABLE tracks ADD COLUMN artwork_path TEXT;
ALTER TABLE albums ADD COLUMN artwork_path TEXT;
ALTER TABLE artists ADD COLUMN artwork_path TEXT;
