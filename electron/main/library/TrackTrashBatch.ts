import { resolve } from 'node:path'
import type { DbTrack } from '@shared/types/db'
import type { TrashTracksResult } from '@shared/types/ipc-contract'

type TrashTrack = Pick<DbTrack, 'id' | 'title' | 'path' | 'folder_id' | 'provider'>

export interface TrackTrashBatchDependencies {
  getTrack(trackId: number): TrashTrack | undefined
  getLocalRoot(folderId: number): string | null
  runWithWriteAccess(rootPath: string, operation: () => Promise<void>): Promise<void>
  trashItem(path: string): Promise<void>
  deleteTrack(trackId: number): void
  sidecarPath(path: string): string
  sidecarExists(path: string): boolean
  onSidecarError(path: string, error: unknown): void
}

export interface TrackTrashBatchResult extends TrashTracksResult {
  affectedFolderIds: number[]
}

export async function trashTrackBatch(
  trackIds: readonly number[],
  deps: TrackTrashBatchDependencies,
): Promise<TrackTrashBatchResult> {
  const uniqueIds = [...new Set(trackIds.filter(id => Number.isInteger(id) && id > 0))]
  const trashedTrackIds: number[] = []
  const failed: TrashTracksResult['failed'] = []
  const affectedFolderIds = new Set<number>()

  for (const trackId of uniqueIds) {
    const track = deps.getTrack(trackId)
    if (!track) {
      failed.push({
        id: trackId,
        title: `Track ${trackId}`,
        path: '',
        error: 'Track no longer exists in the library.',
      })
      continue
    }

    try {
      if (track.provider !== 'local') {
        throw new Error('Cloud tracks cannot be moved to the local Trash')
      }
      const rootPath = deps.getLocalRoot(track.folder_id)
      if (!rootPath) throw new Error('La biblioteca local ya no existe.')
      const audioPath = resolve(track.path)
      await deps.runWithWriteAccess(rootPath, () => deps.trashItem(audioPath))

      // The catalog row is deleted only after macOS confirms that the audio
      // file reached the Trash. A denied or partially failed batch therefore
      // keeps every unprocessed item in both the filesystem and the catalog.
      deps.deleteTrack(track.id)
      trashedTrackIds.push(track.id)
      affectedFolderIds.add(track.folder_id)

      const lrcPath = deps.sidecarPath(audioPath)
      if (deps.sidecarExists(lrcPath)) {
        try {
          await deps.trashItem(lrcPath)
        } catch (error) {
          deps.onSidecarError(lrcPath, error)
        }
      }
    } catch (error) {
      failed.push({
        id: track.id,
        title: track.title,
        path: track.path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { trashedTrackIds, failed, affectedFolderIds: [...affectedFolderIds] }
}
