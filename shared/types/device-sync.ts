export type DeviceSyncMode = 'pc_to_device' | 'device_to_pc' | 'bidirectional_safe'

export type DeviceScanPhase = 'discovering' | 'reading' | 'complete'
export type DeviceSyncPhase =
  | 'copying'
  | 'deleting'
  | 'refreshing'
  | 'optimizing_artwork'
  | 'writing_state'
  | 'complete'

export type DeviceJournalStatus = 'running' | 'failed' | 'discarded' | 'completed'

export interface DeviceArtworkOptimizationSummary {
  scanned: number
  optimized: number
  skipped: number
  failed: number
  bytesSaved: number
}

export interface DeviceCandidate {
  rootPath: string
  name: string
  hasRockbox: boolean
  hasCrateState: boolean
}

export interface DeviceUnknownVolume {
  rootPath: string
  name: string
}

export interface DeviceVersionInfo {
  crateStateVersion: number | null
  machineStateVersion: number | null
  rockboxVersion: string | null
  firmwareVersion: string | null
}

export interface DevicePortableState {
  writable: boolean | null
  error: string | null
  lastCheckedAt: string | null
}

export interface DeviceRecord {
  id: string
  name: string
  rootPath: string
  musicRoot: string
  defaultMode: DeviceSyncMode
  pcTargetPath: string
  artworkMaxEdge: number
  hasRockbox: boolean
  isAvailable: boolean
  trackCount: number
  // Libraries (folders.id) this device syncs from. Empty = every library.
  sourceLibraryIds: number[]
  versions: DeviceVersionInfo
  portableState: DevicePortableState
  lastSeenAt: string
  lastScanAt: string | null
  lastSyncAt: string | null
}

export interface DeviceVolumeSnapshot {
  devices: DeviceRecord[]
  candidates: DeviceCandidate[]
  unknownVolumes: DeviceUnknownVolume[]
}

export interface DeviceMusicRootPickResult {
  canceled: boolean
  absolutePath: string | null
  musicRoot: string | null
}

export interface DeviceTrack {
  key: string
  relativePath: string
  absolutePath: string
  title: string
  artist: string
  album: string
  albumArtist: string | null
  duration: number
  format: string
  fileSize: number | null
  dateModified: string | null
  fingerprint: string
}

export interface PcTrack extends DeviceTrack {
  folderId: number
  folderName: string
  folderPath: string
  sourceRelativePath: string
}

export interface DeviceScanSummary {
  scanned: number
  imported: number
  skipped: number
  errors: number
}

export interface DeviceStorageSummary {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  musicBytes: number
  rockboxBytes: number
  otherBytes: number
  scannedAt: string
  error: string | null
}

export interface DeviceCapacitySummary {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  scannedAt: string
  error: string | null
}

export interface DeviceOverviewResult {
  device: DeviceRecord
  capacity: DeviceCapacitySummary
}

export interface DeviceScanResult {
  device: DeviceRecord
  tracks: DeviceTrack[]
  summary: DeviceScanSummary
  storage: DeviceStorageSummary
}

export interface DeviceAlbumSummary {
  id: string
  title: string
  artist: string
  trackCount: number
  duration: number
  fileSize: number
  tracks: DeviceTrack[]
}

export interface DeviceArtistSummary {
  id: string
  name: string
  albumCount: number
  trackCount: number
  duration: number
  fileSize: number
  tracks: DeviceTrack[]
}

export interface DevicePlaylistSummary {
  id: string
  name: string
  relativePath: string
  trackCount: number
  missingCount: number
  tracks: DeviceTrack[]
}

export interface RockboxThemeSummary {
  id: string
  name: string
  configPath: string
  wpsPath: string | null
  sbsPath: string | null
  fmsPath: string | null
  font: string | null
  backdropPath: string | null
  iconsetPath: string | null
  viewerIconsetPath: string | null
  fileCount: number
  missingFiles: string[]
  updatedAt: string | null
}

export type RockboxThemeScanStatus = 'ok' | 'no-rockbox' | 'no-themes-dir' | 'unreadable'

export interface RockboxThemeScanDiagnostic {
  status: RockboxThemeScanStatus
  message: string | null
  themesPath: string
  misplacedConfigPaths: string[]
}

export interface RockboxThemeLibraryResult {
  device: DeviceRecord
  themes: RockboxThemeSummary[]
  scan: RockboxThemeScanDiagnostic
}

export interface DeviceLibraryResult {
  device: DeviceRecord
  tracks: DeviceTrack[]
  albums: DeviceAlbumSummary[]
  artists: DeviceArtistSummary[]
  playlists: DevicePlaylistSummary[]
  rockboxThemes: RockboxThemeSummary[]
  rockboxThemeScan: RockboxThemeScanDiagnostic
  storage: DeviceStorageSummary
  summary: {
    trackCount: number
    albumCount: number
    artistCount: number
    playlistCount: number
    rockboxThemeCount: number
  }
}

export interface RockboxThemeInstallSourceResult {
  sourcePath: string
  status: 'installed' | 'skipped' | 'failed'
  themeNames: string[]
  filesCopied: number
  error: string | null
}

export interface RockboxThemeInstallResult {
  installed: number
  skipped: number
  failed: number
  sources: RockboxThemeInstallSourceResult[]
  themes: RockboxThemeSummary[]
  scan: RockboxThemeScanDiagnostic
}

export interface RockboxThemeDeleteFileResult {
  path: string
  status: 'deleted' | 'missing' | 'failed'
  error: string | null
}

export interface RockboxThemeDeleteResult {
  themeId: string
  deleted: number
  missing: number
  failed: number
  files: RockboxThemeDeleteFileResult[]
  themes: RockboxThemeSummary[]
  scan: RockboxThemeScanDiagnostic
}

export interface DeviceScanProgressEvent {
  deviceId: string
  scanned: number
  total: number
  phase: DeviceScanPhase
}

export interface DeviceConnectPayload {
  rootPath: string
  name?: string
  musicRoot?: string
  defaultMode?: DeviceSyncMode
  pcTargetPath?: string
  artworkMaxEdge?: number
  sourceLibraryIds?: number[]
}

export interface DeviceSettingsUpdate {
  artworkMaxEdge?: number
  musicRoot?: string
  sourceLibraryIds?: number[]
  defaultMode?: DeviceSyncMode
  pcTargetPath?: string
}

export type DeviceSyncActionKind =
  | 'copy_pc_to_device'
  | 'copy_device_to_pc'
  | 'replace_device'
  | 'replace_pc'
  | 'delete_device'
  | 'delete_pc'
  | 'skip_conflict'

export interface DeviceSyncAction {
  id: string
  kind: DeviceSyncActionKind
  key: string
  relativePath: string
  title: string
  artist: string
  album: string
  pcPath: string | null
  pcRelativePath: string | null
  pcBytes: number | null
  devicePath: string | null
  deviceRelativePath: string | null
  deviceBytes: number | null
  sourcePath: string | null
  destinationPath: string | null
  bytes: number
  reason: string
}

export interface DeviceSyncConflictResolution {
  actionId: string
  kind: DeviceSyncActionKind
}

export interface DeviceSyncApplySelection {
  actionIds?: string[]
  conflictResolutions?: DeviceSyncConflictResolution[]
}

export interface DeviceSyncPlanRequest {
  deviceId: string
  mode: DeviceSyncMode
  pcTargetPath?: string
}

export interface DeviceSyncPlanSummary {
  pcBefore: number
  deviceBefore: number
  pcAfter: number
  deviceAfter: number
  copyPcToDevice: number
  copyDeviceToPc: number
  replaceDevice: number
  replacePc: number
  deleteDevice: number
  deletePc: number
  conflicts: number
  bytesToCopy: number
}

export interface DeviceSyncPlan {
  id: string
  deviceId: string
  deviceName: string
  mode: DeviceSyncMode
  createdAt: string
  pcTargetPath: string
  actions: DeviceSyncAction[]
  summary: DeviceSyncPlanSummary
}

export interface DeviceSyncProgressEvent {
  deviceId: string
  planId: string
  phase: DeviceSyncPhase
  completed: number
  total: number
  currentPath?: string
}

export interface DeviceSyncFailure {
  actionId: string
  path: string
  error: string
}

export interface DeviceSyncApplyResult {
  planId: string
  deviceId: string
  applied: number
  failed: DeviceSyncFailure[]
  summary: DeviceSyncPlanSummary
  artwork: DeviceArtworkOptimizationSummary
  completedAt: string
}

export interface DevicePendingJournal {
  id: string
  deviceId: string
  deviceName: string
  deviceRoot: string
  planId: string
  mode: DeviceSyncMode
  status: DeviceJournalStatus
  phase: DeviceSyncPhase | null
  startedAt: string
  updatedAt: string
  totalActions: number
  completedActions: number
  failedActions: number
  currentPath: string | null
  artwork: DeviceArtworkOptimizationSummary
}
