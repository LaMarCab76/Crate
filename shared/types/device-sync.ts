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

export interface DeviceScanResult {
  device: DeviceRecord
  tracks: DeviceTrack[]
  summary: DeviceScanSummary
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
  updatedAt: string | null
}

export interface DeviceLibraryResult {
  device: DeviceRecord
  tracks: DeviceTrack[]
  albums: DeviceAlbumSummary[]
  artists: DeviceArtistSummary[]
  playlists: DevicePlaylistSummary[]
  rockboxThemes: RockboxThemeSummary[]
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
}

export interface DeviceSettingsUpdate {
  artworkMaxEdge?: number
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
  sourcePath: string | null
  destinationPath: string | null
  bytes: number
  reason: string
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
