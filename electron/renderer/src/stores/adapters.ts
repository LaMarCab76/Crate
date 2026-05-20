// Maps DB-shape rows from the main process to the UI-shape types currently
// consumed by views and components. The UI types pre-date the data layer, so
// for now we adapt at the store boundary rather than refactor every view.

import type { DbAlbum, DbArtist, DbGenre, DbPlaylist, DbTrack } from '@shared/types/db'
import type {
  Album,
  Artist,
  Pattern,
  Playlist,
  PlaylistKind,
  Track,
} from '@shared/types/library'

// UI-level genre type — not exported from the design types so we declare it here.
export interface UiGenre {
  id: string
  name: string
}

const PATTERNS: Pattern[] = ['circles', 'sun', 'rays', 'grid', 'wave', 'stripes', 'rings', 'half', 'diag', 'lines']

// Deterministic palette + pattern from any seed — keeps procedural artwork
// stable across renders even before we have real cover art on disk.
function palette(seed: number): [string, string, string] {
  const hue = seed * 37 % 360
  const c0 = `hsl(${hue}, 30%, 12%)`
  const c1 = `hsl(${(hue + 25) % 360}, 35%, 28%)`
  const c2 = `hsl(${(hue + 50) % 360}, 45%, 65%)`
  return [c0, c1, c2]
}

function toAlbumId(albumId: string): number {
  const rawId = albumId.startsWith('a') ? albumId.slice(1) : albumId
  const parsed = Number.parseInt(rawId, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function latestTrackAdded(album: Album): number {
  return album.tracks.reduce((max, track) => {
    if (!track.added) return max
    const ts = Date.parse(track.added)
    if (Number.isNaN(ts)) return max
    return Math.max(max, ts)
  }, Number.MIN_SAFE_INTEGER)
}

function sortAlbumsByFreshness(a: Album, b: Album): number {
  const yearDiff = b.year - a.year
  if (yearDiff !== 0) return yearDiff

  const aTrackTs = latestTrackAdded(a)
  const bTrackTs = latestTrackAdded(b)
  if (aTrackTs !== bTrackTs) return bTrackTs - aTrackTs

  return toAlbumId(b.id) - toAlbumId(a.id)
}
function patternFor(seed: number): Pattern {
  return PATTERNS[seed % PATTERNS.length]
}

// Build the "quality" string the CodecStrip component expects. Examples:
//   FLAC 24-bit / 96 kHz → "24/96"
//   ALAC 16-bit / 44.1   → "ALAC"
//   AAC 256 kbps         → "AAC 256"
//   MP3 320 kbps         → "320 kbps"
function buildQualityString(t: DbTrack): string {
  const codec = (t.codec ?? t.format ?? '').toUpperCase()
  const lossless = codec === 'FLAC' || codec === 'ALAC' || codec === 'WAV' || codec === 'AIFF'
  if (codec === 'FLAC' && t.bit_depth && t.sample_rate) {
    return `${t.bit_depth}/${Math.round(t.sample_rate / 1000)}`
  }
  if (codec === 'ALAC' || (lossless && t.bit_depth === 16)) {
    return 'ALAC'
  }
  if (codec === 'AAC' || codec === 'M4A') {
    const kbps = t.bitrate ? Math.round(t.bitrate / 1000) : 256
    return `AAC ${kbps}`
  }
  if (codec === 'MP3') {
    const kbps = t.bitrate ? Math.round(t.bitrate / 1000) : 320
    return `${kbps} kbps`
  }
  if (t.bit_depth && t.sample_rate) {
    return `${t.bit_depth}/${Math.round(t.sample_rate / 1000)}`
  }
  return codec || 'AUDIO'
}

function inferFormat(t: DbTrack): Track['fmt'] {
  const fmt = (t.format ?? '').toUpperCase()
  switch (fmt) {
    case 'FLAC':
    case 'MP3':
    case 'M4A':
    case 'WAV':
    case 'AIFF':
    case 'OGG':
    case 'OPUS':
    case 'APE':
    case 'DSF':
    case 'DFF':
      return fmt
    default:
      return fmt || 'AUDIO'
  }
}

export function dbToUiTrack(t: DbTrack): Track {
  return {
    id: `t${t.id}`,
    dbId: t.id,
    path: t.path,
    filename: t.filename,
    t: t.title,
    d: t.duration,
    fmt: inferFormat(t),
    q: buildQualityString(t),
    plays: t.play_count,
    albumId: t.album_id != null ? `a${t.album_id}` : `a-${t.album}`,
    albumTitle: t.album,
    artist: t.artist,
    artistId: t.artist_id != null ? `ar${t.artist_id}` : `ar-${t.artist}`,
    albumArtist: t.album_artist,
    composer: t.composer,
    year: parseInt(t.year || `${new Date(t.date_added).getFullYear()}`, 10) || 0,
    genre: t.genre,
    no: t.track_number ?? 0,
    totalTracks: t.total_tracks,
    discNumber: t.disc_number,
    totalDiscs: t.total_discs,
    added: t.date_added,
    dateModified: t.date_modified,
    loved: t.is_favorite === 1,
    fileSize: t.file_size,
    bpm: t.bpm,
    musicalKey: t.musical_key,
    codec: t.codec,
    bitrate: t.bitrate,
    sampleRate: t.sample_rate,
    channels: t.channels,
    bitDepth: t.bit_depth,
    loudness: t.r128_integrated_loudness ?? null,
    artworkPath: t.artwork_path ?? undefined,
  }
}

export function dbToUiAlbum(a: DbAlbum, tracks: Track[] = []): Album {
  const seed = a.id || 1
  // Prefer the album's own artwork_path, but fall back to the first track's
  // artwork — embedded covers are usually identical across an album anyway.
  const firstTrackArt = tracks.find(t => t.artworkPath)?.artworkPath
  return {
    id: `a${a.id}`,
    title: a.title,
    artist: a.album_artist ?? '',
    year: parseInt(a.year ?? '0', 10) || 0,
    added: a.date_added,
    seed,
    palette: palette(seed),
    pattern: patternFor(seed),
    genre: tracks[0]?.genre ?? '',
    tracks,
    favorite: a.is_favorite === 1,
    artworkPath: a.artwork_path ?? firstTrackArt,
  }
}

export function dbToUiArtist(ar: DbArtist, albums: Album[] = []): Artist {
  const sorted = [...albums].sort(sortAlbumsByFreshness)
  const latestArt = sorted.find(a => a.artworkPath)?.artworkPath
  const seed = ar.id || 1
  return {
    id: `ar${ar.id}`,
    dbId: ar.id,
    name: ar.name,
    albums,
    seed,
    palette: palette(seed),
    pattern: patternFor(seed),
    artworkPath: latestArt,
    favorite: ar.is_favorite === 1,
    trackCount: ar.track_count,
  }
}

export function dbToUiGenre(g: DbGenre): UiGenre {
  return { id: `g${g.id}`, name: g.name }
}

export function dbToUiPlaylist(p: DbPlaylist, tracks: Track[] = []): Playlist {
  return {
    id: `p${p.id}`,
    name: p.name,
    count: p.track_count,
    kind: (p.is_smart === 1 ? 'smart' : 'manual') satisfies PlaylistKind,
    icon: p.is_smart === 1 ? 'sparkle' : 'note',
    desc: p.description ?? undefined,
    tracks,
  }
}
