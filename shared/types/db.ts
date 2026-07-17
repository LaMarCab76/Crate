import type {
  BackupRunStatus,
  BackupTrigger,
  LibraryMigrationMode,
  LibraryMigrationSourceDisposition,
  LibraryMigrationStatus,
  LibraryProvider,
  LibraryRole,
} from './library-locations'

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
  provider: LibraryProvider
  role: LibraryRole
  backup_source_folder_id: number | null
  account_id: string | null
  drive_id: string | null
  item_id: string | null
  remote_path: string | null
  delta_cursor: string | null
  display_icon: string | null
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
  provider: LibraryProvider
  drive_id: string | null
  item_id: string | null
  etag: string | null
  remote_path: string | null
  quickxor_hash: string | null
}

export type DbMirrorEntryKind = 'file' | 'directory'
export type DbMirrorActionKind = 'create_directory' | 'copy_file' | 'delete_file' | 'delete_directory'
export type DbMirrorActionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused'

export interface DbLibraryMirrorRun {
  id: string
  source_folder_id: number
  backup_folder_id: number
  trigger: BackupTrigger
  status: BackupRunStatus
  source_root_identity: string | null
  backup_root_identity: string | null
  plan_summary_json: string | null
  divergence_json: string | null
  approved_at: string | null
  error: string | null
  created_at: string
  started_at: string | null
  updated_at: string
  completed_at: string | null
}

export interface DbLibraryMirrorSnapshot {
  backup_folder_id: number
  relative_path: string
  kind: DbMirrorEntryKind
  size: number
  sha256: string | null
  quickxor_hash: string | null
  source_etag: string | null
  destination_etag: string | null
  source_modified_at_ms: number | null
  destination_modified_at_ms: number | null
  run_id: string
  updated_at: string
}

export interface DbLibraryMirrorAction {
  id: string
  run_id: string
  ordinal: number
  kind: DbMirrorActionKind
  relative_path: string
  entry_json: string | null
  destination_etag: string | null
  requires_approval: number
  status: DbMirrorActionStatus
  bytes_total: number
  bytes_completed: number
  resume_state_json: string | null
  error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export type DbLibraryMigrationEntryStatus =
  | 'pending'
  | 'transferring'
  | 'transferred'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'paused'

export interface DbLibraryMigrationRun {
  id: string
  source_folder_id: number
  source_provider: LibraryProvider
  target_folder_id: number | null
  mode: LibraryMigrationMode
  source_role: LibraryRole
  source_disposition: LibraryMigrationSourceDisposition
  source_name: string
  source_path: string
  source_account_id: string | null
  source_drive_id: string | null
  source_item_id: string | null
  source_remote_path: string | null
  target_provider: LibraryProvider
  target_name: string
  target_path: string
  target_account_id: string | null
  target_drive_id: string | null
  target_item_id: string | null
  target_remote_path: string | null
  unified_backup_json: string | null
  status: LibraryMigrationStatus
  phase: string
  source_root_identity: string | null
  target_root_identity: string | null
  plan_summary_json: string | null
  conflicts_json: string | null
  error: string | null
  cleanup_error: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  committed_at: string | null
  completed_at: string | null
}

export interface DbLibraryMigrationEntry {
  id: string
  run_id: string
  ordinal: number
  kind: 'directory' | 'file'
  source_relative_path: string
  destination_relative_path: string
  source_entry_json: string
  destination_entry_json: string | null
  source_track_id: number | null
  canonical_track_id: number | null
  conflict: 'renamed' | 'identical' | null
  status: DbLibraryMigrationEntryStatus
  bytes_total: number
  bytes_completed: number
  resume_state_json: string | null
  published_entry_json: string | null
  error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
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
export type DbTrackInsert = Omit<
  DbTrack,
  'id' | 'provider' | 'drive_id' | 'item_id' | 'etag' | 'remote_path' | 'quickxor_hash'
> & Partial<Pick<DbTrack, 'provider' | 'drive_id' | 'item_id' | 'etag' | 'remote_path' | 'quickxor_hash'>>
export type DbFolderInsert = Omit<DbFolder, 'id' | 'track_count'> & { track_count?: number }
export type DbAlbumInsert = Omit<DbAlbum, 'id' | 'track_count' | 'total_duration' | 'is_favorite' | 'state_updated_at'>
export type DbArtistInsert = Omit<DbArtist, 'id' | 'track_count' | 'album_count'>
export type DbGenreInsert = Omit<DbGenre, 'id' | 'track_count'>
