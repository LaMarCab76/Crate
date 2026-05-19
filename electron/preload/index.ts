import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddFolderResult,
  Api,
  ListTracksOpts,
  PickFolderResult,
  SearchResultsPayload,
} from '@shared/types/ipc-contract'
import type {
  DbAlbum,
  DbArtist,
  DbFolder,
  DbGenre,
  DbPlaylist,
  DbTrack,
} from '@shared/types/db'

const api: Api = {
  meta: {
    version: '2.0.0-alpha.2',
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
    playlistTracks: (id: number) =>
      ipcRenderer.invoke('library:playlist:tracks', id) as Promise<DbTrack[]>,
    search: (query: string, limit?: number) =>
      ipcRenderer.invoke('library:search', query, limit) as Promise<SearchResultsPayload>,
    folders: () => ipcRenderer.invoke('library:folders') as Promise<DbFolder[]>,
    pickFolder: () => ipcRenderer.invoke('library:folders:pick') as Promise<PickFolderResult>,
    addFolder: (path: string) =>
      ipcRenderer.invoke('library:folders:add', path) as Promise<AddFolderResult>,
    removeFolder: (id: number) =>
      ipcRenderer.invoke('library:folders:remove', id) as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('api', api)
