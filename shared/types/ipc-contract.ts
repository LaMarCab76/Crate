// IPC contract between main and renderer. Mirrors the handlers registered in
// electron/main/ipc/library-channel.ts and the bridge in electron/preload/index.ts.

import type { DbAlbum, DbArtist, DbFolder, DbGenre, DbPlaylist, DbTrack } from './db'
import type {
  FolderCleanupConfirmResult,
  FolderCleanupEvent,
  FolderCleanupProposal,
} from './folder-cleanup'
import type {
  LyricsCandidate,
  LyricsLibraryOverview,
  LyricsLibraryProgress,
  LyricsSelectionProgress,
  LyricsSelectionSummary,
  LyricsSettingsState,
  LyricsView,
} from './lyrics'
import type {
  DeviceCandidate,
  DeviceArtworkAnalysisProgressEvent,
  DeviceArtworkAnalysisResult,
  DeviceArtworkOptimizationSelection,
  DeviceArtworkOptimizationSummary,
  DeviceConnectPayload,
  DeviceLibraryOptions,
  DeviceLibraryResult,
  DeviceMusicRootPickResult,
  DeviceRootReference,
  DeviceOverviewResult,
  DevicePendingJournal,
  DeviceRecord,
  DeviceScanProgressEvent,
  DeviceScanResult,
  DeviceSettingsUpdate,
  DeviceSyncApplySelection,
  DeviceSyncApplyResult,
  DeviceSyncPlan,
  DeviceSyncPlanRequest,
  DeviceSyncProgressEvent,
  DeviceVolumeSnapshot,
  RockboxThemeDeleteResult,
  RockboxThemeInstallResult,
  RockboxThemeLibraryResult,
} from './device-sync'
import type {
  DownloadJob,
  DownloadJobsChangedEvent,
  DownloadProvider,
  DownloadProgressEvent,
  DownloadSearchRequest,
  DownloadSettings,
  EnqueueDownloadRequest,
  HarImportPreview,
  OnlineTrackResult,
  ProviderAuthState,
  ProviderCredentialsPayload,
  ServiceTutorialState,
} from './downloads'
import type {
  CloudAccountStatus,
  CloudFolderRef,
  CloudMoveProgressEvent,
  CloudPrefs,
  CloudSyncProgressEvent,
  MoveToCloudRequest,
  RemoteFolderEntry,
} from './cloud'
import type {
  BackupPlanSummary,
  BackupProgressEvent,
  BackupProgressPhase,
  BackupRunStatus,
  CreateLibraryMigrationRequest,
  DesktopPlatform,
  LibraryMigrationProgressEvent,
  LibraryMigrationState,
  LibraryLocation,
  LibraryRole,
  LocalAccessRequestResult,
} from './library-locations'
import type {
  DuplicateAnalysisProgress,
  DuplicateAuditionCompareSegmentRequest,
  DuplicateAuditionOpenRequest,
  DuplicateAuditionSeekRequest,
  DuplicateAuditionSide,
  DuplicateAuditionState,
  DuplicateCandidateDetail,
  DuplicateCandidateSummary,
  DuplicateListRequest,
  DuplicateResolutionRequest,
  DuplicateResolutionResult,
  DuplicateSummary,
} from './duplicates'

export interface ListTracksOpts {
  limit?: number
  offset?: number
  orderBy?: 'date_added_desc' | 'date_added_asc' | 'title' | 'artist' | 'play_count_desc'
}

export interface SearchResultsPayload {
  tracks: DbTrack[]
  albums: DbAlbum[]
  artists: DbArtist[]
}

export interface AddFolderResult {
  folder: DbFolder
  startedScan: boolean
}

export interface RemoveFolderOptions {
  deleteMusic?: boolean
}

export interface PickFolderResult {
  canceled: boolean
  token: string | null
  displayPath: string | null
}

export interface ImportProgressEvent {
  folderId: number
  scanned: number
  imported: number
  total: number
  phase: 'discovering' | 'scanning' | 'writing'
  /** Present for reconciler scans so the renderer can keep background passes quiet. */
  scanReason?: LibraryScanReason
}

export interface ImportCompleteEvent {
  folderId: number
  totalImported: number
  total: number
  /** Present for reconciler scans so the renderer can keep background passes quiet. */
  scanReason?: LibraryScanReason
}

export type LibraryScanReason = 'startup' | 'watch' | 'background' | 'manual' | 'import'
export type LibraryScanStatus = 'running' | 'completed' | 'failed'
export type LibraryScanEventType = 'added' | 'updated' | 'removed' | 'missing_root' | 'root_unavailable' | 'skipped' | 'error' | 'orphan_lrc_removed'

export interface LibraryScanRun {
  id: number
  folderId: number
  reason: LibraryScanReason
  status: LibraryScanStatus
  startedAt: number
  finishedAt: number | null
  added: number
  updated: number
  removed: number
  skipped: number
  error: string | null
}

export interface LibraryScanEvent {
  id: number
  runId: number
  folderId: number
  type: LibraryScanEventType
  path: string | null
  title: string | null
  detail: string | null
  occurredAt: number
}

export interface LibraryScanLogPayload {
  folders: DbFolder[]
  runs: LibraryScanRun[]
  events: LibraryScanEvent[]
}

export interface QueueSnapshotPayload {
  trackIds: number[]
  currentIndex: number
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
}

export interface TrackMetadataUpdatePayload {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string | null
  composer?: string
  genre?: string
  year?: string
  trackNumber?: number | null
  totalTracks?: number | null
  discNumber?: number | null
  totalDiscs?: number | null
}

export type MetadataCompletionField =
  | 'title'
  | 'artist'
  | 'album'
  | 'albumArtist'
  | 'composer'
  | 'genre'
  | 'year'
  | 'trackNumber'
  | 'totalTracks'
  | 'discNumber'
  | 'totalDiscs'
  | 'artwork'

export type MetadataCompletionSource =
  | 'filename'
  | 'folder'
  | 'musicbrainz'
  | 'cover-art-archive'

export interface MetadataCompletionTarget {
  trackId: number
  title: string
  artist: string
  album: string
  path: string
  missingFields: MetadataCompletionField[]
}

export interface MetadataCompletionTargetsPayload {
  folderId: number | null
  totalCandidates: number
  targets: MetadataCompletionTarget[]
}

export interface MetadataCompletionFieldDiff {
  field: MetadataCompletionField
  current: string | null
  proposed: string | null
  source: MetadataCompletionSource
  confidence: number
  selected: boolean
}

export interface MetadataCompletionArtworkDiff {
  currentArtworkPath: string | null
  proposedDataUrl: string
  mimeType: string
  source: MetadataCompletionSource
  confidence: number
  selected: boolean
}

export interface MetadataCompletionCandidate {
  trackId: number
  title: string
  artist: string
  album: string
  path: string
  confidence: number
  fields: MetadataCompletionFieldDiff[]
  artwork: MetadataCompletionArtworkDiff | null
  warnings: string[]
}

export interface MetadataCompletionPreview {
  previewId: string
  createdAt: number
  candidates: MetadataCompletionCandidate[]
}

export interface MetadataCompletionSelection {
  trackId: number
  fields: MetadataCompletionField[]
}

export interface MetadataCompletionApplyRequest {
  previewId: string
  selections: MetadataCompletionSelection[]
}

export interface MetadataCompletionApplyTrackResult {
  trackId: number
  title: string
  path: string
  ok: boolean
  appliedFields: MetadataCompletionField[]
  backupPath: string | null
  error: string | null
}

export interface MetadataCompletionApplyResult {
  applied: number
  failed: number
  results: MetadataCompletionApplyTrackResult[]
}

export interface TrackAlbumMoveEndpoint {
  id: number
  title: string
  artist: string
  album: string
  albumArtist: string | null
  year: string
  path: string
  artworkPath: string | null
}

export interface TrackAlbumMoveProposal {
  title: string
  artist: string
  album: string
  albumArtist: string | null
  genre: string
  year: string
  trackNumber: number
  totalTracks: number | null
  discNumber: number | null
  totalDiscs: number | null
  filename: string
  destinationPath: string
  destinationDirectory: string
  artworkPath: string
  musicBrainzConfidence: number
}

export interface TrackAlbumMoveDuplicate {
  trackId: number
  title: string
  path: string
  reason: 'slot' | 'title'
}

export interface TrackAlbumMoveQuality {
  format: string
  lossless: boolean
  sampleRate: number | null
  bitDepth: number | null
}

// One row in the destination album's track-number layout, used to render the
// slot picker. `occupiedBy` is null for a free slot.
export interface TrackAlbumMoveSlot {
  trackNumber: number
  occupiedBy: { trackId: number; title: string; quality: TrackAlbumMoveQuality } | null
  // Title from the album's official MusicBrainz tracklist, when known. Lets a
  // brand-new album show its real tracklist even though no slot is occupied.
  officialTitle: string | null
}

// Present when the chosen slot (or a same-title track) is already taken. The
// move only proceeds when `incomingIsBetter` is true, in which case the existing
// track is sent to the trash and replaced.
export interface TrackAlbumMoveReplacement {
  trackId: number
  title: string
  path: string
  incoming: TrackAlbumMoveQuality
  existing: TrackAlbumMoveQuality
  incomingIsBetter: boolean
}

// How the destination track number was decided, from most to least certain. The
// UI uses it to be honest about confidence (e.g. warn loudly on 'append').
export type TrackAlbumMovePlacementSource =
  | 'override'
  | 'musicbrainz'
  | 'tracklist'
  | 'titleTwin'
  | 'gap'
  | 'append'

export interface TrackAlbumMovePreview {
  previewId: string
  createdAt: number
  status: 'ready' | 'blocked'
  source: TrackAlbumMoveEndpoint
  targetAlbum: {
    // null while the album doesn't exist yet: it's created on apply.
    id: number | null
    isNew: boolean
    title: string
    artist: string
    year: string | null
    artworkPath: string | null
    trackCount: number
    // MusicBrainz release the new album is built from, when there is one.
    releaseId: string | null
    releaseType: string | null
  }
  proposal: TrackAlbumMoveProposal | null
  duplicate: TrackAlbumMoveDuplicate | null
  // Track-number layout of the destination album/disc for the slot picker.
  slots: TrackAlbumMoveSlot[]
  discNumber: number
  totalTracks: number | null
  // The slot the proposal currently targets, and the recommended free slot.
  selectedTrackNumber: number | null
  suggestedTrackNumber: number | null
  // False when MusicBrainz found the album but not the track number (we then
  // recommend a slot instead of blocking).
  trackNumberFromMusicBrainz: boolean
  // How the selected track number was chosen, plus convenience flags derived
  // from it for the UI's honesty banner.
  placementSource: TrackAlbumMovePlacementSource
  isEstimated: boolean
  isAppend: boolean
  replacement: TrackAlbumMoveReplacement | null
  errors: string[]
  warnings: string[]
}

// User-typed album for when MusicBrainz doesn't know the original album.
export interface TrackAlbumMoveManualAlbum {
  title: string
  albumArtist: string
  year: string | null
  totalTracks: number | null
  discNumber: number | null
  totalDiscs: number | null
}

// Where a track moves to: an album already in the library, a MusicBrainz
// release that isn't in the library yet (typically the original album of a song
// downloaded from a compilation), or a manually described new album.
export type TrackAlbumMoveTarget =
  | { kind: 'library'; albumId: number }
  | { kind: 'release'; releaseId: string; recordingId?: string | null }
  | { kind: 'manual'; album: TrackAlbumMoveManualAlbum }

export interface TrackAlbumMovePreviewRequest {
  trackId: number
  target: TrackAlbumMoveTarget
  // Optional user-chosen destination slot. Overrides the MusicBrainz/recommended
  // track number when provided.
  trackNumber?: number | null
}

// One MusicBrainz release group the song appears on, ranked so the artist's
// own studio album comes first and compilations last.
export interface OriginalAlbumCandidate {
  releaseId: string
  releaseGroupId: string | null
  recordingId: string | null
  title: string
  artist: string
  year: string | null
  country: string | null
  status: string | null
  primaryType: string | null
  secondaryTypes: string[]
  trackNumber: number | null
  discNumber: number | null
  totalTracks: number | null
  confidence: number
  // The album already in the library that IS this release, if any.
  localAlbumId: number | null
  localTrackCount: number
  // The track already belongs to that library album.
  isCurrentAlbum: boolean
}

export interface OriginalAlbumCandidatesResult {
  trackId: number
  // The track currently sits in a compilation (flag or "Various Artists").
  sourceIsCompilation: boolean
  candidates: OriginalAlbumCandidate[]
  warnings: string[]
}

export interface TrackAlbumMoveApplyRequest {
  previewId: string
  // Explicit user confirmation to trash an existing same-title track whose
  // quality is equal or better than the incoming file. Without it the apply is
  // refused for an equal/lower-quality replacement.
  confirmLowerQualityReplace?: boolean
}

export interface TrackAlbumMoveApplyResult {
  trackId: number
  previousPath: string
  path: string
  title: string
  artist: string
  album: string
}

export interface TrashTrackFailure {
  id: number
  title: string
  path: string
  error: string
}

export interface TrashTracksResult {
  trashedTrackIds: number[]
  failed: TrashTrackFailure[]
}

export type EventOff = () => void

export interface LibraryApi {
  tracks(opts?: ListTracksOpts): Promise<DbTrack[]>
  trackById(id: number): Promise<DbTrack | null>
  trackCount(): Promise<number>
  albums(): Promise<DbAlbum[]>
  albumById(id: number): Promise<DbAlbum | null>
  albumTracks(id: number): Promise<DbTrack[]>
  artists(): Promise<DbArtist[]>
  artistById(id: number): Promise<DbArtist | null>
  artistTracks(id: number): Promise<DbTrack[]>
  genres(): Promise<DbGenre[]>
  genreTracks(id: number): Promise<DbTrack[]>
  playlists(): Promise<DbPlaylist[]>
  playlistById(id: number): Promise<DbPlaylist | null>
  playlistTracks(id: number): Promise<DbTrack[]>
  createPlaylist(name: string, description?: string, isSmart?: boolean): Promise<DbPlaylist>
  deletePlaylist(id: number): Promise<void>
  addToPlaylist(playlistId: number, trackIds: number[]): Promise<void>
  search(query: string, limit?: number): Promise<SearchResultsPayload>
  folders(): Promise<DbFolder[]>
  pickFolder(): Promise<PickFolderResult>
  addFolder(token: string): Promise<AddFolderResult>
  removeFolder(id: number, options?: RemoveFolderOptions): Promise<void>
  scanNow(folderId?: number): Promise<LibraryScanRun>
  scanLog(folderId?: number, limit?: number): Promise<LibraryScanLogPayload>

  // Event subscriptions — handlers receive the payload and return an off() func.
  onImportProgress(h: (e: ImportProgressEvent) => void): EventOff
  onImportComplete(h: (e: ImportCompleteEvent) => void): EventOff
  onLibraryChanged(h: () => void): EventOff
}

export interface QueueApi {
  save(payload: QueueSnapshotPayload): Promise<void>
  load(): Promise<QueueSnapshotPayload>
}

export interface MetaApi {
  version: string
  platform: DesktopPlatform
}

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface AppUpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface AppUpdateState {
  currentVersion: string
  status: AppUpdateStatus
  updateVersion: string | null
  releaseName: string | null
  releaseDate: string | null
  releaseNotes: string | null
  progress: AppUpdateProgress | null
  error: string | null
  lastCheckedAt: number | null
  canCheck: boolean
  canDownload: boolean
  canInstall: boolean
}

export interface UpdatesApi {
  getState(): Promise<AppUpdateState>
  checkNow(): Promise<AppUpdateState>
  download(): Promise<AppUpdateState>
  install(): Promise<void>
  onStateChanged(h: (state: AppUpdateState) => void): EventOff
}

export type PlaybackStatus = 'stopped' | 'playing' | 'paused' | 'loading'
export type FftMode = 'off' | 'mini' | 'full' | 'screen'

export interface StreamInfoPayload {
  freq: number
  chans: number
  ctype: number
  duration: number
  durationBytes: number
  bytesPerSecond: number
}

export type StreamLoadSource = 'memory' | 'progressive' | 'file' | 'none'
export type StreamLoadFailureReason =
  | 'file-not-found'
  | 'file-stat-failed'
  | 'not-a-file'
  | 'memory-skipped'
  | 'memory-size-limit'
  | 'memory-timeout'
  | 'memory-read-failed'
  | 'memory-empty'
  | 'memory-stream-failed'
  | 'cloud-size-unknown'
  | 'cloud-auth-required'
  | 'cloud-unreachable'
  | 'progressive-stream-failed'
  | 'progressive-read-failed'
  | 'file-stream-failed'

export type PreloadNextSource = StreamLoadSource
export type PreloadNextFailureReason = StreamLoadFailureReason

export interface StreamLoadResult {
  attempted: boolean
  attemptedMemory?: boolean
  source: StreamLoadSource
  reason: StreamLoadFailureReason | null
  durationMs: number
  sizeBytes: number | null
  streamInfo: StreamInfoPayload | null
  bufferedBytes: number | null
  totalBytes: number | null
  bufferedSec: number | null
  bufferComplete: boolean
}

export interface PreloadNextResult extends StreamLoadResult {
  attempted: boolean
  attemptedMemory?: boolean
  source: PreloadNextSource
  reason: StreamLoadFailureReason | null
}

export interface ProgressEvent {
  positionSec: number
  durationSec: number
}

export interface BufferProgressEvent {
  currentPath: string | null
  source: StreamLoadSource
  reason: StreamLoadFailureReason | null
  bufferedBytes: number | null
  totalBytes: number | null
  bufferedSec: number | null
  bufferComplete: boolean
}

export interface PlaybackStatePayload {
  status: PlaybackStatus
  positionSec: number
  streamInfo: StreamInfoPayload | null
  streamSource: StreamLoadSource
  bufferedBytes: number | null
  totalBytes: number | null
  bufferedSec: number | null
  bufferComplete: boolean
  volume: number
  currentPath: string | null
}

export interface AudioOutputDevice {
  id: number
  name: string
  driver: string | null
  flags: number
  isDefault: boolean
  isCurrent: boolean
  isInitialized: boolean
  // True when the device was successfully mapped to a CoreAudio AudioDeviceID
  // and can therefore participate in hog-mode (macOS-only). The renderer uses
  // this to grey out the exclusive-mode toggle for unsupported devices.
  supportsExclusive: boolean
}

export interface ExclusiveModeState {
  enabled: boolean
  deviceId: number | null
  // When a toggle attempt fails (hog already held, mapping missing, etc.) the
  // reason is surfaced here so the UI can show it inline without throwing.
  reason?: string
}

export interface EqState {
  enabled: boolean
  preset: string
  bands: number[]              // global EQ gains in dB, one per active band
  bandCount: number            // number of active bands (configurable, ≤ 32)
}

// Volume leveler (loudness normalization / "Sound Check"). Config mirrors
// shared/constants/leveler.ts LevelerConfig.
export interface LevelerConfig {
  enabled: boolean
  targetLufs: number           // normalization target, LUFS
  preventClipping: boolean     // cap boosts to keep the true peak under 0 dBFS
}

export interface LevelerState extends LevelerConfig {
  // The gain (dB) the leveler is currently applying to the playing track. 0 when
  // disabled or the track has no loudness data. Display-only.
  currentGainDb: number
}

export interface FftEvent {
  bins: number[]               // ~64 log-spaced amplitude bins, 0..1
}

export interface LevelsEvent {
  peakL: number; peakR: number  // linear 0..1
  rmsL: number;  rmsR: number   // linear 0..1
}

export interface WaveformResult {
  peaks: number[]              // max-abs amplitude per bucket, 0..1
  drApprox: number             // crest-factor dB (approximate dynamic range)
  peakDb: number               // true peak dBFS
  buckets: number
}

export interface PlaybackAnalysisResult extends WaveformResult {
  analysisVersion: number
  source: 'cache' | 'decoded'
}

export interface PlaybackTableBarsResult {
  analysisVersion: number
  source: 'cache' | 'decoded'
  fps: 60
  bands: 5
  frames: number
  durationSec: number
  complete: true
  values: number[]             // flattened frames × bands, display-scale values 0..1
}

export interface PlaybackCacheStats {
  maxBytes: number
  usedBytes: number
  entries: number
}

export type PlaybackSource =
  | { kind: 'library'; trackId: number }
  | { kind: 'device'; deviceId: string; trackKey: string }

export interface ArtistListMode {
  mode: 'manual' | 'topPlays'
  n?: number
}

export interface AudioApi {
  load(source: PlaybackSource): Promise<StreamLoadResult>
  play(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  seek(positionSec: number): Promise<void>
  setVolume(value: number): Promise<void>
  setFftMode(mode: FftMode): Promise<void>
  setMeterEnabled(enabled: boolean): Promise<void>
  getWaveform(source: PlaybackSource, buckets?: number): Promise<PlaybackAnalysisResult>
  getCachedAnalysis(source: PlaybackSource, buckets?: number): Promise<PlaybackAnalysisResult | null>
  ensurePlaybackAnalysis(source: PlaybackSource, buckets?: number): Promise<PlaybackAnalysisResult>
  getCachedTableBars(source: PlaybackSource): Promise<PlaybackTableBarsResult | null>
  ensureTableBars(source: PlaybackSource): Promise<PlaybackTableBarsResult>
  getPlaybackCacheStats(): Promise<PlaybackCacheStats>
  setPlaybackCacheLimit(maxBytes: number): Promise<PlaybackCacheStats>
  clearPlaybackCache(): Promise<PlaybackCacheStats>
  preloadNext(source: PlaybackSource): Promise<PreloadNextResult>
  setGaplessEnabled(enabled: boolean): Promise<void>
  clearNext(): Promise<void>
  swapNow(): Promise<StreamLoadResult | null>
  promoteCurrentToMemory(): Promise<StreamLoadResult>
  getStatus(): Promise<PlaybackStatePayload>
  listOutputDevices(): Promise<AudioOutputDevice[]>
  setOutputDevice(deviceId: number): Promise<AudioOutputDevice>
  getOutputDevice(): Promise<AudioOutputDevice | null>
  getExclusiveMode(): Promise<ExclusiveModeState>
  setExclusiveMode(enabled: boolean): Promise<ExclusiveModeState>

  onProgress(h: (e: ProgressEvent) => void): EventOff
  onTrackEnded(h: () => void): EventOff
  onGaplessFired(h: (e: { path: string; streamInfo: StreamInfoPayload | null; source?: StreamLoadSource }) => void): EventOff
  onStateChanged(h: (e: { status: PlaybackStatus }) => void): EventOff
  onStreamSourceChanged(h: (e: { source: StreamLoadSource; currentPath: string | null }) => void): EventOff
  onBufferProgress(h: (e: BufferProgressEvent) => void): EventOff
  onFft(h: (e: FftEvent) => void): EventOff
  onLevels(h: (e: LevelsEvent) => void): EventOff
  onExclusiveModeChanged(h: (e: ExclusiveModeState) => void): EventOff
  onPlaybackCacheChanged(h: (e: PlaybackCacheStats) => void): EventOff
}

export interface EqApi {
  getState(): Promise<EqState>
  setEnabled(enabled: boolean): Promise<void>
  setBand(index: number, gain: number): Promise<void>
  setBands(bands: number[]): Promise<void>
  setBandCount(count: number): Promise<void>
  previewBand(index: number, gain: number): Promise<void>
  setPreset(name: string): Promise<void>
  presets(): Promise<string[]>
  onChanged(h: (e: EqState) => void): EventOff
}

export interface LevelerApi {
  getState(): Promise<LevelerState>
  setConfig(patch: Partial<LevelerConfig>): Promise<LevelerState>
  onChanged(h: (e: LevelerState) => void): EventOff
}

export interface TracksApi {
  countPlay(trackId: number): Promise<void>
  setFavorite(id: number, favorite: boolean): Promise<void>
  updateMetadata(trackId: number, payload: TrackMetadataUpdatePayload): Promise<void>
  refreshMetadata(trackId: number): Promise<void>
  findMetadataCompletionTargets(folderId?: number, limit?: number): Promise<MetadataCompletionTargetsPayload>
  previewMetadataCompletion(trackIds: number[]): Promise<MetadataCompletionPreview>
  applyMetadataCompletions(payload: MetadataCompletionApplyRequest): Promise<MetadataCompletionApplyResult>
  findOriginalAlbums(trackId: number): Promise<OriginalAlbumCandidatesResult>
  previewAlbumMove(payload: TrackAlbumMovePreviewRequest): Promise<TrackAlbumMovePreview>
  applyAlbumMove(payload: TrackAlbumMoveApplyRequest): Promise<TrackAlbumMoveApplyResult>
  trash(trackIds: number[]): Promise<TrashTracksResult>
}

export interface AlbumsApi {
  setFavorite(id: number, favorite: boolean): Promise<void>
}

export interface ArtistsApi {
  setFavorite(id: number, favorite: boolean): Promise<void>
  setArtworkFromAlbum(artistId: number, albumId: number): Promise<{ artworkPath: string }>
  pickArtwork(artistId: number): Promise<{ canceled: boolean; artworkPath: string | null }>
  resetArtwork(artistId: number): Promise<void>
}

export interface LyricsApi {
  get(trackId: number): Promise<LyricsView>
  // `force` rebuilds the per-folder lyrics index from disk (reconciles sidecars
  // changed outside the app); the default fast path reads the cached index.
  libraryOverview(force?: boolean): Promise<LyricsLibraryOverview>
  fetch(trackId: number, force?: boolean): Promise<LyricsView>
  search(trackId: number): Promise<LyricsCandidate[]>
  importCandidate(trackId: number, lrclibId: string): Promise<LyricsView>
  importFile(trackId: number): Promise<LyricsView | null>
  importLrc(trackId: number, lrcText: string): Promise<LyricsView>
  save(trackId: number, plain: string | null, synced: string | null): Promise<LyricsView>
  setOffset(trackId: number, offsetMs: number): Promise<LyricsView>
  export(trackId: number): Promise<{ canceled: boolean; path: string | null }>
  remove(trackId: number): Promise<void>
  fetchForSelection(trackIds: number[]): Promise<LyricsSelectionSummary>

  onChanged(h: (e: { trackId: number }) => void): EventOff
  onSelectionProgress(h: (e: LyricsSelectionProgress) => void): EventOff
  // Fires while the library overview scans disk to (re)build the lyrics index.
  onLibraryProgress(h: (e: LyricsLibraryProgress) => void): EventOff
}

export interface SettingsApi {
  // Pushes the renderer-side preference into main so the LibraryBackup
  // service can short-circuit writes when the user has disabled the feature.
  setLibraryBackup(enabled: boolean): Promise<void>
  setLibraryScanLogRetention(days: number | null): Promise<void>
  // Pushes lyrics preferences into main so it knows cache/fetch behavior before
  // any lyrics action (mirrors setLibraryBackup).
  setLyrics(patch: Partial<LyricsSettingsState>): Promise<void>
}

export interface DevicesApi {
  detectCandidates(): Promise<DeviceCandidate[]>
  volumes(): Promise<DeviceVolumeSnapshot>
  ignoreVolume(token: string): Promise<DeviceVolumeSnapshot>
  pickRoot(): Promise<PickFolderResult>
  pickMusicRoot(reference: DeviceRootReference, currentMusicRoot?: string): Promise<DeviceMusicRootPickResult>
  connect(payload: DeviceConnectPayload): Promise<DeviceRecord>
  updateSettings(deviceId: string, settings: DeviceSettingsUpdate): Promise<DeviceRecord>
  list(): Promise<DeviceRecord[]>
  overview(deviceId: string): Promise<DeviceOverviewResult>
  scan(deviceId: string): Promise<DeviceScanResult>
  library(deviceId: string, options?: DeviceLibraryOptions): Promise<DeviceLibraryResult>
  rockboxThemes(deviceId: string): Promise<RockboxThemeLibraryResult>
  planSync(payload: DeviceSyncPlanRequest): Promise<DeviceSyncPlan>
  applySync(planId: string, selection?: DeviceSyncApplySelection): Promise<DeviceSyncApplyResult>
  optimizeArtwork(
    deviceId: string,
    selection?: DeviceArtworkOptimizationSelection,
  ): Promise<DeviceArtworkOptimizationSummary>
  installRockboxThemesFromFiles(deviceId: string, files: unknown[]): Promise<RockboxThemeInstallResult>
  deleteRockboxTheme(deviceId: string, themeId: string): Promise<RockboxThemeDeleteResult>
  listPendingJournals(): Promise<DevicePendingJournal[]>
  resumeJournal(journalId: string): Promise<DeviceSyncApplyResult>
  discardJournal(journalId: string): Promise<void>
  analyzeArtwork(deviceId: string): Promise<DeviceArtworkAnalysisResult>

  onScanProgress(h: (e: DeviceScanProgressEvent) => void): EventOff
  onSyncProgress(h: (e: DeviceSyncProgressEvent) => void): EventOff
  onVolumesChanged(h: (e: DeviceVolumeSnapshot) => void): EventOff
  onArtworkAnalyzeProgress(h: (e: DeviceArtworkAnalysisProgressEvent) => void): EventOff
}

export interface DownloadsApi {
  getSettings(): Promise<DownloadSettings>
  setSettings(patch: Partial<DownloadSettings>): Promise<DownloadSettings>
  getAuthState(provider: DownloadProvider): Promise<ProviderAuthState>
  saveCredentials(payload: ProviderCredentialsPayload): Promise<void>
  clearCredentials(provider: DownloadProvider): Promise<void>
  inspectHar(provider: DownloadProvider, files: unknown[]): Promise<HarImportPreview>
  applyHarImport(provider: DownloadProvider, previewId: string): Promise<void>
  getTutorialState(): Promise<ServiceTutorialState>
  setTutorialState(patch: Partial<ServiceTutorialState>): Promise<ServiceTutorialState>
  search(payload: DownloadSearchRequest): Promise<OnlineTrackResult[]>
  enqueue(payload: EnqueueDownloadRequest): Promise<DownloadJob[]>
  jobs(): Promise<DownloadJob[]>
  cancel(jobId: string): Promise<void>
  retry(jobId: string): Promise<DownloadJob | null>

  onProgress(h: (e: DownloadProgressEvent) => void): EventOff
  onJobsChanged(h: (e: DownloadJobsChangedEvent) => void): EventOff
}

export interface CloudApi {
  accountStatus(): Promise<CloudAccountStatus>
  connect(): Promise<CloudAccountStatus>
  disconnect(): Promise<CloudAccountStatus>
  setClientId(clientId: string): Promise<CloudAccountStatus>
  getPrefs(): Promise<CloudPrefs>
  setPrefs(patch: Partial<CloudPrefs>): Promise<CloudPrefs>
  listRemoteFolders(driveId: string | null, itemId: string | null): Promise<RemoteFolderEntry[]>
  addFolder(driveId: string, itemId: string, name: string, remotePath?: string): Promise<CloudFolderRef>
  syncFolder(folderId: number): Promise<void>
  moveToCloud(req: MoveToCloudRequest): Promise<void>

  onAccountChanged(h: (e: CloudAccountStatus) => void): EventOff
  onSyncProgress(h: (e: CloudSyncProgressEvent) => void): EventOff
  onMoveProgress(h: (e: CloudMoveProgressEvent) => void): EventOff
}

export interface AddLocalLibraryLocationRequest {
  token: string
  role: LibraryRole
  backupSourceFolderId?: number | null
}

export interface AddOneDriveLibraryLocationRequest {
  driveId: string
  itemId: string
  name: string
  remotePath?: string
  role: LibraryRole
  backupSourceFolderId?: number | null
}

export interface LibraryLocationsApi {
  list(): Promise<LibraryLocation[]>
  pickLocal(): Promise<PickFolderResult>
  addLocal(input: AddLocalLibraryLocationRequest): Promise<LibraryLocation>
  requestLocalAccess(folderId: number): Promise<LocalAccessRequestResult>
  openFilePrivacySettings(): Promise<void>
  getOneDriveStatus(): Promise<CloudAccountStatus>
  setOneDriveClientId(clientId: string): Promise<CloudAccountStatus>
  connectOneDrive(): Promise<CloudAccountStatus>
  disconnectOneDrive(): Promise<CloudAccountStatus>
  listOneDriveFolders(driveId: string | null, itemId: string | null): Promise<RemoteFolderEntry[]>
  addOneDrive(input: AddOneDriveLibraryLocationRequest): Promise<LibraryLocation>
  updatePresentation(folderId: number, input: { name: string; displayIcon: string | null }): Promise<LibraryLocation>
  remove(folderId: number): Promise<void>
}

export interface LibraryMigrationsApi {
  list(): Promise<LibraryMigrationState[]>
  create(input: CreateLibraryMigrationRequest): Promise<LibraryMigrationState>
  approve(runId: string): Promise<LibraryMigrationState>
  pause(runId: string): Promise<LibraryMigrationState>
  resume(runId: string): Promise<LibraryMigrationState>
  cancel(runId: string): Promise<LibraryMigrationState>
  retryCleanup(runId: string): Promise<LibraryMigrationState>
  onProgress(h: (e: LibraryMigrationProgressEvent) => void): EventOff
}

export interface BackupDiffEntry {
  path: string
  action: 'create' | 'update' | 'delete' | 'conflict'
  reason: string | null
}

export interface BackupPlanDetails extends BackupPlanSummary {
  entries: BackupDiffEntry[]
}

export interface LibraryBackupStatePayload {
  backupFolderId: number
  sourceFolderId: number
  runId: string | null
  status: BackupRunStatus | 'idle'
  phase: BackupProgressPhase | null
  completedActions: number
  totalActions: number
  completedBytes: number
  totalBytes: number | null
  relativePath: string | null
  message: string | null
  error: string | null
  lastRunAt: string | null
  plan: BackupPlanDetails | null
}

export interface LibraryBackupsApi {
  list(): Promise<LibraryBackupStatePayload[]>
  assign(input: { sourceFolderId: number; backupFolderId: number }): Promise<LibraryBackupStatePayload>
  remove(backupFolderId: number): Promise<void>
  promote(backupFolderId: number): Promise<LibraryLocation>
  start(backupFolderId: number): Promise<LibraryBackupStatePayload>
  pause(backupFolderId: number): Promise<LibraryBackupStatePayload>
  resume(backupFolderId: number): Promise<LibraryBackupStatePayload>
  approveDiff(backupFolderId: number, runId: string): Promise<LibraryBackupStatePayload>
  onProgress(h: (e: BackupProgressEvent) => void): EventOff
}

export interface DuplicatesApi {
  summary(): Promise<DuplicateSummary>
  list(request?: DuplicateListRequest): Promise<DuplicateCandidateSummary[]>
  detail(candidateId: string): Promise<DuplicateCandidateDetail>
  resolve(request: DuplicateResolutionRequest): Promise<DuplicateResolutionResult>
  reanalyze(): Promise<void>
  audition: {
    beginSession(): Promise<DuplicateAuditionState>
    open(request: DuplicateAuditionOpenRequest): Promise<DuplicateAuditionState>
    play(side: DuplicateAuditionSide): Promise<DuplicateAuditionState>
    pause(): Promise<DuplicateAuditionState>
    seek(request: DuplicateAuditionSeekRequest): Promise<DuplicateAuditionState>
    compareSegment(request: DuplicateAuditionCompareSegmentRequest): Promise<DuplicateAuditionState>
    close(): Promise<DuplicateAuditionState>
  }
  onChanged(h: () => void): EventOff
  onProgress(h: (e: DuplicateAnalysisProgress) => void): EventOff
  onAuditionState(h: (e: DuplicateAuditionState) => void): EventOff
}

export interface FolderCleanupApi {
  pending(): Promise<FolderCleanupProposal[]>
  confirm(proposalId: string): Promise<FolderCleanupConfirmResult>
  dismiss(proposalId: string): Promise<void>
  onEvent(h: (e: FolderCleanupEvent) => void): EventOff
}

export interface Api {
  meta: MetaApi
  library: LibraryApi
  queue: QueueApi
  audio: AudioApi
  eq: EqApi
  leveler: LevelerApi
  tracks: TracksApi
  albums: AlbumsApi
  artists: ArtistsApi
  settings: SettingsApi
  lyrics: LyricsApi
  devices: DevicesApi
  downloads: DownloadsApi
  cloud: CloudApi
  libraryLocations: LibraryLocationsApi
  libraryBackups: LibraryBackupsApi
  libraryMigrations: LibraryMigrationsApi
  duplicates: DuplicatesApi
  folderCleanup: FolderCleanupApi
  updates: UpdatesApi
}

declare global {
  interface Window {
    api: Api
  }
}
