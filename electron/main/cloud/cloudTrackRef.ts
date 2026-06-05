import type { OneDriveClient } from './OneDriveClient'
import type { DbTrack } from '@shared/types/db'

export interface CloudTrackRef {
  driveId: string
  itemId: string
}

// Resolve a track's OneDrive reference from its DB row, or null when the row is
// not a cloud-backed track. Pure/synchronous so it can be unit-tested with a
// plain object. Mirrors the guard used by the audio load path.
export function resolveCloudTrackRef(track: DbTrack): CloudTrackRef | null {
  if (track.source !== 'onedrive' || !track.cloud_drive_id || !track.cloud_item_id) return null
  return { driveId: track.cloud_drive_id, itemId: track.cloud_item_id }
}

// Resolve the cloud reference plus the byte size needed to preallocate a download
// buffer. Falls back to a Graph metadata lookup when the row has no usable
// file_size. The client is passed in (not imported) so this module stays free of
// electron/native value imports and remains unit-testable.
export async function resolveCloudLoadOptions(
  track: DbTrack,
  client: OneDriveClient,
): Promise<{ cloudRef: CloudTrackRef; cloudSizeBytes: number } | null> {
  const cloudRef = resolveCloudTrackRef(track)
  if (!cloudRef) return null
  let cloudSizeBytes = track.file_size ?? 0
  if (!cloudSizeBytes || cloudSizeBytes <= 0) {
    const info = await client.getDownloadUrl(cloudRef.driveId, cloudRef.itemId)
    cloudSizeBytes = info.size
  }
  return { cloudRef, cloudSizeBytes }
}
