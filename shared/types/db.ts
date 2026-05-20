// Row types that mirror the SQLite schema 1:1 (snake_case columns).
// Repositories return these; the renderer adapts to the UI types in
// shared/types/library.ts via a thin mapping layer.

export interface DbFolder {
  id: number
  name: string
  path: string
  track_count: number
  date_added: string
  date_updated: string
  bookmark_data: Buffer | null
}

export interface DbAlbum {
  id: number
  title: string
  normalized_name: string
  sort_name: string
  album_artist: string | null
  year: string | null
  release_type: string | null
  record_label: string | null
  disc_count: number
  musicbrainz_album_id: string | null
  release_date: string | null
  musicbrainz_release_group_id: string | null
  barcode: string | null
  catalog_number: string | null
  release_country: string | null
  track_count: number
  total_duration: number
  is_compilation: number
  artwork_data: Buffer | null
  artwork_path: string | null
  date_added: string
  is_favorite: number
  state_updated_at: number | null
}

export interface DbArtist {
  id: number
  name: string
  normalized_name: string
  sort_name: string
  musicbrainz_artist_id: string | null
  artist_type: string | null
  country: string | null
  track_count: number
  album_count: number
  artwork_data: Buffer | null
  artwork_source_type: string | null
  artwork_path: string | null
  date_added: string
  is_favorite: number
  state_updated_at: number | null
}

export interface DbGenre {
  id: number
  name: string
  normalized_name: string
  sort_name: string
  style: string | null
  track_count: number
  date_added: string
}

export interface DbTrack {
  id: number
  path: string
  filename: string
  title: string
  artist: string
  album: string
  duration: number
  format: string
  folder_id: number
  file_size: number | null
  date_modified: string | null
  album_artist: string | null
  composer: string
  genre: string
  year: string
  is_favorite: number
  play_count: number
  last_played_date: string | null
  rating: number | null
  track_number: number | null
  total_tracks: number | null
  disc_number: number | null
  total_discs: number | null
  compilation: number
  release_date: string | null
  original_release_date: string | null
  bpm: number | null
  musical_key: string | null
  media_type: string | null
  sort_title: string | null
  sort_artist: string | null
  sort_album: string | null
  sort_album_artist: string | null
  bitrate: number | null
  sample_rate: number | null
  channels: number | null
  codec: string | null
  bit_depth: number | null
  artwork_data: Buffer | null
  artwork_path: string | null
  date_added: string
  is_duplicate: number
  primary_track_id: number | null
  duplicate_group_id: string | null
  extended_metadata: string | null
  album_id: number | null
  artist_id: number | null
  genre_id: number | null
  r128_integrated_loudness: number | null
  state_updated_at: number | null
}

export interface DbPlaylist {
  id: number
  name: string
  description: string | null
  created_date: string
  modified_date: string
  track_count: number
  total_duration: number
  custom_artwork_data: Buffer | null
  color_scheme: string | null
  is_favorite: number
  sort_order: number
  is_smart: number
  date_last_played: string | null
  play_count: number
}

export interface DbPlaylistTrack {
  id: number
  playlist_id: number
  track_id: number
  position: number
  date_added: string
}

export interface DbQueueEntry {
  id: number
  track_id: number
  position: number
}

// Input shapes for insert operations (omit auto-generated columns).
export type DbTrackInsert = Omit<DbTrack, 'id'>
export type DbFolderInsert = Omit<DbFolder, 'id' | 'track_count'> & { track_count?: number }
export type DbAlbumInsert = Omit<DbAlbum, 'id' | 'track_count' | 'total_duration' | 'is_favorite' | 'state_updated_at'>
export type DbArtistInsert = Omit<DbArtist, 'id' | 'track_count' | 'album_count'>
export type DbGenreInsert = Omit<DbGenre, 'id' | 'track_count'>
