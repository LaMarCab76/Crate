// IPC contract between main and renderer. Mirrors the handlers registered in
// electron/main/ipc/library-channel.ts and the bridge in electron/preload/index.ts.

import type { DbAlbum, DbArtist, DbFolder, DbGenre, DbLyrics, DbPlaylist, DbTrack } from './db'

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

export interface ImportProgressEvent {
  folderId: number
  scanned: number
  imported: number
  total: number
  phase: 'discovering' | 'scanning' | 'writing'
}

export interface ImportCompleteEvent {
  folderId: number
  totalImported: number
  total: number
}

export interface QueueSnapshotPayload {
  trackIds: number[]
  currentIndex: number
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
  addFolder(path: string): Promise<AddFolderResult>
  removeFolder(id: number): Promise<void>

  // Event subscriptions — handlers receive the payload and return an off() func.
  onImportProgress(h: (e: ImportProgressEvent) => void): EventOff
  onImportComplete(h: (e: ImportCompleteEvent) => void): EventOff
  onLibraryChanged(h: () => void): EventOff
}

export interface QueueApi {
  save(payload: QueueSnapshotPayload): Promise<void>
  load(): Promise<QueueSnapshotPayload>
}

export interface LyricsApi {
  get(trackId: number): Promise<DbLyrics | null>
  set(trackId: number, lrcContent: string, source?: string | null, language?: string | null): Promise<void>
}

export interface MetaApi {
  version: string
}

export interface Api {
  meta: MetaApi
  library: LibraryApi
  queue: QueueApi
  lyrics: LyricsApi
}

declare global {
  interface Window {
    api: Api
  }
}
