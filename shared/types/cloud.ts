export type {
  BackupPlanSummary,
  BackupProgressEvent,
  BackupRunStatus,
  LibraryLocation,
  LibraryProvider,
  LibraryRole,
} from './library-locations'

export type CloudProvider = 'onedrive'

export interface CloudAccountStatus {
  provider: CloudProvider
  connected: boolean
  displayName: string | null
  email: string | null
  clientIdConfigured: boolean
}

export type CloudMoveDisposition = 'trash' | 'keep' | 'delete' | 'ask'

export interface CloudPrefs {
  moveDisposition: CloudMoveDisposition
}

export interface RemoteFolderEntry {
  driveId: string
  itemId: string
  name: string
  remotePath: string
  childCount: number
}

export interface CloudFolderRef {
  folderId: number
  driveId: string
  itemId: string
  name: string
}

export interface ListRemoteFoldersRequest {
  driveId?: string | null
  parentItemId?: string | null
}

export interface AddCloudFolderRequest {
  driveId: string
  itemId: string
  name?: string
  remotePath?: string
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

export interface MoveToCloudRequest {
  trackId: number
  targetFolderId: number
  disposition?: CloudMoveDisposition
}
