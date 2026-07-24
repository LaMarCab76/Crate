import type { LibraryProvider, LibraryRole } from '@shared/types/library-locations'

export interface DuplicateTrackFacts {
  id: number
  folderId: number
  provider: LibraryProvider
  libraryRole: LibraryRole
  libraryName: string
  path: string
  filename: string
  title: string
  artist: string
  primaryArtist: string | null
  album: string
  albumArtist: string | null
  year: string
  duration: number
  trackNumber: number | null
  discNumber: number | null
  format: string
  codec: string | null
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  fileSize: number | null
  dateModified: string | null
  artworkPath: string | null
  dateAdded: string
  compilation: boolean
  albumCompilation: boolean
  releaseType: string | null
  mediaType: string | null
  musicBrainzRecordingId: string | null
  musicBrainzReleaseId: string | null
  musicBrainzReleaseGroupId: string | null
  /** True only for advisory, non-persisted MusicBrainz lookup results. */
  musicBrainzInferred?: boolean
  driveId: string | null
  itemId: string | null
  etag: string | null
}
