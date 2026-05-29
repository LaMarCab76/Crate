import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AddFolderResult,
  Api,
  BufferProgressEvent,
  EqState,
  EventOff,
  ExclusiveModeState,
  FftEvent,
  FftMode,
  ImportCompleteEvent,
  ImportProgressEvent,
  LevelsEvent,
  LibraryScanLogPayload,
  LibraryScanRun,
  ListTracksOpts,
  MetadataCompletionApplyRequest,
  MetadataCompletionApplyResult,
  MetadataCompletionPreview,
  MetadataCompletionTargetsPayload,
  PickFolderResult,
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
  TrackMetadataUpdatePayload,
  TrashTracksResult,
} from '@shared/types/ipc-contract'
import type {
  DeviceCandidate,
  DeviceConnectPayload,
  DeviceLibraryResult,
  DeviceMusicRootPickResult,
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

function subscribe<T>(channel: string, handler: (payload: T) => void): EventOff {
  const listener = (_event: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: Api = {
  meta: {
    version: '2.0.0-alpha.3',
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
    addFolder: (path: string) =>
      ipcRenderer.invoke('library:folders:add', path) as Promise<AddFolderResult>,
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
    load: (path: string, trackId?: number | null) =>
      ipcRenderer.invoke('audio:load', { path, trackId: trackId ?? null }) as Promise<StreamLoadResult>,
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
    getWaveform: (path: string, buckets?: number, trackId?: number | null) =>
      ipcRenderer.invoke('audio:getWaveform', { path, buckets, trackId: trackId ?? null }) as Promise<PlaybackAnalysisResult>,
    getCachedAnalysis: (path: string, buckets?: number, trackId?: number | null) =>
      ipcRenderer.invoke('audio:getCachedAnalysis', { path, buckets, trackId: trackId ?? null }) as Promise<PlaybackAnalysisResult | null>,
    ensurePlaybackAnalysis: (path: string, trackId?: number | null, buckets?: number) =>
      ipcRenderer.invoke('audio:ensurePlaybackAnalysis', { path, trackId: trackId ?? null, buckets }) as Promise<PlaybackAnalysisResult>,
    getCachedTableBars: (path: string, trackId?: number | null) =>
      ipcRenderer.invoke('audio:getCachedTableBars', { path, trackId: trackId ?? null }) as Promise<PlaybackTableBarsResult | null>,
    ensureTableBars: (path: string, trackId?: number | null) =>
      ipcRenderer.invoke('audio:ensureTableBars', { path, trackId: trackId ?? null }) as Promise<PlaybackTableBarsResult>,
    getPlaybackCacheStats: () =>
      ipcRenderer.invoke('audio:playbackCache:stats') as Promise<PlaybackCacheStats>,
    setPlaybackCacheLimit: (maxBytes: number) =>
      ipcRenderer.invoke('audio:playbackCache:setLimit', { maxBytes }) as Promise<PlaybackCacheStats>,
    clearPlaybackCache: () =>
      ipcRenderer.invoke('audio:playbackCache:clear') as Promise<PlaybackCacheStats>,
    preloadNext: (path: string, trackId?: number | null) =>
      ipcRenderer.invoke('audio:preloadNext', { path, trackId: trackId ?? null }) as Promise<PreloadNextResult>,
    clearNext: () => ipcRenderer.invoke('audio:clearNext') as Promise<void>,
    swapNow: (expectedPath?: string | null) =>
      ipcRenderer.invoke('audio:swapNow', { expectedPath: expectedPath ?? null }) as Promise<StreamLoadResult | null>,
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
    previewBand: (index: number, gain: number) =>
      ipcRenderer.invoke('eq:previewBand', { index, gain }) as Promise<void>,
    setPreset: (name: string) =>
      ipcRenderer.invoke('eq:setPreset', { name }) as Promise<void>,
    presets: () => ipcRenderer.invoke('eq:presets') as Promise<string[]>,
    onChanged: (h) => subscribe<EqState>('eq:changed', h),
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
  },
  devices: {
    detectCandidates: () =>
      ipcRenderer.invoke('devices:detectCandidates') as Promise<DeviceCandidate[]>,
    volumes: () =>
      ipcRenderer.invoke('devices:volumes') as Promise<DeviceVolumeSnapshot>,
    ignoreVolume: (rootPath: string) =>
      ipcRenderer.invoke('devices:volumes:ignore', rootPath) as Promise<DeviceVolumeSnapshot>,
    pickRoot: () =>
      ipcRenderer.invoke('devices:pickRoot') as Promise<PickFolderResult>,
    pickMusicRoot: (rootPath: string, currentMusicRoot?: string) =>
      ipcRenderer.invoke('devices:pickMusicRoot', rootPath, currentMusicRoot) as Promise<DeviceMusicRootPickResult>,
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
    library: (deviceId: string) =>
      ipcRenderer.invoke('devices:library', deviceId) as Promise<DeviceLibraryResult>,
    rockboxThemes: (deviceId: string) =>
      ipcRenderer.invoke('devices:rockboxThemes', deviceId) as Promise<RockboxThemeLibraryResult>,
    planSync: (payload: DeviceSyncPlanRequest) =>
      ipcRenderer.invoke('devices:planSync', payload) as Promise<DeviceSyncPlan>,
    applySync: (planId: string, selection?: DeviceSyncApplySelection) =>
      ipcRenderer.invoke('devices:applySync', planId, selection) as Promise<DeviceSyncApplyResult>,
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
}

contextBridge.exposeInMainWorld('api', api)
