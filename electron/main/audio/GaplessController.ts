// Gapless dual-stream swap. We preload the next track ahead of time and use
// BASS_SYNC_END to switch to it the moment the current stream finishes.
//
// CRITICAL: koffi callbacks are GC-rooted only as long as we hold a JS
// reference to them. BASS keeps a native pointer to the callback function;
// if the JS callback is collected before BASS_ChannelRemoveSync is called,
// BASS will dereference garbage memory and segfault inside its audio thread.
// We therefore keep every registered SYNCPROC alive in a module-level Map
// keyed by the sync handle until the corresponding RemoveSync call returns.

import { createRequire } from 'node:module'
import { broadcast } from '../ipc/events'

const require = createRequire(import.meta.url)
const koffi = require('koffi') as typeof import('koffi')

import { BASS_SYNC_END, BASS_SYNC_ONETIME } from './bass-constants'
import { loadBass, SYNCPROC, type HSTREAM, type HSYNC } from './bass-ffi'
import type {
  AudioEngine,
  StreamCreateResult,
  StreamInfo,
} from './AudioEngine'
import type {
  PreloadNextFailureReason,
  PreloadNextResult,
  PreloadNextSource,
  StreamLoadResult,
  StreamInfoPayload,
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

interface PreloadedStream {
  path: string
  handle: HSTREAM
  info: StreamInfo
  memoryBuffer: Buffer | null
  preload: PreloadAttemptTelemetry
}

// Module-level retention of native callbacks. We can't put these on the
// instance because some BASS callback paths can fire after the controller
// would otherwise be GC'd — keeping the map at module scope guarantees the
// retention spans the entire process lifetime.
//
// koffi.register returns its own pointer type — we hold it as `unknown` in
// our own types but pass through to koffi APIs that need it via casts.
type KoffiCallbackPtr = Parameters<typeof koffi.unregister>[0]
type RegisteredCallback = { sync: HSYNC; channel: HSTREAM; cb: KoffiCallbackPtr }
const retainedCallbacks = new Set<RegisteredCallback>()

function registerEndSync(channel: HSTREAM, handler: () => void): RegisteredCallback {
  const bass = loadBass()
  // The SYNCPROC signature is: (HSYNC, channel, data, user). We ignore all
  // four args because we close over `handler` in JS.
  const cb = koffi.register(() => {
    try { handler() } catch (err) { console.error('[gapless] sync handler error:', err) }
  }, koffi.pointer(SYNCPROC)) as KoffiCallbackPtr

  const sync = bass.ChannelSetSync(channel, BASS_SYNC_END | BASS_SYNC_ONETIME, 0n, cb, 0n)
  const entry: RegisteredCallback = { sync, channel, cb }
  retainedCallbacks.add(entry)
  return entry
}

function releaseCallback(entry: RegisteredCallback): void {
  const bass = loadBass()
  bass.ChannelRemoveSync(entry.channel, entry.sync)
  retainedCallbacks.delete(entry)
  // koffi.unregister requires the pointer we got back from register.
  try { koffi.unregister(entry.cb) } catch { /* already unregistered */ }
}

function serializeStreamInfo(info: StreamInfo): StreamInfoPayload {
  return {
    freq: info.freq,
    chans: info.chans,
    ctype: info.ctype,
    duration: info.duration,
    durationBytes: Number(info.durationBytes),
    bytesPerSecond: info.bytesPerSecond,
  }
}

export class GaplessController {
  private next: PreloadedStream | null = null
  // One callback attached to the *currently playing* stream. It performs the
  // gapless swap when a preloaded track exists, otherwise it emits the generic
  // track-ended event used by queueStore as fallback.
  private currentTrackEndRegistration: RegisteredCallback | null = null
  private failedMemoryByPath = new Map<string, number>()

  constructor(private engine: AudioEngine) {}

  bindCurrentTrackEnd(): void {
    const currentStream = this.engine.getCurrentStream()
    if (currentStream === 0) return

    if (this.currentTrackEndRegistration && this.currentTrackEndRegistration.channel === currentStream) return

    if (this.currentTrackEndRegistration) {
      releaseCallback(this.currentTrackEndRegistration)
      this.currentTrackEndRegistration = null
    }

    this.currentTrackEndRegistration = registerEndSync(currentStream, () => {
      // Keep the callback for the ending track fresh: if this handler is
      // invoked via BASS's synchronous callback path, releasing/reattaching
      // the sync inside the callback itself can cause races.
      const endedRegistration = this.currentTrackEndRegistration
      this.currentTrackEndRegistration = null
      if (endedRegistration) queueMicrotask(() => releaseCallback(endedRegistration))

      if (!this.next) {
        broadcast('audio:track-ended')
        return
      }

      try {
        const info = this.swapToNext()
        if (!info) broadcast('audio:track-ended')
      } catch {
        broadcast('audio:track-ended')
      }
    })
  }

  private clearCurrentTrackEndRegistration(): void {
    if (!this.currentTrackEndRegistration) return
    const reg = this.currentTrackEndRegistration
    this.currentTrackEndRegistration = null
    releaseCallback(reg)
  }

  private isUnstableIOFailure(reason: PreloadNextFailureReason | null): boolean {
    return reason === 'memory-timeout' || reason === 'memory-read-failed' || reason === 'memory-stream-failed'
  }

  private cleanupExpiredMemoryFailureCooldown(path: string, now: number): void {
    const until = this.failedMemoryByPath.get(path)
    if (until != null && until <= now) this.failedMemoryByPath.delete(path)
  }

  private shouldSkipMemory(path: string, now: number): boolean {
    this.cleanupExpiredMemoryFailureCooldown(path, now)
    const until = this.failedMemoryByPath.get(path)
    return until != null && until > now
  }

  private rememberUnstableMemoryFailure(path: string, reason: PreloadNextFailureReason | null, now: number): void {
    if (!this.isUnstableIOFailure(reason)) return
    this.failedMemoryByPath.set(path, now + PRELOAD_MEMORY_FAILURE_COOLDOWN_MS)
  }

  private createTelemetryFromResult(result: StreamCreateResult): PreloadAttemptTelemetry {
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

  private toPreloadResult(result: StreamCreateResult, streamInfo: StreamInfo | null): PreloadNextResult {
    return {
      ...this.createTelemetryFromResult(result),
      streamInfo: streamInfo ? serializeStreamInfo(streamInfo) : null,
    }
  }

  // Preload a track. Idempotent for the same path. The end-of-stream sync is
  // attached to the CURRENT stream so that when it finishes we swap to the
  // preloaded one and start playback in the same audio thread tick.
  async preloadNext(path: string): Promise<PreloadNextResult> {
    if (this.next && this.next.path === path) {
      return {
        attempted: this.next.preload.attempted,
        source: this.next.preload.source,
        reason: this.next.preload.reason,
        durationMs: this.next.preload.durationMs,
        sizeBytes: this.next.preload.sizeBytes,
        streamInfo: serializeStreamInfo(this.next.info),
        bufferedBytes: this.next.preload.bufferedBytes,
        totalBytes: this.next.preload.totalBytes,
        bufferedSec: this.next.preload.bufferedSec,
        bufferComplete: this.next.preload.bufferComplete,
      }
    }
    this.clearNext()

    const now = Date.now()
    const skipMemory = this.shouldSkipMemory(path, now)
    const created = await this.engine.createStream(path, {
      skipMemory,
      memoryOnly: false,
      memoryReadTimeoutMs: 1000,
    })
    const preloadData = this.createTelemetryFromResult(created)

    if (created.attemptedMemory) {
      this.rememberUnstableMemoryFailure(path, created.reason, now)
    }

    if (created.stream) {
      this.failedMemoryByPath.delete(path)
      this.next = {
        path,
        handle: created.stream.handle,
        info: created.stream.info,
        memoryBuffer: created.stream.memoryBuffer,
        preload: preloadData,
      }
      this.bindCurrentTrackEnd()
      return this.toPreloadResult(created, created.stream.info)
    }

    // If no stream is available, keep no preloaded stream cached but report
    // why fallback did not happen. The caller can continue with normal
    // standard-load semantics.
    return this.toPreloadResult(created, null)
  }

  // Forcibly swap to the preloaded stream right now (used when the user hits
  // "Next" before the current track ends, OR fired automatically by the
  // BASS_SYNC_END callback above).
  swapToNext(expectedPath?: string | null): StreamLoadResult | null {
    if (!this.next) return null
    if (expectedPath && this.next.path !== expectedPath) return null
    const preloaded = this.next
    this.next = null
    const endedRegistration = this.currentTrackEndRegistration
    this.currentTrackEndRegistration = null
    if (endedRegistration) queueMicrotask(() => releaseCallback(endedRegistration))

    const old = this.engine.releaseCurrent()
    if (old.handle !== 0) this.engine.freeStream(old.handle)
    // adoptStream() starts playback itself (so the FFT timer re-syncs against a
    // live channel), so we don't call ChannelPlay here.
    const info = this.engine.adoptStream(preloaded.handle, preloaded.path, preloaded.memoryBuffer, {
      sourceResult: {
        source: preloaded.preload.source,
        reason: preloaded.preload.reason,
        sizeBytes: preloaded.preload.sizeBytes,
        durationMs: preloaded.preload.durationMs,
        attemptedMemory: preloaded.preload.attempted,
        buffer: {
          bufferedBytes: preloaded.preload.bufferedBytes,
          totalBytes: preloaded.preload.totalBytes,
          bufferedSec: preloaded.preload.bufferedSec,
          bufferComplete: preloaded.preload.bufferComplete,
        },
      },
    })
    this.bindCurrentTrackEnd()
    const result: StreamLoadResult = {
      attempted: preloaded.preload.attempted,
      source: preloaded.preload.source,
      reason: preloaded.preload.reason,
      durationMs: preloaded.preload.durationMs,
      sizeBytes: preloaded.preload.sizeBytes,
      streamInfo: serializeStreamInfo(info),
      bufferedBytes: preloaded.preload.bufferedBytes,
      totalBytes: preloaded.preload.totalBytes,
      bufferedSec: preloaded.preload.bufferedSec,
      bufferComplete: preloaded.preload.bufferComplete,
    }
    broadcast('audio:gapless-fired', { path: preloaded.path, streamInfo: result.streamInfo, source: result.source })
    return result
  }

  // Drop the preloaded stream without playing it (e.g. queue was modified).
  clearNext(): void {
    if (!this.next) return
    this.engine.freeStream(this.next.handle)
    this.next = null
  }

  clear(): void {
    this.clearNext()
    this.clearCurrentTrackEndRegistration()
  }

  movePreloadedToOutputDevice(deviceId: number): boolean {
    if (!this.next) return true
    const moved = this.engine.moveStreamToOutputDevice(this.next.handle, deviceId)
    if (!moved) this.clearNext()
    return moved
  }

  hasNext(): boolean { return this.next !== null }
  getNextPath(): string | null { return this.next?.path ?? null }
}
