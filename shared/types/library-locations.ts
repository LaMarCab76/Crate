export type LibraryProvider = 'local' | 'onedrive'

export type LibraryRole = 'library' | 'backup'

export type DesktopPlatform = 'macos' | 'windows' | 'linux'

export type LocalAccessState =
  | 'ready'
  | 'permission_required'
  | 'unavailable'
  | 'read_only'

export interface LocalAccessStatus {
  state: LocalAccessState
  canRead: boolean
  canWrite: boolean
  detail: string | null
}

export interface LocalAccessRequestResult {
  canceled: boolean
  status: LocalAccessStatus
}

export interface LibraryLocation {
  id: number
  name: string
  path: string
  provider: LibraryProvider
  role: LibraryRole
  backupSourceFolderId: number | null
  trackCount: number
  accountId: string | null
  driveId: string | null
  itemId: string | null
  remotePath: string | null
  deltaCursor: string | null
  displayIcon: string | null
  dateAdded: string
  dateUpdated: string
  localAccess: LocalAccessStatus | null
}

export type LibraryMigrationMode = 'relocate' | 'merge'
export type LibraryMigrationSourceDisposition = 'keep' | 'trash'
export type LibraryMigrationStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'transferring'
  | 'publishing'
  | 'committing'
  | 'cleanup_pending'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type LibraryMigrationTarget =
  | { kind: 'new-local'; token: string }
  | {
      kind: 'new-onedrive'
      driveId: string
      itemId: string
      name: string
      remotePath?: string
    }
  | { kind: 'existing-library'; folderId: number }

export type UnifiedBackupChoice =
  | { kind: 'none' }
  | { kind: 'existing'; folderId: number }
  | { kind: 'new-local'; token: string }
  | {
      kind: 'new-onedrive'
      driveId: string
      itemId: string
      name: string
      remotePath?: string
    }

export interface CreateLibraryMigrationRequest {
  sourceFolderId: number
  mode: LibraryMigrationMode
  target: LibraryMigrationTarget
  sourceDisposition: LibraryMigrationSourceDisposition
  unifiedBackup?: UnifiedBackupChoice
  targetDisplayName?: string
}

export interface LibraryMigrationConflict {
  sourcePath: string
  destinationPath: string
  resolution: 'rename' | 'deduplicate'
}

export interface LibraryMigrationPlanSummary {
  runId: string
  sourceFolderId: number
  targetFolderId: number | null
  mode: LibraryMigrationMode
  status: LibraryMigrationStatus
  filesToTransfer: number
  directoriesToCreate: number
  identicalFiles: number
  renamedFiles: number
  bytesToTransfer: number
  warnings: string[]
  conflicts: LibraryMigrationConflict[]
}

export interface LibraryMigrationState extends LibraryMigrationPlanSummary {
  sourceRole: LibraryRole
  targetProvider: LibraryProvider
  targetName: string
  targetPath: string
  sourceDisposition: LibraryMigrationSourceDisposition
  phase: string
  completedActions: number
  totalActions: number
  completedBytes: number
  totalBytes: number
  relativePath: string | null
  error: string | null
  cleanupError: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface LibraryMigrationProgressEvent {
  runId: string
  sourceFolderId: number
  targetFolderId: number | null
  status: LibraryMigrationStatus
  phase: string
  completedActions: number
  totalActions: number
  completedBytes: number
  totalBytes: number
  relativePath?: string
  message?: string
}

export type SourceIdentityMode = 'location' | 'provider' | 'both'
export type SourceBadgePresentation = 'icon' | 'name' | 'both'

export interface SourceProviderPresentation {
  name: string
  icon: string
}

export interface SourceDisplayPreferences {
  identity: SourceIdentityMode
  locationPresentation: SourceBadgePresentation
  providerPresentation: SourceBadgePresentation
  providers: Record<LibraryProvider, SourceProviderPresentation>
}

export type BackupRunStatus =
  | 'pending'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type BackupTrigger = 'link' | 'startup' | 'source_change' | 'cloud_delta' | 'manual' | 'resume'

export interface BackupPlanSummary {
  runId: string
  sourceFolderId: number
  backupFolderId: number
  status: BackupRunStatus
  filesToCopy: number
  directoriesToCreate: number
  filesToDelete: number
  directoriesToDelete: number
  bytesToCopy: number
  divergenceCount: number
  skippedSymlinks: string[]
  warnings: string[]
}

export type BackupProgressPhase =
  | 'planning'
  | 'awaiting_approval'
  | 'creating_directories'
  | 'copying'
  | 'deleting'
  | 'verifying'
  | 'paused'
  | 'done'
  | 'error'

export interface BackupProgressEvent {
  runId: string
  sourceFolderId: number
  backupFolderId: number
  status: BackupRunStatus
  phase: BackupProgressPhase
  completedActions: number
  totalActions: number
  completedBytes: number
  totalBytes: number
  relativePath?: string
  message?: string
}
