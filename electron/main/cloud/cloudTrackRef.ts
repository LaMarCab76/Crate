import type { DbTrack } from '@shared/types/db'
import type { OneDriveClient } from './OneDriveClient'

export interface CloudTrackRef {
  driveId: string
  itemId: string
}

type CloudTrackFields = Pick<DbTrack, 'provider' | 'drive_id' | 'item_id' | 'file_size'>
type DownloadInfoClient = Pick<OneDriveClient, 'getDownloadUrl'>

export function resolveCloudTrackRef(track: CloudTrackFields): CloudTrackRef | null {
  if (track.provider !== 'onedrive' || !track.drive_id || !track.item_id) return null
  return { driveId: track.drive_id, itemId: track.item_id }
}

export async function resolveCloudLoadOptions(
  track: CloudTrackFields,
  client: DownloadInfoClient,
): Promise<{ cloudRef: CloudTrackRef; cloudSizeBytes: number } | null> {
  const cloudRef = resolveCloudTrackRef(track)
  if (!cloudRef) return null

  let cloudSizeBytes = track.file_size ?? 0
  if (!Number.isSafeInteger(cloudSizeBytes) || cloudSizeBytes <= 0) {
    cloudSizeBytes = (await client.getDownloadUrl(cloudRef.driveId, cloudRef.itemId)).size
  }
  if (!Number.isSafeInteger(cloudSizeBytes) || cloudSizeBytes < 0) {
    throw new Error(`OneDrive returned an invalid file size: ${cloudSizeBytes}`)
  }
  return { cloudRef, cloudSizeBytes }
}
