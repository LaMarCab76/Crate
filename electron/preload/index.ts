import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AddFolderResult,
  Api,
  EventOff,
  ImportCompleteEvent,
  ImportProgressEvent,
  ListTracksOpts,
  PickFolderResult,
  QueueSnapshotPayload,
  SearchResultsPayload,
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
  },
}

contextBridge.exposeInMainWorld('api', api)
