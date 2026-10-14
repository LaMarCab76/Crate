// Cleanup of folders left without playable files after deleting tracks, plus
// the 15-day purge of the device trash. Shared by main (detection, deletion)
// and renderer (activity center notifications and confirmations).

export type FolderCleanupScope = 'library' | 'device'

export type FolderCleanupOrigin =
  | 'track-trash'
  | 'device-sync'
  | 'duplicates'
  | 'album-move'
  | 'folder-cleanup'

export interface FolderCleanupProposalFolder {
  /** POSIX path relative to the library root or device music root. */
  relativePath: string
  /** POSIX paths relative to `relativePath`. */
  images: string[]
  playlists: string[]
  lyrics: string[]
  /** Non-playable files that do not require confirmation (logs, text, …). */
  otherCount: number
}

/**
 * Folders without playable files that still hold images, playlists or lyrics.
 * They are only deleted after the user confirms from the activity center.
 */
export interface FolderCleanupProposal {
  id: string
  scope: FolderCleanupScope
  origin: FolderCleanupOrigin
  /** Library name or device name, for display. */
  rootLabel: string
  folderId: number | null
  deviceId: string | null
  folders: FolderCleanupProposalFolder[]
  createdAt: string
}

export type FolderCleanupResolution = 'deleted' | 'kept' | 'partial' | 'expired'

export type FolderCleanupEvent =
  | {
      kind: 'removed'
      id: string
      scope: FolderCleanupScope
      origin: FolderCleanupOrigin
      rootLabel: string
      deviceId: string | null
      folderId: number | null
      /** Top-most removed folders, POSIX relative to the root. */
      folders: string[]
    }
  | { kind: 'proposed'; proposal: FolderCleanupProposal }
  | {
      kind: 'resolved'
      proposalId: string
      scope: FolderCleanupScope
      resolution: FolderCleanupResolution
      message: string
    }
  | {
      kind: 'device-trash-purged'
      id: string
      deviceId: string
      deviceName: string
      files: number
      bytes: number
      retentionDays: number
    }

export interface FolderCleanupConfirmResult {
  proposalId: string
  resolution: FolderCleanupResolution
  /** Removed folders (including parents that became empty), POSIX relative. */
  removed: string[]
  /** Folders kept because they changed since the proposal. */
  kept: Array<{ relativePath: string; reason: string }>
  message: string
}
