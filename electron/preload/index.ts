import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AddFolderResult,
  Api,
  EqState,
  EventOff,
  FftEvent,
  FftMode,
  ImportCompleteEvent,
  ImportProgressEvent,
  ListTracksOpts,
  LyricsForTrack,
  PickFolderResult,
  PlaybackStatePayload,
  PlaybackStatus,
  ProgressEvent,
  QueueSnapshotPayload,
  SearchResultsPayload,
  StreamInfoPayload,
} from '@shared/types/ipc-contract'
import type {
  DbAlbum,
  DbArtist,
  DbFolder,
  DbGenre,
  DbLyrics,
  DbPlaylist,
  DbTrack,
} from '@shared/types/db'

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
    removeFolder: (id: number) =>
      ipcRenderer.invoke('library:folders:remove', id) as Promise<void>,

    onImportProgress: (h) => subscribe<ImportProgressEvent>('library:import:progress', h),
    onImportComplete: (h) => subscribe<ImportCompleteEvent>('library:import:complete', h),
    onLibraryChanged: (h) => subscribe<void>('library:changed', () => h()),
  },
  queue: {
    save: (payload: QueueSnapshotPayload) =>
      ipcRenderer.invoke('queue:save', payload) as Promise<void>,
    load: () => ipcRenderer.invoke('queue:load') as Promise<QueueSnapshotPayload>,
  },
  lyrics: {
    get: (trackId: number) => ipcRenderer.invoke('lyrics:get', trackId) as Promise<DbLyrics | null>,
    set: (trackId: number, lrcContent: string, source?: string | null, language?: string | null) =>
      ipcRenderer.invoke('lyrics:set', {
        trackId,
        lrcContent,
        source: source ?? null,
        language: language ?? null,
      }) as Promise<void>,
    getForTrack: (trackId: number) =>
      ipcRenderer.invoke('lyrics:getForTrack', trackId) as Promise<LyricsForTrack | null>,
  },
  audio: {
    load: (path: string, trackId?: number | null) =>
      ipcRenderer.invoke('audio:load', { path, trackId: trackId ?? null }) as Promise<StreamInfoPayload | null>,
    play: () => ipcRenderer.invoke('audio:play') as Promise<void>,
    pause: () => ipcRenderer.invoke('audio:pause') as Promise<void>,
    stop: () => ipcRenderer.invoke('audio:stop') as Promise<void>,
    seek: (positionSec: number) =>
      ipcRenderer.invoke('audio:seek', { positionSec }) as Promise<void>,
    setVolume: (value: number) =>
      ipcRenderer.invoke('audio:setVolume', { value }) as Promise<void>,
    setFftMode: (mode: FftMode) =>
      ipcRenderer.invoke('audio:setFftMode', { mode }) as Promise<void>,
    preloadNext: (path: string) =>
      ipcRenderer.invoke('audio:preloadNext', { path }) as Promise<void>,
    clearNext: () => ipcRenderer.invoke('audio:clearNext') as Promise<void>,
    swapNow: () => ipcRenderer.invoke('audio:swapNow') as Promise<boolean>,
    getStatus: () => ipcRenderer.invoke('audio:getStatus') as Promise<PlaybackStatePayload>,
    listOutputDevices: () => ipcRenderer.invoke('audio:devices:list'),
    setOutputDevice: (deviceId: number) =>
      ipcRenderer.invoke('audio:devices:set', { deviceId }),
    getOutputDevice: () => ipcRenderer.invoke('audio:devices:current'),
    onProgress: (h) => subscribe<ProgressEvent>('audio:progress', h),
    onTrackEnded: (h) => subscribe<void>('audio:track-ended', () => h()),
    onGaplessFired: (h) => subscribe<{ path: string }>('audio:gapless-fired', h),
    onStateChanged: (h) => subscribe<{ status: PlaybackStatus }>('audio:state-changed', h),
    onFft: (h) => subscribe<FftEvent>('audio:fft', h),
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
    refreshMetadata: (trackId: number) =>
      ipcRenderer.invoke('track:refreshMetadata', trackId) as Promise<void>,
  },
  artists: {
    setFavorite: (id: number, favorite: boolean) =>
      ipcRenderer.invoke('artist:setFavorite', { id, favorite }) as Promise<void>,
  },
  settings: {
    setLibraryBackup: (enabled: boolean) =>
      ipcRenderer.invoke('settings:setLibraryBackup', enabled) as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('api', api)
