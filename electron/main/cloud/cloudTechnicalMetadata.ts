import { parseBuffer } from 'music-metadata'

export const CLOUD_METADATA_PREFIX_BYTES = 2 * 1024 * 1024

export interface CloudTechnicalTrack {
  id: number
  filename: string
  provider: string
  drive_id: string | null
  item_id: string | null
  etag: string | null
  quickxor_hash: string | null
  codec: string | null
  bitrate: number | null
  sample_rate: number | null
  bit_depth: number | null
  channels: number | null
  duration: number
  file_size: number | null
}

export interface ParsedTechnicalMetadata {
  codec: unknown
  codecProfile: unknown
  bitrate: unknown
  sampleRate: unknown
  bitDepth: unknown
  channels: unknown
  duration: unknown
  completeFile: boolean
}

export interface CloudTechnicalMetadataPatch {
  codec?: string
  bitrate?: number
  sampleRate?: number
  bitDepth?: number
  channels?: number
  duration?: number
}

function finiteInRange(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined
}

function integerInRange(value: unknown, minimum: number, maximum: number): number | undefined {
  const valid = finiteInRange(value, minimum, maximum)
  return valid !== undefined && Number.isInteger(valid) ? valid : undefined
}

export async function readTechnicalMetadataFromPrefix(
  buffer: Uint8Array,
  options: { filename: string; fileSize: number | null },
): Promise<ParsedTechnicalMetadata> {
  const metadata = await parseBuffer(
    buffer,
    { path: options.filename, size: options.fileSize ?? undefined },
    { skipCovers: true, skipPostHeaders: false, includeChapters: false },
  )
  return {
    codec: metadata.format.codec,
    codecProfile: metadata.format.codecProfile,
    bitrate: metadata.format.bitrate,
    sampleRate: metadata.format.sampleRate,
    bitDepth: metadata.format.bitsPerSample,
    channels: metadata.format.numberOfChannels,
    duration: metadata.format.duration,
    completeFile: options.fileSize != null && options.fileSize === buffer.byteLength,
  }
}

/** Returns only confidently parsed values for fields the cloud index does not
 * already know. A truncated prefix must never replace reliable Graph metadata. */
export function confidentTechnicalPatch(
  current: Pick<CloudTechnicalTrack,
    'codec' | 'bitrate' | 'sample_rate' | 'bit_depth' | 'channels' | 'duration'>,
  parsed: ParsedTechnicalMetadata,
): CloudTechnicalMetadataPatch {
  const patch: CloudTechnicalMetadataPatch = {}
  if (current.codec == null && typeof parsed.codec === 'string') {
    const rawCodec = parsed.codec.trim()
    const normalizedCodec = /^mpeg\s+(?:1|2(?:\.5)?)\s+layer\s+3$/i.test(rawCodec) ? 'MP3' : rawCodec
    if (normalizedCodec && normalizedCodec.length <= 100 && normalizedCodec.toLowerCase() !== 'unknown') {
      patch.codec = normalizedCodec
    }
  }

  if (parsed.completeFile || parsed.codecProfile === 'CBR') {
    const bitrate = finiteInRange(parsed.bitrate, 1_000, 100_000_000)
    if (bitrate !== undefined) patch.bitrate = Math.round(bitrate)
  }
  if (current.sample_rate == null) {
    const sampleRate = integerInRange(parsed.sampleRate, 1_000, 768_000)
    if (sampleRate !== undefined) patch.sampleRate = sampleRate
  }
  if (current.bit_depth == null) {
    const bitDepth = integerInRange(parsed.bitDepth, 1, 64)
    if (bitDepth !== undefined) patch.bitDepth = bitDepth
  }
  if (current.channels == null) {
    const channels = integerInRange(parsed.channels, 1, 64)
    if (channels !== undefined) patch.channels = channels
  }

  if (parsed.completeFile && !(Number.isFinite(current.duration) && current.duration > 0)) {
    const duration = finiteInRange(parsed.duration, 0.001, 7 * 24 * 60 * 60)
    if (duration !== undefined) patch.duration = duration
  }
  return patch
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function enrichCloudTechnicalTracks(
  tracks: readonly CloudTechnicalTrack[],
  deps: {
    fetchPrefix: (
      driveId: string,
      itemId: string,
      maxBytes: number,
      signal: AbortSignal,
    ) => Promise<{ buffer: Buffer; size?: number; etag?: string | null }>
    update: (
      track: CloudTechnicalTrack,
      patch: CloudTechnicalMetadataPatch,
      fetchedEtag: string | null | undefined,
    ) => boolean | void | Promise<boolean | void>
    parse?: typeof readTechnicalMetadataFromPrefix
    onTrackError?: (track: CloudTechnicalTrack, error: unknown) => void
    yield?: () => Promise<void>
  },
  signal: AbortSignal,
): Promise<number> {
  let enriched = 0
  const parse = deps.parse ?? readTechnicalMetadataFromPrefix
  const yieldToLoop = deps.yield ?? (() => new Promise<void>(resolve => setImmediate(resolve)))

  for (const track of tracks) {
    signal.throwIfAborted()
    if (track.provider !== 'onedrive' || !track.drive_id || !track.item_id) continue
    try {
      const fetched = await deps.fetchPrefix(
        track.drive_id,
        track.item_id,
        CLOUD_METADATA_PREFIX_BYTES,
        signal,
      )
      signal.throwIfAborted()
      if (fetched.etag !== undefined && fetched.etag !== track.etag) continue
      const parsed = await parse(fetched.buffer, {
        filename: track.filename,
        fileSize: fetched.size ?? track.file_size,
      })
      signal.throwIfAborted()
      const patch = confidentTechnicalPatch(track, parsed)
      const changed = await deps.update(track, patch, fetched.etag)
      if (changed !== false) enriched += 1
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      deps.onTrackError?.(track, error)
    }
    await yieldToLoop()
  }
  return enriched
}
