import { extname } from 'node:path'
import type { TrackMetadata } from '../library/MetadataExtractor.ts'
import type { DriveItem } from './OneDriveClient.ts'

function inferFormat(name: string): string {
  return extname(name).slice(1).toUpperCase() || 'AUDIO'
}

export function audioFacetToMetadata(item: DriveItem): TrackMetadata {
  const audio = item.audio ?? {}
  const name = item.name ?? 'Unknown'
  const fallbackTitle = name.replace(/\.[^.]+$/, '')
  const duration = typeof audio.duration === 'number' && audio.duration > 0
    ? audio.duration / 1000
    : 0
  const fileSize = typeof item.size === 'number' ? item.size : null

  return {
    title: audio.title?.trim() || fallbackTitle,
    artist: audio.artist?.trim() || 'Unknown Artist',
    album: audio.album?.trim() || 'Unknown Album',
    albumArtist: audio.albumArtist?.trim() || null,
    composer: audio.composers ?? '',
    genre: audio.genre ?? '',
    year: audio.year == null ? '' : String(audio.year),
    trackNumber: typeof audio.track === 'number' ? audio.track : null,
    totalTracks: typeof audio.trackCount === 'number' ? audio.trackCount : null,
    discNumber: typeof audio.disc === 'number' ? audio.disc : null,
    totalDiscs: typeof audio.discCount === 'number' ? audio.discCount : null,
    duration,
    format: inferFormat(name),
    codec: null,
    bitrate: fileSize && duration > 0 ? Math.round((fileSize * 8) / duration) : null,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    fileSize,
    bpm: null,
    musicalKey: null,
    dateModified: item.lastModifiedDateTime ?? null,
    artwork: null,
    replayGainTrack: null,
    replayGainAlbum: null,
    isCompilation: false,
    releaseDate: null,
    originalReleaseDate: null,
    releaseTypes: [],
    mediaType: null,
    musicbrainzRecordingId: null,
    musicbrainzTrackId: null,
    musicbrainzAlbumId: null,
    musicbrainzReleaseGroupId: null,
    musicbrainzArtistIds: [],
    musicbrainzAlbumArtistIds: [],
  }
}

export function driveItemRemotePath(item: DriveItem): string {
  const parent = item.parentReference?.path?.replace(/^.*root:/, '') ?? ''
  return `${parent}/${item.name ?? ''}`.replace(/\/{2,}/g, '/') || '/'
}
