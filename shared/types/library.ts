// Shared TypeScript types for the music library.
// These mirror the GRDB schema in the legacy Swift app and are designed
// to be persisted to SQLite via better-sqlite3 in later phases.

export type AudioFormat = 'FLAC' | 'M4A' | 'MP3' | 'WAV' | 'AIFF' | 'OGG' | 'OPUS' | 'APE' | 'DSF' | 'DFF' | string

export type CodecTier = 'low' | 'mid' | 'high' | 'cd' | 'studio' | 'master' | 'ref'

export type Pattern = 'circles' | 'sun' | 'rays' | 'grid' | 'wave' | 'stripes' | 'rings' | 'half' | 'diag' | 'lines'

export interface Track {
  id: string
  dbId?: number          // numeric primary key in the SQLite tracks table
  path?: string          // filesystem path for the audio engine to load
  t: string              // title
  d: number              // duration seconds
  fmt: AudioFormat
  q: string              // quality string (e.g. "24/96", "AAC 256", "320k", "ALAC")
  plays: number
  albumId: string
  albumTitle: string
  artist: string
  artistId: string
  year: number
  genre: string
  no: number             // track number
  added: string
  loved: boolean
  artworkPath?: string   // filename under userData/artwork/, served via hifi://
}

export interface Album {
  id: string
  title: string
  artist: string
  year: number
  seed: number
  palette: [string, string, string]
  pattern: Pattern
  genre: string
  tracks: Track[]
  artworkPath?: string  // filename under userData/artwork/, served via hifi://
}

export interface Artist {
  id: string
  name: string
  albums: Album[]
  seed: number
  palette: [string, string, string]
  pattern: Pattern
  bio?: string
}

export type PlaylistKind = 'manual' | 'smart'

export interface Playlist {
  id: string
  name: string
  count: number
  kind: PlaylistKind
  icon: string
  desc?: string
  tracks: Track[]
}

export interface NowPlayingState {
  track: Track
  progress: number     // 0..1
  volume: number       // 0..1
  queue: Track[]
  history: Track[]
}

export interface Library {
  albums: Album[]
  tracks: Track[]
  artists: Artist[]
  playlists: Playlist[]
  nowPlaying: NowPlayingState
  stats: {
    tracks: number
    albums: number
    artists: number
    hours: number
  }
}
