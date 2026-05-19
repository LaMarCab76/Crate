// IPC contract between main and renderer. Mirrors the handlers registered in
// electron/main/ipc/library-channel.ts and the bridge in electron/preload/index.ts.

import type { DbAlbum, DbArtist, DbFolder, DbGenre, DbPlaylist, DbTrack } from './db'

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

export interface PickFolderResult {
  canceled: boolean
  path: string | null
}

export interface LibraryApi {
  tracks(opts?: ListTracksOpts): Promise<DbTrack[]>
  trackById(id: number): Promise<DbTrack | null>
  albums(): Promise<DbAlbum[]>
  albumById(id: number): Promise<DbAlbum | null>
  albumTracks(id: number): Promise<DbTrack[]>
  artists(): Promise<DbArtist[]>
  artistById(id: number): Promise<DbArtist | null>
  artistTracks(id: number): Promise<DbTrack[]>
  genres(): Promise<DbGenre[]>
  genreTracks(id: number): Promise<DbTrack[]>
  playlists(): Promise<DbPlaylist[]>
  playlistTracks(id: number): Promise<DbTrack[]>
  search(query: string, limit?: number): Promise<SearchResultsPayload>
  folders(): Promise<DbFolder[]>
  pickFolder(): Promise<PickFolderResult>
  addFolder(path: string): Promise<AddFolderResult>
  removeFolder(id: number): Promise<void>
  trackCount(): Promise<number>
}

export interface MetaApi {
  version: string
}

export interface Api {
  meta: MetaApi
  library: LibraryApi
}

declare global {
  interface Window {
    api: Api
  }
}
