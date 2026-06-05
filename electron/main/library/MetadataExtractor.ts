import { parseBuffer, parseFile, type IAudioMetadata } from 'music-metadata'
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

// Shared mapping from a parsed music-metadata result to our TrackMetadata. Used
// by both the local-file (parseFile) and cloud-buffer (parseBuffer) readers; only
// the byte source and the file stats (size/mtime) differ between them.
function mapParsedMetadata(
  meta: IAudioMetadata,
  ctx: { nameForFormat: string; fileSize: number | null; dateModified: string | null; readArtwork: boolean },
): TrackMetadata {
  const common = meta.common
  const format = meta.format
  const fallbackTitle = basename(ctx.nameForFormat).replace(/\.[^.]+$/, '')

  const title = asString(common.title, fallbackTitle).trim() || fallbackTitle
  const artist = asString(common.artist || joinList(common.artists), 'Unknown Artist').trim()
  const album = asString(common.album, 'Unknown Album').trim()
  const albumArtist = common.albumartist ? String(common.albumartist).trim() : null

  let artwork: ArtworkSaveResult | null = null
  const pictures = common.picture
  if (ctx.readArtwork && pictures && pictures.length > 0) {
    const p = pictures[0]
    try {
      artwork = saveArtwork(Buffer.from(p.data), p.format)
    } catch (err) {
      console.warn(`[metadata] artwork save failed for ${ctx.nameForFormat}:`, (err as Error).message)
    }
  }

  return {
    title,
    artist,
    album,
    albumArtist,
    composer: joinList(common.composer),
    genre: joinList(common.genre),
    year: common.year != null ? String(common.year) : asString(common.date).slice(0, 4),
    trackNumber: common.track?.no ?? null,
    totalTracks: common.track?.of ?? null,
    discNumber: common.disk?.no ?? null,
    totalDiscs: common.disk?.of ?? null,
    duration: format.duration ?? 0,
    format: inferFormat(ctx.nameForFormat, format.container ?? format.codec),
    codec: format.codec ?? null,
    bitrate: format.bitrate ?? null,
    sampleRate: format.sampleRate ?? null,
    bitDepth: format.bitsPerSample ?? null,
    channels: format.numberOfChannels ?? null,
    fileSize: ctx.fileSize,
    bpm: parseBpm(common.bpm),
    musicalKey: asString(common.key).trim() || null,
    dateModified: ctx.dateModified,
    artwork,
    replayGainTrack: parseGainDb(common.replaygain_track_gain?.dB?.toString()),
    replayGainAlbum: parseGainDb(common.replaygain_album_gain?.dB?.toString()),
    isCompilation: Boolean(common.compilation),
  }
}

export async function readTrackMetadata(
  filePath: string,
  options: ReadTrackMetadataOptions = {},
): Promise<TrackMetadata> {
  const stats = await stat(filePath)
  const meta = await parseFile(filePath, metadataParserOptions(options))
  return mapParsedMetadata(meta, {
    nameForFormat: filePath,
    fileSize: stats.size,
    dateModified: stats.mtime.toISOString(),
    readArtwork: shouldReadEmbeddedArtwork(options),
  })
}

// Parse metadata from an in-RAM buffer (e.g. a OneDrive header prefix or full
// file fetched into memory). For containers whose tag atoms sit at the end of the
// file (some M4A/MP4), a truncated prefix may parse incompletely — callers should
// treat missing technical fields as "unknown" rather than authoritative.
export async function readTrackMetadataFromBuffer(
  buffer: Uint8Array,
  opts: {
    filename: string
    mimeType?: string
    fileSize?: number | null
    dateModified?: string | null
    options?: ReadTrackMetadataOptions
  },
): Promise<TrackMetadata> {
  const options = opts.options ?? {}
  const meta = await parseBuffer(
    buffer,
    { mimeType: opts.mimeType, path: opts.filename, size: opts.fileSize ?? undefined },
    metadataParserOptions(options),
  )
  return mapParsedMetadata(meta, {
    nameForFormat: opts.filename,
    fileSize: opts.fileSize ?? null,
    dateModified: opts.dateModified ?? null,
    readArtwork: shouldReadEmbeddedArtwork(options),
  })
}
