import { parseFile } from 'music-metadata'
import { basename, extname } from 'node:path'
import { stat } from 'node:fs/promises'
import { saveArtwork, type ArtworkSaveResult } from './ArtworkCache.ts'

export interface ReadTrackMetadataOptions {
  artwork?: boolean
}

export interface TrackMetadata {
  title: string
  artist: string
  album: string
  albumArtist: string | null
  composer: string
  genre: string
  year: string
  trackNumber: number | null
  totalTracks: number | null
  discNumber: number | null
  totalDiscs: number | null
  duration: number // seconds
  format: string
  codec: string | null
  bitrate: number | null     // bits per second
  sampleRate: number | null  // Hz
  bitDepth: number | null
  channels: number | null
  fileSize: number | null
  bpm: number | null
  musicalKey: string | null
  dateModified: string | null
  artwork: ArtworkSaveResult | null
  replayGainTrack: number | null
  replayGainAlbum: number | null
  isCompilation: boolean
  releaseDate: string | null
  originalReleaseDate: string | null
  releaseTypes: string[]
  mediaType: string | null
  musicbrainzRecordingId: string | null
  musicbrainzTrackId: string | null
  musicbrainzAlbumId: string | null
  musicbrainzReleaseGroupId: string | null
  musicbrainzArtistIds: string[]
  musicbrainzAlbumArtistIds: string[]
}

export function serializeTrackExtendedMetadata(md: Pick<TrackMetadata,
  | 'releaseTypes'
  | 'musicbrainzRecordingId'
  | 'musicbrainzTrackId'
  | 'musicbrainzAlbumId'
  | 'musicbrainzReleaseGroupId'
  | 'musicbrainzArtistIds'
  | 'musicbrainzAlbumArtistIds'
>): string {
  return JSON.stringify({
    releaseTypes: md.releaseTypes,
    musicbrainzRecordingId: md.musicbrainzRecordingId,
    musicbrainzTrackId: md.musicbrainzTrackId,
    musicbrainzAlbumId: md.musicbrainzAlbumId,
    musicbrainzReleaseGroupId: md.musicbrainzReleaseGroupId,
    musicbrainzArtistIds: md.musicbrainzArtistIds,
    musicbrainzAlbumArtistIds: md.musicbrainzAlbumArtistIds,
  })
}

function asString(v: unknown, fallback = ''): string {
  if (v == null) return fallback
  return String(v)
}

function joinList(v: unknown): string {
  if (Array.isArray(v)) return v.filter(Boolean).join(', ')
  return asString(v, '')
}

function inferFormat(filePath: string, fmtName: string | undefined): string {
  if (fmtName) return fmtName.toUpperCase()
  const ext = extname(filePath).slice(1).toUpperCase()
  return ext || 'AUDIO'
}

function parseGainDb(s: string | undefined | null): number | null {
  if (!s) return null
  const m = /(-?\d+(?:\.\d+)?)/.exec(s)
  return m ? parseFloat(m[1]) : null
}

function parseBpm(v: unknown): number | null {
  const bpm = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm) : null
}

export function shouldReadEmbeddedArtwork(options: ReadTrackMetadataOptions = {}): boolean {
  return options.artwork !== false
}

export function metadataParserOptions(options: ReadTrackMetadataOptions = {}): {
  skipCovers: boolean
  skipPostHeaders: boolean
  includeChapters: boolean
} {
  return {
    skipCovers: !shouldReadEmbeddedArtwork(options),
    skipPostHeaders: false,
    includeChapters: false,
  }
}

export async function readTrackMetadata(
  filePath: string,
  options: ReadTrackMetadataOptions = {},
): Promise<TrackMetadata> {
  const stats = await stat(filePath)
  const filename = basename(filePath)
  const fallbackTitle = filename.replace(/\.[^.]+$/, '')
  const readArtwork = shouldReadEmbeddedArtwork(options)

  const meta = await parseFile(filePath, metadataParserOptions(options))

  const common = meta.common
  const format = meta.format

  const title = asString(common.title, fallbackTitle).trim() || fallbackTitle
  const artist = asString(common.artist || joinList(common.artists), 'Unknown Artist').trim()
  const album = asString(common.album, 'Unknown Album').trim()
  const albumArtist = common.albumartist ? String(common.albumartist).trim() : null
  const composer = joinList(common.composer)
  const genre = joinList(common.genre)
  const year = common.year != null ? String(common.year) : asString(common.date).slice(0, 4)
  const trackNumber = common.track?.no ?? null
  const totalTracks = common.track?.of ?? null
  const discNumber = common.disk?.no ?? null
  const totalDiscs = common.disk?.of ?? null
  const musicalKey = asString(common.key).trim() || null

  let artwork: ArtworkSaveResult | null = null
  const pictures = common.picture
  if (readArtwork && pictures && pictures.length > 0) {
    const p = pictures[0]
    try {
      artwork = saveArtwork(Buffer.from(p.data), p.format)
    } catch (err) {
      console.warn(`[metadata] artwork save failed for ${filePath}:`, (err as Error).message)
    }
  }

  return {
    title,
    artist,
    album,
    albumArtist,
    composer,
    genre,
    year,
    trackNumber,
    totalTracks,
    discNumber,
    totalDiscs,
    duration: format.duration ?? 0,
    format: inferFormat(filePath, format.container ?? format.codec),
    codec: format.codec ?? null,
    bitrate: format.bitrate ?? null,
    sampleRate: format.sampleRate ?? null,
    bitDepth: format.bitsPerSample ?? null,
    channels: format.numberOfChannels ?? null,
    fileSize: stats.size,
    bpm: parseBpm(common.bpm),
    musicalKey,
    dateModified: stats.mtime.toISOString(),
    artwork,
    replayGainTrack: parseGainDb(common.replaygain_track_gain?.dB?.toString()),
    replayGainAlbum: parseGainDb(common.replaygain_album_gain?.dB?.toString()),
    isCompilation: Boolean(common.compilation),
    releaseDate: asString(common.releasedate ?? common.date).trim() || null,
    originalReleaseDate: asString(common.originaldate ?? common.originalyear).trim() || null,
    releaseTypes: (common.releasetype ?? []).map(value => String(value).trim()).filter(Boolean),
    mediaType: asString(common.media).trim() || null,
    musicbrainzRecordingId: asString(common.musicbrainz_recordingid).trim() || null,
    musicbrainzTrackId: asString(common.musicbrainz_trackid).trim() || null,
    musicbrainzAlbumId: asString(common.musicbrainz_albumid).trim() || null,
    musicbrainzReleaseGroupId: asString(common.musicbrainz_releasegroupid).trim() || null,
    musicbrainzArtistIds: (common.musicbrainz_artistid ?? []).map(value => String(value).trim()).filter(Boolean),
    musicbrainzAlbumArtistIds: (common.musicbrainz_albumartistid ?? []).map(value => String(value).trim()).filter(Boolean),
  }
}
