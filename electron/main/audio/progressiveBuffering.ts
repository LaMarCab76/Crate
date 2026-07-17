export const PRELOAD_MEMORY_TIMEOUT_MS = 3000
export const BACKGROUND_MEMORY_PROMOTION_TIMEOUT_MS = 120_000
// OneDrive playback downloads a complete track into RAM before handing it to
// BASS. Keep this as a safety ceiling, not a fast local-file fallback timeout.
export const CLOUD_MEMORY_TIMEOUT_MS = 5 * 60_000
export const PLAYBACK_MEMORY_READ_CHUNK_BYTES = 8 * 1024 * 1024
export const PLAYBACK_MEMORY_RESERVE_BYTES = 512 * 1024 * 1024
export const PLAYBACK_MEMORY_SMALL_TRACK_BYTES = 128 * 1024 * 1024
export const PLAYBACK_MEMORY_MIN_FREE_AFTER_SMALL_TRACK_BYTES = 256 * 1024 * 1024
export const PLAYBACK_MEMORY_MAX_TRACK_BYTES = 2 * 1024 * 1024 * 1024
// When a track is already in memory, we allow preloading a *second* track into
// memory (gapless dual-stream) as long as the system still has more than this
// much free RAM. This keeps two tracks resident on high-RAM machines where the
// proportional reserve would otherwise reject the second one.
export const TWO_TRACK_MEMORY_FREE_THRESHOLD_BYTES = 1024 * 1024 * 1024 // 1 GiB

export interface ProgressiveBufferTelemetry {
  bufferedBytes: number | null
  totalBytes: number | null
  bufferedSec: number | null
  bufferComplete: boolean
}

export function estimateBufferedSeconds(
  bufferedBytes: number | null,
  totalBytes: number | null,
  durationSec: number | null | undefined,
): number | null {
  if (
    bufferedBytes == null ||
    totalBytes == null ||
    totalBytes <= 0 ||
    durationSec == null ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0
  ) {
    return null
  }
  return Math.max(0, Math.min(durationSec, (bufferedBytes / totalBytes) * durationSec))
}

export function shouldDeferPreloadForProgressiveBuffer(args: {
  streamSource: string
  bufferComplete: boolean
}): boolean {
  return args.streamSource === 'progressive' && !args.bufferComplete
}

export interface PlaybackMemoryDecision {
  canUse: boolean
  reason: 'memory-size-limit' | null
  sizeBytes: number
}

export function calculatePlaybackMemoryReserveBytes(args: {
  totalMemBytes: number
  reserveBytes?: number
}): number {
  const configuredReserve = Math.max(1, Math.floor(args.reserveBytes ?? PLAYBACK_MEMORY_RESERVE_BYTES))
  const proportionalReserve = Math.floor(Math.max(0, args.totalMemBytes) * 0.05)
  return Math.max(configuredReserve, proportionalReserve)
}

const MAC_VM_STAT_AVAILABLE_PAGE_LABELS = new Set([
  'pages free',
  'pages inactive',
  'pages speculative',
  'pages purgeable',
])

export function parseMacVmStatAvailableMemoryBytes(vmStatOutput: string): number | null {
  const pageSizeMatch = vmStatOutput.match(/page size of\s+([\d,]+)\s+bytes/i)
  if (!pageSizeMatch) return null

  const pageSizeBytes = Number(pageSizeMatch[1].replaceAll(',', ''))
  if (!Number.isSafeInteger(pageSizeBytes) || pageSizeBytes <= 0) return null

  let availablePages = 0
  for (const line of vmStatOutput.split(/\r?\n/)) {
    const pageMatch = line.match(/^\s*(Pages [^:]+):\s*([\d,]+)\./i)
    if (!pageMatch) continue

    const label = pageMatch[1].toLowerCase()
    if (!MAC_VM_STAT_AVAILABLE_PAGE_LABELS.has(label)) continue

    const pages = Number(pageMatch[2].replaceAll(',', ''))
    if (Number.isSafeInteger(pages) && pages > 0) availablePages += pages
  }

  if (availablePages <= 0) return null
  const availableBytes = availablePages * pageSizeBytes
  return Number.isSafeInteger(availableBytes) ? availableBytes : null
}

export function decidePlaybackMemoryUse(args: {
  fileSizeBytes: number
  // Memory available for playback allocation. On macOS this can include
  // reclaimable pages, not just the strict value reported by os.freemem().
  freeMemBytes: number
  totalMemBytes: number
  reserveBytes?: number
  maxTrackBytes?: number
  // True when this is the second track (gapless preload) and the first one is
  // already resident in memory. Relaxes the proportional reserve in favor of a
  // fixed safety floor so two tracks can coexist when free RAM > 1 GB.
  allowSecondTrack?: boolean
}): PlaybackMemoryDecision {
  const sizeBytes = Math.max(0, Math.floor(args.fileSizeBytes))
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return { canUse: false, reason: 'memory-size-limit', sizeBytes }
  }

  const maxTrackBytes = Math.max(1, Math.floor(args.maxTrackBytes ?? PLAYBACK_MEMORY_MAX_TRACK_BYTES))
  if (sizeBytes > maxTrackBytes) return { canUse: false, reason: 'memory-size-limit', sizeBytes }

  const totalMemBytes = Math.max(0, Math.floor(args.totalMemBytes))
  const freeMemBytes = Math.max(0, Math.floor(args.freeMemBytes))
  const reserveBytes = calculatePlaybackMemoryReserveBytes({
    totalMemBytes,
    reserveBytes: args.reserveBytes,
  })
  const freeAfterReadBytes = freeMemBytes - sizeBytes

  // Second track (gapless preload) with the first already in memory: if the
  // system still has more than 1 GB free, keep it in memory using a fixed
  // safety floor instead of the proportional reserve, which on high-RAM
  // machines would otherwise block the in-memory dual-stream.
  if (
    args.allowSecondTrack &&
    freeMemBytes > TWO_TRACK_MEMORY_FREE_THRESHOLD_BYTES &&
    freeAfterReadBytes >= PLAYBACK_MEMORY_MIN_FREE_AFTER_SMALL_TRACK_BYTES
  ) {
    return { canUse: true, reason: null, sizeBytes }
  }

  if (freeAfterReadBytes <= reserveBytes) {
    const canUseSmallTrackGrace =
      sizeBytes <= PLAYBACK_MEMORY_SMALL_TRACK_BYTES &&
      freeAfterReadBytes >= PLAYBACK_MEMORY_MIN_FREE_AFTER_SMALL_TRACK_BYTES
    if (!canUseSmallTrackGrace) return { canUse: false, reason: 'memory-size-limit', sizeBytes }
  }

  return { canUse: true, reason: null, sizeBytes }
}
