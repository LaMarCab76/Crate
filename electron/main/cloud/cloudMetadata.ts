import { extname } from 'node:path'
import type { DriveItem } from './OneDriveClient'
import type { TrackMetadata } from '../library/MetadataExtractor'

// Map a Graph driveItem's `audio` facet into the app's TrackMetadata for the fast
// indexing pass (no byte download). Phase 5 overwrites these with accurate tags
// parsed from the real file header. Kept pure (type-only imports) for testability.

function inferFormatFromName(name: string): string {
  const ext = extname(name).slice(1).toUpperCase()
  return ext || 'AUDIO'
}

export function audioFacetToMetadata(item: DriveItem): TrackMetadata {
  const a = item.audio ?? {}
  const name = item.name ?? 'Unknown'
  const fallbackTitle = name.replace(/\.[^.]+$/, '')
  const durationSec = typeof a.duration === 'number' && a.duration > 0 ? Math.round(a.duration / 1000) : 0
  const sizeBytes = typeof item.size === 'number' ? item.size : null
  // Overall bitrate estimate from size/duration (the facet's own bitrate unit is
  // unreliable); Phase 5 replaces it with the true value from the decoded header.
  const estBitrate = sizeBytes && durationSec > 0 ? Math.round((sizeBytes * 8) / durationSec) : null

  return {
    title: (a.title || fallbackTitle).trim() || fallbackTitle,
    artist: (a.artist || 'Unknown Artist').trim() || 'Unknown Artist',
    album: (a.album || 'Unknown Album').trim() || 'Unknown Album',
    albumArtist: a.albumArtist?.trim() || null,
    composer: a.composers ?? '',
    genre: a.genre ?? '',
    year: a.year != null ? String(a.year) : '',
    trackNumber: typeof a.track === 'number' ? a.track : null,
    totalTracks: typeof a.trackCount === 'number' ? a.trackCount : null,
    discNumber: typeof a.disc === 'number' ? a.disc : null,
    totalDiscs: typeof a.discCount === 'number' ? a.discCount : null,
    duration: durationSec,
    format: inferFormatFromName(name),
    codec: null,
    bitrate: estBitrate,
    sampleRate: null,
    bitDepth: null,
    channels: null,
    fileSize: sizeBytes,
    bpm: null,
    musicalKey: null,
    dateModified: item.lastModifiedDateTime ?? null,
    artwork: null,
    replayGainTrack: null,
    replayGainAlbum: null,
    isCompilation: false,
  }
}
