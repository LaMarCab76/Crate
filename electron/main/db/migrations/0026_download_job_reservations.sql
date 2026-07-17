-- Keep at most one live reservation for a provider track, quality and target
-- library. Older databases may already contain duplicates, so retire all but
-- the oldest reservation before installing the invariant.
UPDATE download_jobs AS duplicate
SET status = 'cancelled',
    error = 'Superseded by an existing active download reservation.',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE duplicate.status IN (
  'queued', 'authenticating', 'resolving', 'downloading',
  'verifying', 'tagging', 'importing'
)
AND EXISTS (
  SELECT 1
  FROM download_jobs AS keeper
  WHERE keeper.provider = duplicate.provider
    AND keeper.provider_track_id = duplicate.provider_track_id
    AND keeper.quality = duplicate.quality
    AND IFNULL(keeper.folder_id, -1) = IFNULL(duplicate.folder_id, -1)
    AND keeper.status IN (
      'queued', 'authenticating', 'resolving', 'downloading',
      'verifying', 'tagging', 'importing'
    )
    AND (
      keeper.created_at < duplicate.created_at
      OR (keeper.created_at = duplicate.created_at AND keeper.id < duplicate.id)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_download_jobs_active_reservation
ON download_jobs (
  provider,
  provider_track_id,
  quality,
  IFNULL(folder_id, -1)
)
WHERE status IN (
  'queued', 'authenticating', 'resolving', 'downloading',
  'verifying', 'tagging', 'importing'
);
