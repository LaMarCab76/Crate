export const PROGRESSIVE_START_WINDOW_SEC = 15
export const PROGRESSIVE_CHUNK_BYTES = 512 * 1024
export const PROGRESSIVE_MIN_INITIAL_BYTES = 512 * 1024
export const PROGRESSIVE_FALLBACK_INITIAL_BYTES = 16 * 1024 * 1024
export const PLAYBACK_MEMORY_RESERVE_BYTES = 512 * 1024 * 1024
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

export function calculateProgressiveInitialBytes(args: {
  fileSizeBytes: number
  durationSec?: number | null
  startWindowSec?: number
  minInitialBytes?: number
  fallbackInitialBytes?: number
}): number {
  const fileSize = Math.max(0, Math.floor(args.fileSizeBytes))
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return 0

  const startWindowSec = Math.max(0, args.startWindowSec ?? PROGRESSIVE_START_WINDOW_SEC)
  const minInitialBytes = Math.max(1, Math.floor(args.minInitialBytes ?? PROGRESSIVE_MIN_INITIAL_BYTES))
  const fallbackInitialBytes = Math.max(minInitialBytes, Math.floor(args.fallbackInitialBytes ?? PROGRESSIVE_FALLBACK_INITIAL_BYTES))
  const durationSec = args.durationSec

  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return Math.min(fileSize, fallbackInitialBytes)
  }
  if (durationSec <= startWindowSec) return fileSize

  const proportionalBytes = Math.ceil(fileSize * (startWindowSec / durationSec))
  return Math.min(fileSize, Math.max(minInitialBytes, proportionalBytes))
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
  const reserveBytes = Math.max(
    Math.floor(args.reserveBytes ?? PLAYBACK_MEMORY_RESERVE_BYTES),
    Math.floor(totalMemBytes * 0.05),
  )

  if (freeMemBytes - sizeBytes <= reserveBytes) {
    return { canUse: false, reason: 'memory-size-limit', sizeBytes }
  }

  return { canUse: true, reason: null, sizeBytes }
}

export interface ProgressiveChunkPumpOptions {
  totalBytes: number
  startOffset: number
  chunkBytes?: number
  isAborted?: () => boolean
  waitMs?: (ms: number) => Promise<void>
  readChunk: (offset: number, length: number) => Promise<Buffer>
  writeChunk: (chunk: Buffer) => number
  writeEnd: () => void
  onProgress?: (bufferedBytes: number) => void
}

function defaultWaitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function pumpProgressiveChunks(options: ProgressiveChunkPumpOptions): Promise<void> {
  const totalBytes = Math.max(0, Math.floor(options.totalBytes))
  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? PROGRESSIVE_CHUNK_BYTES))
  const waitMs = options.waitMs ?? defaultWaitMs
  let offset = Math.max(0, Math.min(totalBytes, Math.floor(options.startOffset)))

  while (offset < totalBytes) {
    if (options.isAborted?.()) return

    const length = Math.min(chunkBytes, totalBytes - offset)
    const chunk = await options.readChunk(offset, length)
    if (options.isAborted?.()) return
    if (chunk.byteLength === 0) throw new Error(`Progressive read returned 0 bytes at offset ${offset}`)

    let chunkOffset = 0
    while (chunkOffset < chunk.byteLength) {
      if (options.isAborted?.()) return

      const pending = chunk.subarray(chunkOffset)
      const written = options.writeChunk(pending)
      if (written < 0) throw new Error('Progressive stream rejected buffered data')
      if (written === 0) {
        await waitMs(20)
        continue
      }

      const accepted = Math.min(written, pending.byteLength)
      chunkOffset += accepted
      offset += accepted
      options.onProgress?.(offset)
    }
  }

  if (!options.isAborted?.()) options.writeEnd()
}
