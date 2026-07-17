-- Treat local and OneDrive roots uniformly as library locations. Existing
-- folders/tracks remain local libraries through the defaults.

ALTER TABLE folders ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'
  CHECK (provider IN ('local', 'onedrive'));
ALTER TABLE folders ADD COLUMN role TEXT NOT NULL DEFAULT 'library'
  CHECK (role IN ('library', 'backup'));
ALTER TABLE folders ADD COLUMN backup_source_folder_id INTEGER
  REFERENCES folders(id) ON DELETE RESTRICT;
ALTER TABLE folders ADD COLUMN account_id TEXT;
ALTER TABLE folders ADD COLUMN drive_id TEXT;
ALTER TABLE folders ADD COLUMN item_id TEXT;
ALTER TABLE folders ADD COLUMN remote_path TEXT;
ALTER TABLE folders ADD COLUMN delta_cursor TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_one_backup_per_source
  ON folders(backup_source_folder_id)
  WHERE role = 'backup';

CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_cloud_item
  ON folders(provider, drive_id, item_id)
  WHERE provider = 'onedrive';

CREATE INDEX IF NOT EXISTS idx_folders_role_provider
  ON folders(role, provider, date_added);

ALTER TABLE tracks ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'
  CHECK (provider IN ('local', 'onedrive'));
ALTER TABLE tracks ADD COLUMN drive_id TEXT;
ALTER TABLE tracks ADD COLUMN item_id TEXT;
ALTER TABLE tracks ADD COLUMN etag TEXT;
ALTER TABLE tracks ADD COLUMN remote_path TEXT;
ALTER TABLE tracks ADD COLUMN quickxor_hash TEXT;

-- The legacy origin/onedrive schema used this name for a non-unique index over
-- cloud_drive_id/cloud_item_id. Recreate it so IF NOT EXISTS cannot silently
-- preserve the weaker invariant.
DROP INDEX IF EXISTS idx_tracks_cloud_item;
CREATE UNIQUE INDEX idx_tracks_cloud_item
  ON tracks(provider, drive_id, item_id)
  WHERE provider = 'onedrive';

CREATE INDEX IF NOT EXISTS idx_tracks_provider_folder
  ON tracks(provider, folder_id);

-- SQLite cannot add a table-level CHECK constraint with ALTER TABLE, so keep
-- the role relationship invariant in triggers. A backup can only point at a
-- current library and can never become a catalog source for tracks.
CREATE TRIGGER IF NOT EXISTS validate_folder_backup_insert
BEFORE INSERT ON folders
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.provider = 'local' AND (
      NEW.account_id IS NOT NULL OR NEW.drive_id IS NOT NULL OR NEW.item_id IS NOT NULL
      OR NEW.remote_path IS NOT NULL OR NEW.delta_cursor IS NOT NULL
    )
      THEN RAISE(ABORT, 'local locations cannot carry OneDrive metadata')
    WHEN NEW.provider = 'onedrive' AND (
      NULLIF(TRIM(NEW.account_id), '') IS NULL OR NULLIF(TRIM(NEW.drive_id), '') IS NULL
      OR NULLIF(TRIM(NEW.item_id), '') IS NULL OR NULLIF(TRIM(NEW.remote_path), '') IS NULL
      OR NEW.path <> 'onedrive://' || NEW.drive_id || '/' || NEW.item_id
    )
      THEN RAISE(ABORT, 'OneDrive locations require account, drive, item, remote path and stable URI')
    WHEN NEW.role = 'library' AND NEW.backup_source_folder_id IS NOT NULL
      THEN RAISE(ABORT, 'library locations cannot have a backup source')
    WHEN NEW.role = 'backup' AND (
      NEW.backup_source_folder_id IS NULL OR NEW.backup_source_folder_id = NEW.id
    )
      THEN RAISE(ABORT, 'backup locations require a different source library')
    WHEN NEW.role = 'backup' AND NOT EXISTS (
      SELECT 1 FROM folders AS source
      WHERE source.id = NEW.backup_source_folder_id AND source.role = 'library'
    )
      THEN RAISE(ABORT, 'backup source must be a library location')
  END;
END;

CREATE TRIGGER IF NOT EXISTS validate_folder_backup_update
BEFORE UPDATE OF provider, role, backup_source_folder_id, path, account_id, drive_id, item_id, remote_path, delta_cursor ON folders
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.provider = 'local' AND (
      NEW.account_id IS NOT NULL OR NEW.drive_id IS NOT NULL OR NEW.item_id IS NOT NULL
      OR NEW.remote_path IS NOT NULL OR NEW.delta_cursor IS NOT NULL
    )
      THEN RAISE(ABORT, 'local locations cannot carry OneDrive metadata')
    WHEN NEW.provider = 'onedrive' AND (
      NULLIF(TRIM(NEW.account_id), '') IS NULL OR NULLIF(TRIM(NEW.drive_id), '') IS NULL
      OR NULLIF(TRIM(NEW.item_id), '') IS NULL OR NULLIF(TRIM(NEW.remote_path), '') IS NULL
      OR NEW.path <> 'onedrive://' || NEW.drive_id || '/' || NEW.item_id
    )
      THEN RAISE(ABORT, 'OneDrive locations require account, drive, item, remote path and stable URI')
    WHEN NEW.role = 'library' AND NEW.backup_source_folder_id IS NOT NULL
      THEN RAISE(ABORT, 'library locations cannot have a backup source')
    WHEN NEW.role = 'backup' AND (NEW.backup_source_folder_id IS NULL OR NEW.backup_source_folder_id = NEW.id)
      THEN RAISE(ABORT, 'backup locations require a different source library')
    WHEN NEW.role = 'backup' AND NOT EXISTS (
      SELECT 1 FROM folders AS source
      WHERE source.id = NEW.backup_source_folder_id AND source.role = 'library'
    )
      THEN RAISE(ABORT, 'backup source must be a library location')
    WHEN NEW.role = 'backup' AND EXISTS (SELECT 1 FROM tracks WHERE folder_id = NEW.id)
      THEN RAISE(ABORT, 'backup locations cannot contain catalog tracks')
    WHEN NEW.role = 'backup' AND EXISTS (
      SELECT 1 FROM folders AS child WHERE child.backup_source_folder_id = NEW.id
    )
      THEN RAISE(ABORT, 'a source with a linked backup cannot become a backup')
  END;
END;

CREATE TRIGGER IF NOT EXISTS prevent_tracks_in_backup_insert
BEFORE INSERT ON tracks
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM folders WHERE id = NEW.folder_id AND role = 'backup')
      THEN RAISE(ABORT, 'backup locations cannot contain catalog tracks')
    WHEN NEW.provider = 'local' AND (
      NEW.drive_id IS NOT NULL OR NEW.item_id IS NOT NULL OR NEW.etag IS NOT NULL
      OR NEW.remote_path IS NOT NULL OR NEW.quickxor_hash IS NOT NULL
    )
      THEN RAISE(ABORT, 'local tracks cannot carry OneDrive metadata')
    WHEN NEW.provider = 'onedrive' AND (
      NULLIF(TRIM(NEW.drive_id), '') IS NULL OR NULLIF(TRIM(NEW.item_id), '') IS NULL
      OR NULLIF(TRIM(NEW.remote_path), '') IS NULL
      OR NEW.path <> 'onedrive://' || NEW.drive_id || '/' || NEW.item_id
    )
      THEN RAISE(ABORT, 'OneDrive tracks require drive, item, remote path and stable URI')
    WHEN NOT EXISTS (
      SELECT 1 FROM folders
      WHERE id = NEW.folder_id AND role = 'library' AND provider = NEW.provider
    )
      THEN RAISE(ABORT, 'track provider must match its library location')
  END;
END;

CREATE TRIGGER IF NOT EXISTS prevent_tracks_in_backup_update
BEFORE UPDATE OF folder_id, provider, path, drive_id, item_id, etag, remote_path, quickxor_hash ON tracks
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM folders WHERE id = NEW.folder_id AND role = 'backup')
      THEN RAISE(ABORT, 'backup locations cannot contain catalog tracks')
    WHEN NEW.provider = 'local' AND (
      NEW.drive_id IS NOT NULL OR NEW.item_id IS NOT NULL OR NEW.etag IS NOT NULL
      OR NEW.remote_path IS NOT NULL OR NEW.quickxor_hash IS NOT NULL
    )
      THEN RAISE(ABORT, 'local tracks cannot carry OneDrive metadata')
    WHEN NEW.provider = 'onedrive' AND (
      NULLIF(TRIM(NEW.drive_id), '') IS NULL OR NULLIF(TRIM(NEW.item_id), '') IS NULL
      OR NULLIF(TRIM(NEW.remote_path), '') IS NULL
      OR NEW.path <> 'onedrive://' || NEW.drive_id || '/' || NEW.item_id
    )
      THEN RAISE(ABORT, 'OneDrive tracks require drive, item, remote path and stable URI')
    WHEN NOT EXISTS (
      SELECT 1 FROM folders
      WHERE id = NEW.folder_id AND role = 'library' AND provider = NEW.provider
    )
      THEN RAISE(ABORT, 'track provider must match its library location')
  END;
END;
