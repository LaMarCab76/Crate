export const PRELOAD_MEMORY_TIMEOUT_MS = 3000
export const PLAYBACK_MEMORY_RESERVE_BYTES = 512 * 1024 * 1024
export const PLAYBACK_MEMORY_SMALL_TRACK_BYTES = 128 * 1024 * 1024
export const PLAYBACK_MEMORY_MIN_FREE_AFTER_SMALL_TRACK_BYTES = 256 * 1024 * 1024
export const PLAYBACK_MEMORY_MAX_TRACK_BYTES = 2 * 1024 * 1024 * 1024

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

export function decidePlaybackMemoryUse(args: {
  fileSizeBytes: number
  freeMemBytes: number
  totalMemBytes: number
  reserveBytes?: number
  maxTrackBytes?: number
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

  if (freeAfterReadBytes <= reserveBytes) {
    const canUseSmallTrackGrace =
      sizeBytes <= PLAYBACK_MEMORY_SMALL_TRACK_BYTES &&
      freeAfterReadBytes >= PLAYBACK_MEMORY_MIN_FREE_AFTER_SMALL_TRACK_BYTES
    if (!canUseSmallTrackGrace) return { canUse: false, reason: 'memory-size-limit', sizeBytes }
  }

  return { canUse: true, reason: null, sizeBytes }
}
