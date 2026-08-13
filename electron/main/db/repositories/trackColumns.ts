import type { DbTrack } from '@shared/types/db'

// Keep every repository that returns a DbTrack on the same projection. When
// DbTrack grows, the coverage assertion below makes typecheck fail until this
// list is updated, rather than silently returning undefined for new fields.
export const DB_TRACK_COLUMN_NAMES = [
  'id',
  'path',
  'filename',
  'title',
  'artist',
  'album',
  'duration',
  'format',
  'folder_id',
  'file_size',
  'date_modified',
  'album_artist',
  'composer',
  'genre',
  'year',
  'is_favorite',
  'play_count',
  'last_played_date',
  'rating',
  'track_number',
  'total_tracks',
  'disc_number',
  'total_discs',
  'compilation',
  'release_date',
  'original_release_date',
  'bpm',
  'musical_key',
  'media_type',
  'sort_title',
  'sort_artist',
  'sort_album',
  'sort_album_artist',
  'bitrate',
  'sample_rate',
  'channels',
  'codec',
  'bit_depth',
  'artwork_data',
  'artwork_path',
  'date_added',
  'is_duplicate',
  'primary_track_id',
  'duplicate_group_id',
  'extended_metadata',
  'album_id',
  'artist_id',
  'genre_id',
  'r128_integrated_loudness',
  'state_updated_at',
  'provider',
  'drive_id',
  'item_id',
  'etag',
  'remote_path',
  'quickxor_hash',
] as const satisfies readonly (keyof DbTrack)[]

type MissingDbTrackColumn = Exclude<keyof DbTrack, typeof DB_TRACK_COLUMN_NAMES[number]>
type AssertCompleteDbTrackProjection<T extends never> = T
export type DbTrackProjectionCoverage = AssertCompleteDbTrackProjection<MissingDbTrackColumn>

export function dbTrackSelectColumns(alias?: string): string {
  return DB_TRACK_COLUMN_NAMES
    .map(column => alias ? `${alias}.${column}` : column)
    .join(', ')
}
