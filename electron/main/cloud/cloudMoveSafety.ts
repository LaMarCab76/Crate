import type { DbFolder, DbTrack } from '@shared/types/db'

type TrackAuthority = Pick<DbTrack, 'id' | 'path' | 'folder_id' | 'provider'>
type FolderAuthority = Pick<
  DbFolder,
  'id' | 'provider' | 'role' | 'drive_id' | 'item_id'
>

/** Rechecks every mutable identity involved in a local -> OneDrive move. This
 * runs after the upload and immediately before the guarded SQL UPDATE. */
export function assertCloudMoveAuthority(options: {
  originalTrack: TrackAuthority
  currentTrack: TrackAuthority | null | undefined
  currentSource: FolderAuthority | null | undefined
  originalTarget: FolderAuthority
  currentTarget: FolderAuthority | null | undefined
}): asserts options is typeof options & {
  currentTrack: TrackAuthority
  currentSource: FolderAuthority
  currentTarget: FolderAuthority
} {
  const { originalTrack, currentTrack, currentSource, originalTarget, currentTarget } = options
  if (
    !currentTrack ||
    currentTrack.id !== originalTrack.id ||
    currentTrack.provider !== 'local' ||
    currentTrack.folder_id !== originalTrack.folder_id ||
    currentTrack.path !== originalTrack.path
  ) throw new Error('The local track changed while it was being uploaded.')
  if (
    !currentSource ||
    currentSource.id !== originalTrack.folder_id ||
    currentSource.provider !== 'local' ||
    currentSource.role !== 'library'
  ) throw new Error('The source is no longer a normal local library.')
  if (
    !currentTarget ||
    currentTarget.id !== originalTarget.id ||
    currentTarget.provider !== 'onedrive' ||
    currentTarget.role !== 'library' ||
    !currentTarget.drive_id ||
    !currentTarget.item_id ||
    currentTarget.drive_id !== originalTarget.drive_id ||
    currentTarget.item_id !== originalTarget.item_id
  ) throw new Error('The OneDrive destination changed or became a backup during upload.')
}
