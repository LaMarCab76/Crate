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
  // Cached fetch with LRCLIB fallback. Use this from UI; `get` is the raw DB read.
  getForTrack(trackId: number): Promise<LyricsForTrack | null>
}

export interface MetaApi {
  version: string
}

export type PlaybackStatus = 'stopped' | 'playing' | 'paused' | 'loading'
export type FftMode = 'off' | 'mini' | 'full' | 'screen'
export type EqPreviewScope = 'global' | 'override'

export interface StreamInfoPayload {
  freq: number
  chans: number
  ctype: number
  duration: number
  durationBytes: number
  bytesPerSecond: number
}

export interface ProgressEvent {
  positionSec: number
  durationSec: number
}

export interface PlaybackStatePayload {
  status: PlaybackStatus
  positionSec: number
  streamInfo: StreamInfoPayload | null
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
}

export interface EqState {
  enabled: boolean
  preset: string
  bands: number[]              // global EQ gains in dB
  overrideBands: number[] | null  // null when no per-track override is active
}

export interface EqTrackOverride {
  enabled: boolean
  bands: number[]              // EQ gains in dB
}

export interface FftEvent {
  bins: number[]               // ~64 log-spaced amplitude bins, 0..1
}

export interface LyricsForTrack {
  trackId: number
  lrcContent: string           // either raw LRC (with [mm:ss.xx]) or plain text
  source: string | null
  language: string | null
  synced: boolean
}

export interface ArtistListMode {
  mode: 'manual' | 'topPlays'
  n?: number
}

export interface AudioApi {
  load(path: string, trackId?: number | null): Promise<StreamInfoPayload | null>
  play(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  seek(positionSec: number): Promise<void>
  setVolume(value: number): Promise<void>
  setFftMode(mode: FftMode): Promise<void>
  preloadNext(path: string): Promise<void>
  clearNext(): Promise<void>
  swapNow(): Promise<boolean>
  setActiveTrack(trackId: number | null): Promise<void>
  getStatus(): Promise<PlaybackStatePayload>
  listOutputDevices(): Promise<AudioOutputDevice[]>
  setOutputDevice(deviceId: number): Promise<AudioOutputDevice>
  getOutputDevice(): Promise<AudioOutputDevice | null>

  onProgress(h: (e: ProgressEvent) => void): EventOff
  onTrackEnded(h: () => void): EventOff
  onGaplessFired(h: (e: { path: string }) => void): EventOff
  onStateChanged(h: (e: { status: PlaybackStatus }) => void): EventOff
  onFft(h: (e: FftEvent) => void): EventOff
}

export interface EqApi {
  getState(): Promise<EqState>
  setEnabled(enabled: boolean): Promise<void>
  setBand(index: number, gain: number): Promise<void>
  setBands(bands: number[]): Promise<void>
  previewBand(index: number, gain: number, scope: EqPreviewScope): Promise<void>
  setPreset(name: string): Promise<void>
  presets(): Promise<string[]>
  setTrackOverride(trackId: number, override: EqTrackOverride | null): Promise<void>
  getTrackOverride(trackId: number): Promise<EqTrackOverride | null>
  onChanged(h: (e: EqState) => void): EventOff
}

export interface TracksApi {
  countPlay(trackId: number): Promise<void>
  setFavorite(id: number, favorite: boolean): Promise<void>
  refreshMetadata(trackId: number): Promise<void>
}

export interface ArtistsApi {
  setFavorite(id: number, favorite: boolean): Promise<void>
}

export interface SettingsApi {
  // Pushes the renderer-side preference into main so the LibraryBackup
  // service can short-circuit writes when the user has disabled the feature.
  setLibraryBackup(enabled: boolean): Promise<void>
}

export interface Api {
  meta: MetaApi
  library: LibraryApi
  queue: QueueApi
  lyrics: LyricsApi
  audio: AudioApi
  eq: EqApi
  tracks: TracksApi
  artists: ArtistsApi
  settings: SettingsApi
}

declare global {
  interface Window {
    api: Api
  }
}
