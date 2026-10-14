import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import packageJson from '../../package.json'
import type {
  AddLocalLibraryLocationRequest,
  AddOneDriveLibraryLocationRequest,
  AddFolderResult,
  AppUpdateState,
  Api,
  BufferProgressEvent,
  EqState,
  EventOff,
  ExclusiveModeState,
  FftEvent,
  FftMode,
  LevelerConfig,
  LevelerState,
  ImportCompleteEvent,
  ImportProgressEvent,
  LevelsEvent,
  LibraryBackupStatePayload,
  LibraryScanLogPayload,
  LibraryScanRun,
  ListTracksOpts,
  MetadataCompletionApplyRequest,
  MetadataCompletionApplyResult,
  MetadataCompletionPreview,
  MetadataCompletionTargetsPayload,
  OriginalAlbumCandidatesResult,
  PickFolderResult,
  PlaybackSource,
  PlaybackAnalysisResult,
  PlaybackCacheStats,
  PreloadNextResult,
  StreamInfoPayload,
  StreamLoadResult,
  StreamLoadSource,
  PlaybackStatePayload,
  PlaybackStatus,
  PlaybackTableBarsResult,
  ProgressEvent,
  QueueSnapshotPayload,
  RemoveFolderOptions,
  SearchResultsPayload,
  TrackAlbumMoveApplyRequest,
  TrackAlbumMoveApplyResult,
  TrackAlbumMovePreview,
  TrackAlbumMovePreviewRequest,
  TrackMetadataUpdatePayload,
  TrashTracksResult,
} from '@shared/types/ipc-contract'
import type {
  DeviceArtworkAnalysisProgressEvent,
  DeviceArtworkAnalysisResult,
  DeviceArtworkOptimizationSelection,
  DeviceArtworkOptimizationSummary,
  DeviceCandidate,
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
  RockboxThemeDeleteResult,
  DeviceVolumeSnapshot,
  RockboxThemeInstallResult,
  RockboxThemeLibraryResult,
} from '@shared/types/device-sync'
import type {
  DbAlbum,
  DbArtist,
  DbFolder,
  DbGenre,
  DbPlaylist,
  DbTrack,
} from '@shared/types/db'
import type {
  LyricsCandidate,
  LyricsLibraryOverview,
  LyricsLibraryProgress,
  LyricsSelectionProgress,
  LyricsSelectionSummary,
  LyricsSettingsState,
  LyricsView,
} from '@shared/types/lyrics'
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
} from '@shared/types/downloads'
import type {
  CloudAccountStatus,
  CloudFolderRef,
  CloudMoveProgressEvent,
  CloudPrefs,
  CloudSyncProgressEvent,
  MoveToCloudRequest,
  RemoteFolderEntry,
} from '@shared/types/cloud'
import type {
  BackupProgressEvent,
  CreateLibraryMigrationRequest,
  LibraryLocation,
  LibraryMigrationProgressEvent,
  LibraryMigrationState,
} from '@shared/types/library-locations'
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
} from '@shared/types/duplicates'
import type {
  FolderCleanupConfirmResult,
  FolderCleanupEvent,
  FolderCleanupProposal,
} from '@shared/types/folder-cleanup'
import { desktopPlatform } from '@shared/utils/computerTerms'

function subscribe<T>(channel: string, handler: (payload: T) => void): EventOff {
  const listener = (_event: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: Api = {
  meta: {
    version: packageJson.version,
    platform: desktopPlatform(process.platform),
  },
  duplicates: {
    summary: () => ipcRenderer.invoke('duplicates:summary') as Promise<DuplicateSummary>,
    list: (request?: DuplicateListRequest) =>
      ipcRenderer.invoke('duplicates:list', request ?? {}) as Promise<DuplicateCandidateSummary[]>,
    detail: (candidateId: string) =>
      ipcRenderer.invoke('duplicates:detail', candidateId) as Promise<DuplicateCandidateDetail>,
    resolve: (request: DuplicateResolutionRequest) =>
      ipcRenderer.invoke('duplicates:resolve', request) as Promise<DuplicateResolutionResult>,
    reanalyze: () => ipcRenderer.invoke('duplicates:reanalyze') as Promise<void>,
    audition: {
      beginSession: () =>
        ipcRenderer.invoke('duplicates:audition:beginSession') as Promise<DuplicateAuditionState>,
      open: (request: DuplicateAuditionOpenRequest) =>
        ipcRenderer.invoke('duplicates:audition:open', request) as Promise<DuplicateAuditionState>,
      play: (side: DuplicateAuditionSide) =>
        ipcRenderer.invoke('duplicates:audition:play', side) as Promise<DuplicateAuditionState>,
      pause: () => ipcRenderer.invoke('duplicates:audition:pause') as Promise<DuplicateAuditionState>,
      seek: (request: DuplicateAuditionSeekRequest) =>
        ipcRenderer.invoke('duplicates:audition:seek', request) as Promise<DuplicateAuditionState>,
      compareSegment: (request: DuplicateAuditionCompareSegmentRequest) =>
        ipcRenderer.invoke('duplicates:audition:compareSegment', request) as Promise<DuplicateAuditionState>,
      close: () => ipcRenderer.invoke('duplicates:audition:close') as Promise<DuplicateAuditionState>,
    },
    onChanged: (h) => subscribe<void>('duplicates:changed', () => h()),
    onProgress: (h) => subscribe<DuplicateAnalysisProgress>('duplicates:progress', h),
    onAuditionState: (h) => subscribe<DuplicateAuditionState>('duplicates:auditionState', h),
  },
  library: {
    tracks: (opts?: ListTracksOpts) =>
      ipcRenderer.invoke('library:tracks', opts ?? {}) as Promise<DbTrack[]>,
    trackById: (id: number) =>
      ipcRenderer.invoke('library:track:byId', id) as Promise<DbTrack | null>,
    trackCount: () => ipcRenderer.invoke('library:track:count') as Promise<number>,
    albums: () => ipcRenderer.invoke('library:albums') as Promise<DbAlbum[]>,
    albumById: (id: number) =>
      ipcRenderer.invoke('library:album:byId', id) as Promise<DbAlbum | null>,
    albumTracks: (id: number) =>
      ipcRenderer.invoke('library:album:tracks', id) as Promise<DbTrack[]>,
    artists: () => ipcRenderer.invoke('library:artists') as Promise<DbArtist[]>,
    artistById: (id: number) =>
      ipcRenderer.invoke('library:artist:byId', id) as Promise<DbArtist | null>,
    artistTracks: (id: number) =>
      ipcRenderer.invoke('library:artist:tracks', id) as Promise<DbTrack[]>,
    genres: () => ipcRenderer.invoke('library:genres') as Promise<DbGenre[]>,
    genreTracks: (id: number) =>
      ipcRenderer.invoke('library:genre:tracks', id) as Promise<DbTrack[]>,
    playlists: () => ipcRenderer.invoke('library:playlists') as Promise<DbPlaylist[]>,
    playlistById: (id: number) =>
      ipcRenderer.invoke('library:playlist:byId', id) as Promise<DbPlaylist | null>,
    playlistTracks: (id: number) =>
      ipcRenderer.invoke('library:playlist:tracks', id) as Promise<DbTrack[]>,
    createPlaylist: (name, description, isSmart) =>
      ipcRenderer.invoke('library:playlist:create', { name, description, isSmart }) as Promise<DbPlaylist>,
    deletePlaylist: (id) => ipcRenderer.invoke('library:playlist:delete', id) as Promise<void>,
    addToPlaylist: (playlistId, trackIds) =>
      ipcRenderer.invoke('library:playlist:addTracks', { playlistId, trackIds }) as Promise<void>,
    search: (query: string, limit?: number) =>
      ipcRenderer.invoke('library:search', query, limit) as Promise<SearchResultsPayload>,
    folders: () => ipcRenderer.invoke('library:folders') as Promise<DbFolder[]>,
    pickFolder: () => ipcRenderer.invoke('library:folders:pick') as Promise<PickFolderResult>,
    addFolder: (token: string) =>
      ipcRenderer.invoke('library:folders:add', token) as Promise<AddFolderResult>,
    removeFolder: (id: number, options?: RemoveFolderOptions) =>
      ipcRenderer.invoke('library:folders:remove', id, options ?? {}) as Promise<void>,
    scanNow: (folderId?: number) =>
      ipcRenderer.invoke('library:scanNow', folderId) as Promise<LibraryScanRun>,
    scanLog: (folderId?: number, limit?: number) =>
      ipcRenderer.invoke('library:scanLog', folderId, limit) as Promise<LibraryScanLogPayload>,

    onImportProgress: (h) => subscribe<ImportProgressEvent>('library:import:progress', h),
    onImportComplete: (h) => subscribe<ImportCompleteEvent>('library:import:complete', h),
    onLibraryChanged: (h) => subscribe<void>('library:changed', () => h()),
  },
  queue: {
    save: (payload: QueueSnapshotPayload) =>
      ipcRenderer.invoke('queue:save', payload) as Promise<void>,
    load: () => ipcRenderer.invoke('queue:load') as Promise<QueueSnapshotPayload>,
  },
  audio: {
    load: (source: PlaybackSource) =>
      ipcRenderer.invoke('audio:load', source) as Promise<StreamLoadResult>,
    play: () => ipcRenderer.invoke('audio:play') as Promise<void>,
    pause: () => ipcRenderer.invoke('audio:pause') as Promise<void>,
    stop: () => ipcRenderer.invoke('audio:stop') as Promise<void>,
    seek: (positionSec: number) =>
      ipcRenderer.invoke('audio:seek', { positionSec }) as Promise<void>,
    setVolume: (value: number) =>
      ipcRenderer.invoke('audio:setVolume', { value }) as Promise<void>,
    setFftMode: (mode: FftMode) =>
      ipcRenderer.invoke('audio:setFftMode', { mode }) as Promise<void>,
    setMeterEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('audio:setMeterEnabled', { enabled }) as Promise<void>,
    getWaveform: (source: PlaybackSource, buckets?: number) =>
      ipcRenderer.invoke('audio:getWaveform', { source, buckets }) as Promise<PlaybackAnalysisResult>,
    getCachedAnalysis: (source: PlaybackSource, buckets?: number) =>
      ipcRenderer.invoke('audio:getCachedAnalysis', { source, buckets }) as Promise<PlaybackAnalysisResult | null>,
    ensurePlaybackAnalysis: (source: PlaybackSource, buckets?: number) =>
      ipcRenderer.invoke('audio:ensurePlaybackAnalysis', { source, buckets }) as Promise<PlaybackAnalysisResult>,
    getCachedTableBars: (source: PlaybackSource) =>
      ipcRenderer.invoke('audio:getCachedTableBars', { source }) as Promise<PlaybackTableBarsResult | null>,
    ensureTableBars: (source: PlaybackSource) =>
      ipcRenderer.invoke('audio:ensureTableBars', { source }) as Promise<PlaybackTableBarsResult>,
    getPlaybackCacheStats: () =>
      ipcRenderer.invoke('audio:playbackCache:stats') as Promise<PlaybackCacheStats>,
    setPlaybackCacheLimit: (maxBytes: number) =>
      ipcRenderer.invoke('audio:playbackCache:setLimit', { maxBytes }) as Promise<PlaybackCacheStats>,
    clearPlaybackCache: () =>
      ipcRenderer.invoke('audio:playbackCache:clear') as Promise<PlaybackCacheStats>,
    preloadNext: (source: PlaybackSource) =>
      ipcRenderer.invoke('audio:preloadNext', source) as Promise<PreloadNextResult>,
    setGaplessEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('audio:setGaplessEnabled', { enabled }) as Promise<void>,
    clearNext: () => ipcRenderer.invoke('audio:clearNext') as Promise<void>,
    swapNow: () => ipcRenderer.invoke('audio:swapNow') as Promise<StreamLoadResult | null>,
    promoteCurrentToMemory: () => ipcRenderer.invoke('audio:promoteCurrentToMemory') as Promise<StreamLoadResult>,
    getStatus: () => ipcRenderer.invoke('audio:getStatus') as Promise<PlaybackStatePayload>,
    listOutputDevices: () => ipcRenderer.invoke('audio:devices:list'),
    setOutputDevice: (deviceId: number) =>
      ipcRenderer.invoke('audio:devices:set', { deviceId }),
    getOutputDevice: () => ipcRenderer.invoke('audio:devices:current'),
    getExclusiveMode: () =>
      ipcRenderer.invoke('audio:exclusive:get') as Promise<ExclusiveModeState>,
    setExclusiveMode: (enabled: boolean) =>
      ipcRenderer.invoke('audio:exclusive:set', { enabled }) as Promise<ExclusiveModeState>,
    onProgress: (h) => subscribe<ProgressEvent>('audio:progress', h),
    onTrackEnded: (h) => subscribe<void>('audio:track-ended', () => h()),
    onGaplessFired: (h) => subscribe<{ path: string; streamInfo: StreamInfoPayload | null; source?: StreamLoadSource }>('audio:gapless-fired', h),
    onStreamSourceChanged: (h) => subscribe<{ source: StreamLoadSource; currentPath: string | null }>('audio:stream-source-changed', h),
    onBufferProgress: (h) => subscribe<BufferProgressEvent>('audio:buffer-progress', h),
    onStateChanged: (h) => subscribe<{ status: PlaybackStatus }>('audio:state-changed', h),
    onFft: (h) => subscribe<FftEvent>('audio:fft', h),
    onLevels: (h) => subscribe<LevelsEvent>('audio:levels', h),
    onExclusiveModeChanged: (h) => subscribe<ExclusiveModeState>('audio:exclusive-changed', h),
    onPlaybackCacheChanged: (h) => subscribe<PlaybackCacheStats>('audio:playback-cache-changed', h),
  },
  eq: {
    getState: () => ipcRenderer.invoke('eq:getState') as Promise<EqState>,
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('eq:setEnabled', { enabled }) as Promise<void>,
    setBand: (index: number, gain: number) =>
      ipcRenderer.invoke('eq:setBand', { index, gain }) as Promise<void>,
    setBands: (bands: number[]) =>
      ipcRenderer.invoke('eq:setBands', { bands }) as Promise<void>,
    setBandCount: (count: number) =>
      ipcRenderer.invoke('eq:setBandCount', { count }) as Promise<void>,
    previewBand: (index: number, gain: number) =>
      ipcRenderer.invoke('eq:previewBand', { index, gain }) as Promise<void>,
    setPreset: (name: string) =>
      ipcRenderer.invoke('eq:setPreset', { name }) as Promise<void>,
    presets: () => ipcRenderer.invoke('eq:presets') as Promise<string[]>,
    onChanged: (h) => subscribe<EqState>('eq:changed', h),
  },
  leveler: {
    getState: () => ipcRenderer.invoke('leveler:getState') as Promise<LevelerState>,
    setConfig: (patch: Partial<LevelerConfig>) =>
      ipcRenderer.invoke('leveler:setConfig', patch) as Promise<LevelerState>,
    onChanged: (h) => subscribe<LevelerState>('leveler:changed', h),
  },
  tracks: {
    countPlay: (trackId: number) =>
      ipcRenderer.invoke('track:countPlay', trackId) as Promise<void>,
    setFavorite: (id: number, favorite: boolean) =>
      ipcRenderer.invoke('track:setFavorite', { id, favorite }) as Promise<void>,
    updateMetadata: (trackId: number, payload: TrackMetadataUpdatePayload) =>
      ipcRenderer.invoke('track:updateMetadata', { trackId, metadata: payload }) as Promise<void>,
    refreshMetadata: (trackId: number) =>
      ipcRenderer.invoke('track:refreshMetadata', trackId) as Promise<void>,
    findMetadataCompletionTargets: (folderId?: number, limit?: number) =>
      ipcRenderer.invoke('track:metadataCompletion:targets', { folderId, limit }) as Promise<MetadataCompletionTargetsPayload>,
    previewMetadataCompletion: (trackIds: number[]) =>
      ipcRenderer.invoke('track:metadataCompletion:preview', trackIds) as Promise<MetadataCompletionPreview>,
    applyMetadataCompletions: (payload: MetadataCompletionApplyRequest) =>
      ipcRenderer.invoke('track:metadataCompletion:apply', payload) as Promise<MetadataCompletionApplyResult>,
    findOriginalAlbums: (trackId: number) =>
      ipcRenderer.invoke('track:originalAlbum:candidates', trackId) as Promise<OriginalAlbumCandidatesResult>,
    previewAlbumMove: (payload: TrackAlbumMovePreviewRequest) =>
      ipcRenderer.invoke('track:albumMove:preview', payload) as Promise<TrackAlbumMovePreview>,
    applyAlbumMove: (payload: TrackAlbumMoveApplyRequest) =>
      ipcRenderer.invoke('track:albumMove:apply', payload) as Promise<TrackAlbumMoveApplyResult>,
    trash: (trackIds: number[]) =>
      ipcRenderer.invoke('track:trash', trackIds) as Promise<TrashTracksResult>,
  },
  albums: {
    setFavorite: (id: number, favorite: boolean) =>
      ipcRenderer.invoke('album:setFavorite', { id, favorite }) as Promise<void>,
  },
  artists: {
    setFavorite: (id: number, favorite: boolean) =>
      ipcRenderer.invoke('artist:setFavorite', { id, favorite }) as Promise<void>,
    setArtworkFromAlbum: (artistId: number, albumId: number) =>
      ipcRenderer.invoke('artist:setArtworkFromAlbum', { artistId, albumId }) as Promise<{ artworkPath: string }>,
    pickArtwork: (artistId: number) =>
      ipcRenderer.invoke('artist:pickArtwork', { artistId }) as Promise<{ canceled: boolean; artworkPath: string | null }>,
    resetArtwork: (artistId: number) =>
      ipcRenderer.invoke('artist:resetArtwork', { artistId }) as Promise<void>,
  },
  settings: {
    setLibraryBackup: (enabled: boolean) =>
      ipcRenderer.invoke('settings:setLibraryBackup', enabled) as Promise<void>,
    setLibraryScanLogRetention: (days: number | null) =>
      ipcRenderer.invoke('settings:setLibraryScanLogRetention', days) as Promise<void>,
    setLyrics: (patch: Partial<LyricsSettingsState>) =>
      ipcRenderer.invoke('settings:setLyrics', patch) as Promise<void>,
  },
  lyrics: {
    get: (trackId: number) =>
      ipcRenderer.invoke('lyrics:get', trackId) as Promise<LyricsView>,
    libraryOverview: (force?: boolean) =>
      ipcRenderer.invoke('lyrics:libraryOverview', force) as Promise<LyricsLibraryOverview>,
    fetch: (trackId: number, force?: boolean) =>
      ipcRenderer.invoke('lyrics:fetch', { trackId, force }) as Promise<LyricsView>,
    search: (trackId: number) =>
      ipcRenderer.invoke('lyrics:search', trackId) as Promise<LyricsCandidate[]>,
    importCandidate: (trackId: number, lrclibId: string) =>
      ipcRenderer.invoke('lyrics:importCandidate', { trackId, lrclibId }) as Promise<LyricsView>,
    importFile: (trackId: number) =>
      ipcRenderer.invoke('lyrics:importFile', trackId) as Promise<LyricsView | null>,
    importLrc: (trackId: number, lrcText: string) =>
      ipcRenderer.invoke('lyrics:import', { trackId, lrcText }) as Promise<LyricsView>,
    save: (trackId: number, plain: string | null, synced: string | null) =>
      ipcRenderer.invoke('lyrics:save', { trackId, plain, synced }) as Promise<LyricsView>,
    setOffset: (trackId: number, offsetMs: number) =>
      ipcRenderer.invoke('lyrics:setOffset', { trackId, offsetMs }) as Promise<LyricsView>,
    export: (trackId: number) =>
      ipcRenderer.invoke('lyrics:export', trackId) as Promise<{ canceled: boolean; path: string | null }>,
    remove: (trackId: number) =>
      ipcRenderer.invoke('lyrics:remove', { trackId }) as Promise<void>,
    fetchForSelection: (trackIds: number[]) =>
      ipcRenderer.invoke('lyrics:fetchForSelection', trackIds) as Promise<LyricsSelectionSummary>,
    onChanged: (h) => subscribe<{ trackId: number }>('lyrics:changed', h),
    onSelectionProgress: (h) => subscribe<LyricsSelectionProgress>('lyrics:selection:progress', h),
    onLibraryProgress: (h) => subscribe<LyricsLibraryProgress>('lyrics:library:progress', h),
  },
  devices: {
    detectCandidates: () =>
      ipcRenderer.invoke('devices:detectCandidates') as Promise<DeviceCandidate[]>,
    volumes: () =>
      ipcRenderer.invoke('devices:volumes') as Promise<DeviceVolumeSnapshot>,
    ignoreVolume: (token: string) =>
      ipcRenderer.invoke('devices:volumes:ignore', token) as Promise<DeviceVolumeSnapshot>,
    pickRoot: () =>
      ipcRenderer.invoke('devices:pickRoot') as Promise<PickFolderResult>,
    pickMusicRoot: (reference: DeviceRootReference, currentMusicRoot?: string) =>
      ipcRenderer.invoke('devices:pickMusicRoot', reference, currentMusicRoot) as Promise<DeviceMusicRootPickResult>,
    connect: (payload: DeviceConnectPayload) =>
      ipcRenderer.invoke('devices:connect', payload) as Promise<DeviceRecord>,
    updateSettings: (deviceId: string, settings: DeviceSettingsUpdate) =>
      ipcRenderer.invoke('devices:updateSettings', deviceId, settings) as Promise<DeviceRecord>,
    list: () =>
      ipcRenderer.invoke('devices:list') as Promise<DeviceRecord[]>,
    overview: (deviceId: string) =>
      ipcRenderer.invoke('devices:overview', deviceId) as Promise<DeviceOverviewResult>,
    scan: (deviceId: string) =>
      ipcRenderer.invoke('devices:scan', deviceId) as Promise<DeviceScanResult>,
    library: (deviceId: string, options?: DeviceLibraryOptions) =>
      ipcRenderer.invoke('devices:library', deviceId, options) as Promise<DeviceLibraryResult>,
    analyzeArtwork: (deviceId: string) =>
      ipcRenderer.invoke('devices:analyzeArtwork', deviceId) as Promise<DeviceArtworkAnalysisResult>,
    rockboxThemes: (deviceId: string) =>
      ipcRenderer.invoke('devices:rockboxThemes', deviceId) as Promise<RockboxThemeLibraryResult>,
    planSync: (payload: DeviceSyncPlanRequest) =>
      ipcRenderer.invoke('devices:planSync', payload) as Promise<DeviceSyncPlan>,
    applySync: (planId: string, selection?: DeviceSyncApplySelection) =>
      ipcRenderer.invoke('devices:applySync', planId, selection) as Promise<DeviceSyncApplyResult>,
    optimizeArtwork: (deviceId: string, selection?: DeviceArtworkOptimizationSelection) =>
      ipcRenderer.invoke('devices:optimizeArtwork', deviceId, selection) as Promise<DeviceArtworkOptimizationSummary>,
    installRockboxThemesFromFiles: (deviceId: string, files: unknown[]) => {
      const paths = files
        .map(file => {
          try {
            return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
          } catch {
            return ''
          }
        })
        .filter(path => path.trim().length > 0)
      return ipcRenderer.invoke('devices:rockboxThemes:install', deviceId, paths) as Promise<RockboxThemeInstallResult>
    },
    deleteRockboxTheme: (deviceId: string, themeId: string) =>
      ipcRenderer.invoke('devices:rockboxThemes:delete', deviceId, themeId) as Promise<RockboxThemeDeleteResult>,
    listPendingJournals: () =>
      ipcRenderer.invoke('devices:listPendingJournals') as Promise<DevicePendingJournal[]>,
    resumeJournal: (journalId: string) =>
      ipcRenderer.invoke('devices:resumeJournal', journalId) as Promise<DeviceSyncApplyResult>,
    discardJournal: (journalId: string) =>
      ipcRenderer.invoke('devices:discardJournal', journalId) as Promise<void>,
    onScanProgress: (h) => subscribe<DeviceScanProgressEvent>('devices:scan:progress', h),
    onSyncProgress: (h) => subscribe<DeviceSyncProgressEvent>('devices:sync:progress', h),
    onVolumesChanged: (h) => subscribe<DeviceVolumeSnapshot>('devices:volumes-changed', h),
    onArtworkAnalyzeProgress: (h) =>
      subscribe<DeviceArtworkAnalysisProgressEvent>('devices:artwork-analyze:progress', h),
  },
  downloads: {
    getSettings: () =>
      ipcRenderer.invoke('downloads:settings:get') as Promise<DownloadSettings>,
    setSettings: (patch: Partial<DownloadSettings>) =>
      ipcRenderer.invoke('downloads:settings:set', patch) as Promise<DownloadSettings>,
    getAuthState: (provider: DownloadProvider) =>
      ipcRenderer.invoke('downloads:auth:get', provider) as Promise<ProviderAuthState>,
    saveCredentials: (payload: ProviderCredentialsPayload) =>
      ipcRenderer.invoke('downloads:credentials:save', payload) as Promise<void>,
    clearCredentials: (provider: DownloadProvider) =>
      ipcRenderer.invoke('downloads:credentials:clear', provider) as Promise<void>,
    inspectHar: (provider: DownloadProvider, files: unknown[]) => {
      const paths = files
        .map(file => {
          try {
            return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
          } catch {
            return ''
          }
        })
        .filter(path => path.trim().length > 0)
      return ipcRenderer.invoke('downloads:har:inspect', provider, paths) as Promise<HarImportPreview>
    },
    applyHarImport: (provider: DownloadProvider, previewId: string) =>
      ipcRenderer.invoke('downloads:har:apply', provider, previewId) as Promise<void>,
    getTutorialState: () =>
      ipcRenderer.invoke('downloads:tutorial:get') as Promise<ServiceTutorialState>,
    setTutorialState: (patch: Partial<ServiceTutorialState>) =>
      ipcRenderer.invoke('downloads:tutorial:set', patch) as Promise<ServiceTutorialState>,
    search: (payload: DownloadSearchRequest) =>
      ipcRenderer.invoke('downloads:search', payload) as Promise<OnlineTrackResult[]>,
    enqueue: (payload: EnqueueDownloadRequest) =>
      ipcRenderer.invoke('downloads:enqueue', payload) as Promise<DownloadJob[]>,
    jobs: () =>
      ipcRenderer.invoke('downloads:jobs') as Promise<DownloadJob[]>,
    cancel: (jobId: string) =>
      ipcRenderer.invoke('downloads:cancel', jobId) as Promise<void>,
    retry: (jobId: string) =>
      ipcRenderer.invoke('downloads:retry', jobId) as Promise<DownloadJob | null>,
    onProgress: (h) => subscribe<DownloadProgressEvent>('downloads:progress', h),
    onJobsChanged: (h) => subscribe<DownloadJobsChangedEvent>('downloads:jobs-changed', h),
  },
  cloud: {
    accountStatus: () =>
      ipcRenderer.invoke('cloud:account:status') as Promise<CloudAccountStatus>,
    connect: () =>
      ipcRenderer.invoke('cloud:account:connect') as Promise<CloudAccountStatus>,
    disconnect: () =>
      ipcRenderer.invoke('cloud:account:disconnect') as Promise<CloudAccountStatus>,
    setClientId: (clientId: string) =>
      ipcRenderer.invoke('cloud:account:setClientId', clientId) as Promise<CloudAccountStatus>,
    getPrefs: () =>
      ipcRenderer.invoke('cloud:prefs:get') as Promise<CloudPrefs>,
    setPrefs: (patch: Partial<CloudPrefs>) =>
      ipcRenderer.invoke('cloud:prefs:set', patch) as Promise<CloudPrefs>,
    listRemoteFolders: (driveId: string | null, itemId: string | null) =>
      ipcRenderer.invoke('cloud:folders:listRemote', driveId, itemId) as Promise<RemoteFolderEntry[]>,
    addFolder: (driveId: string, itemId: string, name: string, remotePath?: string) =>
      ipcRenderer.invoke('cloud:folders:add', driveId, itemId, name, remotePath) as Promise<CloudFolderRef>,
    syncFolder: (folderId: number) =>
      ipcRenderer.invoke('cloud:folders:sync', folderId) as Promise<void>,
    moveToCloud: (req: MoveToCloudRequest) =>
      ipcRenderer.invoke('cloud:track:moveToCloud', req) as Promise<void>,
    onAccountChanged: (h) => subscribe<CloudAccountStatus>('cloud:account:changed', h),
    onSyncProgress: (h) => subscribe<CloudSyncProgressEvent>('cloud:sync:progress', h),
    onMoveProgress: (h) => subscribe<CloudMoveProgressEvent>('cloud:move:progress', h),
  },
  libraryLocations: {
    list: () =>
      ipcRenderer.invoke('library-locations:list') as Promise<LibraryLocation[]>,
    pickLocal: () =>
      ipcRenderer.invoke('library-locations:pick-local') as Promise<PickFolderResult>,
    addLocal: (input: AddLocalLibraryLocationRequest) =>
      ipcRenderer.invoke('library-locations:add-local', input) as Promise<LibraryLocation>,
    requestLocalAccess: (folderId: number) =>
      ipcRenderer.invoke('library-locations:request-local-access', folderId),
    openFilePrivacySettings: () =>
      ipcRenderer.invoke('library-locations:open-file-privacy-settings') as Promise<void>,
    getOneDriveStatus: () =>
      ipcRenderer.invoke('cloud:account:status') as Promise<CloudAccountStatus>,
    setOneDriveClientId: (clientId: string) =>
      ipcRenderer.invoke('cloud:account:setClientId', clientId) as Promise<CloudAccountStatus>,
    connectOneDrive: () =>
      ipcRenderer.invoke('cloud:account:connect') as Promise<CloudAccountStatus>,
    disconnectOneDrive: () =>
      ipcRenderer.invoke('cloud:account:disconnect') as Promise<CloudAccountStatus>,
    listOneDriveFolders: (driveId: string | null, itemId: string | null) =>
      ipcRenderer.invoke('cloud:folders:listRemote', driveId, itemId) as Promise<RemoteFolderEntry[]>,
    addOneDrive: (input: AddOneDriveLibraryLocationRequest) =>
      ipcRenderer.invoke('library-locations:add-onedrive', input) as Promise<LibraryLocation>,
    updatePresentation: (folderId: number, input: { name: string; displayIcon: string | null }) =>
      ipcRenderer.invoke('library-locations:update-presentation', folderId, input) as Promise<LibraryLocation>,
    remove: (folderId: number) =>
      ipcRenderer.invoke('library-locations:remove', folderId) as Promise<void>,
  },
  libraryBackups: {
    list: () =>
      ipcRenderer.invoke('library-backups:list') as Promise<LibraryBackupStatePayload[]>,
    assign: (input: { sourceFolderId: number; backupFolderId: number }) =>
      ipcRenderer.invoke('library-backups:assign', input) as Promise<LibraryBackupStatePayload>,
    remove: (backupFolderId: number) =>
      ipcRenderer.invoke('library-backups:remove', backupFolderId) as Promise<void>,
    promote: (backupFolderId: number) =>
      ipcRenderer.invoke('library-backups:promote', backupFolderId) as Promise<LibraryLocation>,
    start: (backupFolderId: number) =>
      ipcRenderer.invoke('library-backups:start', backupFolderId) as Promise<LibraryBackupStatePayload>,
    pause: (backupFolderId: number) =>
      ipcRenderer.invoke('library-backups:pause', backupFolderId) as Promise<LibraryBackupStatePayload>,
    resume: (backupFolderId: number) =>
      ipcRenderer.invoke('library-backups:resume', backupFolderId) as Promise<LibraryBackupStatePayload>,
    approveDiff: (backupFolderId: number, runId: string) =>
      ipcRenderer.invoke('library-backups:approve-diff', { backupFolderId, runId }) as Promise<LibraryBackupStatePayload>,
    onProgress: (h) => subscribe<BackupProgressEvent>('library-backups:progress', h),
  },
  libraryMigrations: {
    list: () =>
      ipcRenderer.invoke('library-migrations:list') as Promise<LibraryMigrationState[]>,
    create: (input: CreateLibraryMigrationRequest) =>
      ipcRenderer.invoke('library-migrations:create', input) as Promise<LibraryMigrationState>,
    approve: (runId: string) =>
      ipcRenderer.invoke('library-migrations:approve', runId) as Promise<LibraryMigrationState>,
    pause: (runId: string) =>
      ipcRenderer.invoke('library-migrations:pause', runId) as Promise<LibraryMigrationState>,
    resume: (runId: string) =>
      ipcRenderer.invoke('library-migrations:resume', runId) as Promise<LibraryMigrationState>,
    cancel: (runId: string) =>
      ipcRenderer.invoke('library-migrations:cancel', runId) as Promise<LibraryMigrationState>,
    retryCleanup: (runId: string) =>
      ipcRenderer.invoke('library-migrations:retry-cleanup', runId) as Promise<LibraryMigrationState>,
    onProgress: h => subscribe<LibraryMigrationProgressEvent>('library-migrations:progress', h),
  },
  folderCleanup: {
    pending: () =>
      ipcRenderer.invoke('folder-cleanup:pending') as Promise<FolderCleanupProposal[]>,
    confirm: (proposalId: string) =>
      ipcRenderer.invoke('folder-cleanup:confirm', proposalId) as Promise<FolderCleanupConfirmResult>,
    dismiss: (proposalId: string) =>
      ipcRenderer.invoke('folder-cleanup:dismiss', proposalId) as Promise<void>,
    onEvent: h => subscribe<FolderCleanupEvent>('folder-cleanup:event', h),
  },
  updates: {
    getState: () =>
      ipcRenderer.invoke('app:update:getState') as Promise<AppUpdateState>,
    checkNow: () =>
      ipcRenderer.invoke('app:update:check') as Promise<AppUpdateState>,
    download: () =>
      ipcRenderer.invoke('app:update:download') as Promise<AppUpdateState>,
    install: () =>
      ipcRenderer.invoke('app:update:install') as Promise<void>,
    onStateChanged: (h) => subscribe<AppUpdateState>('app:update-state', h),
  },
}

contextBridge.exposeInMainWorld('api', api)
