// Shared types for OneDrive cloud streaming. Mirrors the domain-types-in-a-file
// + Api-interface-in-ipc-contract split used by the downloads feature.

export type CloudProvider = 'onedrive'

export interface CloudAccountStatus {
  provider: CloudProvider
  connected: boolean
  displayName: string | null
  email: string | null
  // False until a clientId (Azure app registration) is configured. The UI uses
  // this to prompt the user to paste/embed one before the Connect button works.
  clientIdConfigured: boolean
}

// What happens to the local original file after a successful move to OneDrive.
export type CloudMoveDisposition = 'trash' | 'keep' | 'delete' | 'ask'

export interface CloudPrefs {
  moveDisposition: CloudMoveDisposition
}

// One entry when browsing a OneDrive drive to pick a folder to index.
export interface RemoteFolderEntry {
  driveId: string
  itemId: string
  name: string
  remotePath: string // human-readable path inside the drive (e.g. "/Music/FLAC")
  childCount: number
}

export interface CloudFolderRef {
  folderId: number // local folders.id
  driveId: string
  itemId: string
  name: string
}

export interface CloudSyncProgressEvent {
  folderId: number
  phase: 'enumerating' | 'indexing' | 'done' | 'error'
  scanned: number
  imported: number
  total: number | null
  message?: string
}

export interface CloudMoveProgressEvent {
  trackId: number
  phase: 'reading' | 'uploading' | 'finalizing' | 'done' | 'error'
  uploaded: number
  total: number
  message?: string
}

// Per-track state persisted into the in-folder manifest so another machine /
// reinstall can restore favorites, play counts and ratings after re-indexing.
export interface CloudManifestTrackState {
  cloudItemId: string
  isFavorite: boolean
  playCount: number
  rating: number | null
  lastPlayedDate: string | null
}

export interface CloudManifest {
  version: 1
  generatedAtIso: string
  driveId: string
  folderItemId: string
  tracks: CloudManifestTrackState[]
}

export interface MoveToCloudRequest {
  trackId: number
  targetFolderId: number
  // Overrides the stored moveDisposition for this one move (used when the stored
  // preference is 'ask' and the UI prompted the user in the moment).
  disposition?: CloudMoveDisposition
}
