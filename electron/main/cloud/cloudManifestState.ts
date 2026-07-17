import { isDeepStrictEqual } from 'node:util'
import type { BackupFile } from '@shared/types/library-backup'

/** `updatedAt` is transport metadata, not portable library state. Comparing the
 * semantic payload avoids rewriting an unchanged manifest on every cloud poll. */
export function samePortableLibraryState(left: BackupFile, right: BackupFile): boolean {
  return isDeepStrictEqual(
    {
      version: left.version,
      appName: left.appName,
      createdAt: left.createdAt,
      tracks: left.tracks,
      artists: left.artists,
      albums: left.albums,
    },
    {
      version: right.version,
      appName: right.appName,
      createdAt: right.createdAt,
      tracks: right.tracks,
      artists: right.artists,
      albums: right.albums,
    },
  )
}
