// Gapless playback. The renderer asks us to preload the next track ahead of
// time; we prepare its stream (RAM copy when the budget allows) and queue it
// in the native player, which hands over at the exact sample the current
// track ends. Manual "next" uses the same queued stream (swapToNext).

import { CLOUD_MEMORY_TIMEOUT_MS, PRELOAD_MEMORY_TIMEOUT_MS } from './progressiveBuffering'
import type {
  AudioEngine,
  CloudTrackRef,
  StreamCreateResult,
  StreamInfo,
} from './AudioEngine'
import type {
  PreloadNextFailureReason,
  PreloadNextResult,
  PreloadNextSource,
  StreamLoadResult,
} from '@shared/types/ipc-contract'

const PRELOAD_MEMORY_FAILURE_COOLDOWN_MS = 8_000

interface PreloadAttemptTelemetry {
  attempted: boolean
  source: PreloadNextSource
  reason: PreloadNextFailureReason | null
  durationMs: number
  sizeBytes: number | null
  bufferedBytes: number | null
  totalBytes: number | null
  bufferedSec: number | null
  bufferComplete: boolean
}

export class GaplessController {
  private preloadGeneration = 0
  private preload: { path: string; telemetry: PreloadAttemptTelemetry; streamInfo: StreamInfo | null } | null = null
  private failedMemoryByPath = new Map<string, number>()
  // Invoked after every hand-over (manual "Next" and the native end-of-track
  // advance) so per-track state — the volume-leveler gain — follows the new
  // track. Set by the audio-channel.
  private onAfterSwap: (() => void) | null = null
  // Leveler gain for a track about to be queued, so its first sample already
  // plays at the right loudness.
  private gainForPath: ((path: string) => number) | null = null

  constructor(private engine: AudioEngine) {
    engine.setGaplessHooks({
      onNaturalAdvance: () => {
        this.preload = null
        this.onAfterSwap?.()
      },
      onTrackEnded: () => {
        this.preload = null
      },
    })
  }

  setOnAfterSwap(cb: (() => void) | null): void {
    this.onAfterSwap = cb
  }

  setGainResolver(resolve: ((path: string) => number) | null): void {
    this.gainForPath = resolve
  }

  private isUnstableIOFailure(reason: PreloadNextFailureReason | null): boolean {
    return reason === 'memory-timeout' || reason === 'memory-read-failed' || reason === 'memory-stream-failed'
  }

  private shouldSkipMemory(path: string, now: number): boolean {
    const until = this.failedMemoryByPath.get(path)
    if (until != null && until <= now) this.failedMemoryByPath.delete(path)
    return until != null && until > now
  }

  private rememberUnstableMemoryFailure(path: string, reason: PreloadNextFailureReason | null, now: number): void {
    if (!this.isUnstableIOFailure(reason)) return
    this.failedMemoryByPath.set(path, now + PRELOAD_MEMORY_FAILURE_COOLDOWN_MS)
  }

  private telemetryFrom(result: StreamCreateResult): PreloadAttemptTelemetry {
    return {
      attempted: result.attemptedMemory,
      source: result.source === 'none' ? 'none' : result.source,
      reason: result.reason,
      durationMs: result.durationMs,
      sizeBytes: result.sizeBytes,
      bufferedBytes: result.buffer.bufferedBytes,
      totalBytes: result.buffer.totalBytes,
      bufferedSec: result.buffer.bufferedSec,
      bufferComplete: result.buffer.bufferComplete,
    }
  }

  private toResult(telemetry: PreloadAttemptTelemetry, streamInfo: StreamInfo | null): PreloadNextResult {
    return { ...telemetry, streamInfo }
  }

  // Preload a track. Idempotent for the same path.
  async preloadNext(
    path: string,
    cloud?: { cloudRef: CloudTrackRef; cloudSizeBytes: number },
  ): Promise<PreloadNextResult> {
    if (this.preload && this.preload.path === path && this.engine.getNextPath() === path) {
      return this.toResult(this.preload.telemetry, this.preload.streamInfo)
    }
    const generation = ++this.preloadGeneration
    this.preload = null
    this.engine.clearNext()

    const now = Date.now()
    const created = await this.engine.createStream(path, {
      skipMemory: this.shouldSkipMemory(path, now),
      memoryOnly: false,
      memoryReadTimeoutMs: cloud ? CLOUD_MEMORY_TIMEOUT_MS : PRELOAD_MEMORY_TIMEOUT_MS,
      isPreload: true,
      cloudRef: cloud?.cloudRef,
      cloudSizeBytes: cloud?.cloudSizeBytes,
    })
    const telemetry = this.telemetryFrom(created)

    if (generation !== this.preloadGeneration) {
      this.engine.freeStream(created.stream)
      return this.toResult(telemetry, null)
    }
    if (created.attemptedMemory) this.rememberUnstableMemoryFailure(path, created.reason, now)
    if (!created.stream) return this.toResult(telemetry, null)

    this.failedMemoryByPath.delete(path)
    const gain = this.gainForPath?.(path) ?? 1
    const queued = await this.engine.queueNext(path, created, gain)
    if (generation !== this.preloadGeneration || !queued) {
      if (!queued) this.engine.freeStream(created.stream)
      return this.toResult(telemetry, null)
    }
    this.preload = { path, telemetry, streamInfo: queued.streamInfo }
    return this.toResult(telemetry, queued.streamInfo)
  }

  // Start the preloaded stream right now (the user pressed "Next").
  async swapToNext(expectedPath?: string | null): Promise<StreamLoadResult | null> {
    const preload = this.preload
    if (!preload) return null
    if (expectedPath && preload.path !== expectedPath) return null
    this.preloadGeneration += 1
    const result = await this.engine.skipToNext(expectedPath ?? preload.path)
    this.preload = null
    if (!result) return null
    this.onAfterSwap?.()
    return {
      ...result,
      attempted: preload.telemetry.attempted,
      source: preload.telemetry.source,
      reason: preload.telemetry.reason,
      durationMs: preload.telemetry.durationMs,
      sizeBytes: preload.telemetry.sizeBytes,
      bufferedBytes: preload.telemetry.bufferedBytes,
      totalBytes: preload.telemetry.totalBytes,
      bufferedSec: preload.telemetry.bufferedSec,
      bufferComplete: preload.telemetry.bufferComplete,
    }
  }

  // Drop the preloaded stream without playing it (e.g. queue was modified).
  clearNext(): void {
    this.preloadGeneration += 1
    this.preload = null
    this.engine.clearNext()
  }

  clear(): void {
    this.clearNext()
  }

  hasNext(): boolean { return this.engine.hasNext() }
  getNextPath(): string | null { return this.engine.getNextPath() }
}
