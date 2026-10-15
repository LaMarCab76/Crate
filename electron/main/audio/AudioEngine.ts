// AudioEngine — the main deck on top of libcrate_audio (FFmpeg + miniaudio).
// The renderer drives it via IPC; GaplessController decides what to preload.
//
// Design choices:
//   - The native engine owns real-time work: decoding threads, the device
//     callback, gapless hand-overs (sample-accurate) and output format changes
//     (bit-perfect). This class only commands it and reacts to its events,
//     polled on a timer — there are no native-to-JS callbacks.
//   - Playback sources prefer a full in-memory copy of the file. Disk
//     streaming remains a fallback when the RAM budget says no, and a later
//     promotion swaps in the RAM copy without an audible change.
//   - Decoders handed to the native player stay owned here and are closed
//     once the player gives them back (synchronously, or through a
//     DECODER_RETIRED event after a gapless transition).

import { broadcast } from '../ipc/events'
import { execFileSync } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { freemem, platform, totalmem } from 'node:os'
import {
  CA_INIT_NULL_BACKEND,
  CA_EVENT_DECODE_ERROR,
  CA_EVENT_DECODER_RETIRED,
  CA_EVENT_DEVICE_LOST,
  CA_EVENT_DEVICE_REROUTED,
  CA_EVENT_OUTPUT_CHANGED,
  CA_EVENT_TRACK_ENDED,
  CA_EVENT_TRACK_STARTED,
  CA_PLAYER_PAUSED,
  CA_PLAYER_PLAYING,
  Decoder,
  NativePlayer,
  closeOutput,
  getOutputInfo,
  initEngine,
  listNativeDevices,
  openOutput,
  pollEvents,
  setOutputPolicy as setNativeOutputPolicy,
  shutdownEngine,
  type CaStreamInfo,
  type NativeDeviceInfo,
  type NativeOutputInfo,
  type NativeOutputPolicy,
} from './native/crateAudio'
import { FFT_BINS_OUT, toDisplayBins } from './spectrumBins'
import type {
  AudioOutputDevice,
  FftMode,
  OutputInfoPayload,
  StreamLoadSource,
  StreamLoadFailureReason,
} from '@shared/types/ipc-contract'
import {
  BACKGROUND_MEMORY_PROMOTION_TIMEOUT_MS,
  CLOUD_MEMORY_TIMEOUT_MS,
  calculatePlaybackMemoryReserveBytes,
  decidePlaybackMemoryUse,
  estimateBufferedSeconds,
  parseMacVmStatAvailableMemoryBytes,
  PRELOAD_MEMORY_TIMEOUT_MS,
  PLAYBACK_MEMORY_READ_CHUNK_BYTES,
  PLAYBACK_MEMORY_MIN_FREE_AFTER_SMALL_TRACK_BYTES,
  PLAYBACK_MEMORY_RESERVE_BYTES,
  PLAYBACK_MEMORY_SMALL_TRACK_BYTES,
  type ProgressiveBufferTelemetry,
} from './progressiveBuffering'
import { getOneDriveClient } from '../cloud/OneDriveClient'
import { CloudAuthError } from '../cloud/OneDriveAuth'

export interface CloudTrackRef {
  driveId: string
  itemId: string
}

const FFT_INTERVAL_MS: Record<Exclude<FftMode, 'off' | 'screen'>, number> = {
  mini: 90,
  full: 33,
}
const MAX_SCREEN_FFT_HZ = 60
const DEFAULT_SCREEN_FFT_INTERVAL_MS = Math.round(1000 / MAX_SCREEN_FFT_HZ)

// Level metering (VU): independent of FFT so the meters keep working even when
// no spectrum visualizer is mounted. ~30 Hz matches the 'full' FFT cadence.
const METER_INTERVAL_MS = 33
// How much audio the meters average per measurement, in seconds.
const METER_WINDOW_SEC = 0.035
// Native events (track changes, device changes) are polled at this cadence.
const EVENT_POLL_MS = 25

interface PlaybackMemorySnapshot {
  freeMemBytes: number
  availableMemBytes: number
  totalMemBytes: number
}

function readMacPlaybackAvailableMemoryBytes(): number | null {
  if (platform() !== 'darwin') return null

  try {
    const vmStatOutput = execFileSync('/usr/bin/vm_stat', {
      encoding: 'utf8',
      timeout: 500,
    })
    return parseMacVmStatAvailableMemoryBytes(vmStatOutput)
  } catch {
    return null
  }
}

function getPlaybackMemorySnapshot(): PlaybackMemorySnapshot {
  const freeMemBytes = freemem()
  const totalMemBytes = totalmem()
  const macAvailableMemBytes = readMacPlaybackAvailableMemoryBytes()
  return {
    freeMemBytes,
    availableMemBytes: Math.max(freeMemBytes, macAvailableMemBytes ?? 0),
    totalMemBytes,
  }
}

function noBufferTelemetry(): ProgressiveBufferTelemetry {
  return {
    bufferedBytes: null,
    totalBytes: null,
    bufferedSec: null,
    bufferComplete: false,
  }
}

function completeBufferTelemetry(sizeBytes: number | null, durationSec: number | null | undefined): ProgressiveBufferTelemetry {
  return {
    bufferedBytes: sizeBytes,
    totalBytes: sizeBytes,
    bufferedSec: durationSec ?? null,
    bufferComplete: sizeBytes != null,
  }
}

export type PlaybackStatus = 'stopped' | 'playing' | 'paused' | 'loading'

export interface StreamInfo {
  freq: number          // rate the device plays at (the FFT/visualizer domain)
  chans: number
  codec: string
  duration: number      // seconds
  sourceRate: number    // the file's own rate (DSD: the 1-bit rate)
  bitsPerSample: number // 0 for lossy, 1 for DSD
}

export interface CreatedStream {
  decoder: Decoder
  info: StreamInfo
  memoryBuffer: Buffer | null
}

export type StreamCreateFailureReason = StreamLoadFailureReason
export interface StreamCreateResult {
  stream: CreatedStream | null
  source: StreamLoadSource | 'none'
  reason: StreamCreateFailureReason | null
  sizeBytes: number | null
  durationMs: number
  attemptedMemory: boolean
  buffer: ProgressiveBufferTelemetry
}

interface StreamLoadTelemetry {
  source: StreamLoadSource
  reason: StreamLoadFailureReason | null
  sizeBytes: number | null
  durationMs: number
  attemptedMemory: boolean
  buffer: ProgressiveBufferTelemetry
}

export interface StreamLoadResult {
  source: StreamLoadSource
  reason: StreamLoadFailureReason | null
  durationMs: number
  sizeBytes: number | null
  attemptedMemory: boolean
  streamInfo: StreamInfo | null
  bufferedBytes: number | null
  totalBytes: number | null
  bufferedSec: number | null
  bufferComplete: boolean
}

interface LoadOptions {
  estimatedDurationSec?: number | null
  cloudRef?: CloudTrackRef
  cloudSizeBytes?: number | null
}

interface PromoteCurrentToMemoryOptions {
  expectedPath?: string | null
  estimatedDurationSec?: number | null
  memoryReadTimeoutMs?: number
}

interface CreateStreamOptions {
  memoryOnly?: boolean
  skipMemory?: boolean
  memoryReadTimeoutMs?: number
  isPreload?: boolean
  estimatedDurationSec?: number | null
  abortSignal?: AbortSignal
  onBufferProgress?: (telemetry: ProgressiveBufferTelemetry) => void
  cloudRef?: CloudTrackRef
  cloudSizeBytes?: number | null
}

/** A track handed to the native player. */
interface DeckItem {
  serial: number
  path: string
  decoder: Decoder
  info: StreamInfo
  memoryBuffer: Buffer | null
  telemetry: StreamLoadTelemetry
}

/** Hooks GaplessController installs to follow native hand-overs. */
export interface GaplessHooks {
  /** A queued track became audible on its own (end of the previous one). */
  onNaturalAdvance(path: string, result: StreamLoadResult): void
  /** The current track ended with nothing queued. */
  onTrackEnded(): void
}

let engine: AudioEngine | null = null

export class AudioEngine {
  private initialized = false
  private player: NativePlayer | null = null
  private outputReady: Promise<void> = Promise.resolve()
  private outputPolicy: NativeOutputPolicy = { exclusive: false, bitPerfect: true }
  private outputDeviceId: string | null = null   // null = follow the system default
  private current: DeckItem | null = null
  private next: DeckItem | null = null
  // Decoders the player may still read; closed when it hands them back.
  private retiring = new Map<bigint, Decoder>()
  private serialCounter = 0
  private volume = 1.0
  // Per-track loudness-normalization multiplier (volume leveler). 1.0 = no change.
  private normalizationGain = 1.0
  private status: PlaybackStatus = 'stopped'
  private progressTimer: NodeJS.Timeout | null = null
  private eventTimer: NodeJS.Timeout | null = null
  private frameTimer: NodeJS.Timeout | null = null
  private frameTickMs = 0
  private fftMode: FftMode = 'off'
  private fftIntervalMs = 0
  private screenFftIntervalMs = DEFAULT_SCREEN_FFT_INTERVAL_MS
  private fftOut: number[] = new Array(FFT_BINS_OUT).fill(0)
  private lastFftAt = 0
  private lastMeterAt = 0
  private meterEnabled = false
  private currentStreamSource: StreamLoadSource = 'none'
  private currentStreamLoadResult: StreamLoadTelemetry = {
    source: 'none',
    reason: null,
    sizeBytes: null,
    durationMs: 0,
    attemptedMemory: false,
    buffer: noBufferTelemetry(),
  }
  private deviceNumbers = new Map<string, number>()
  private nextDeviceNumber = 1
  private onDeviceChanged: ((deviceId: number) => void) | null = null
  private gaplessHooks: GaplessHooks | null = null
  private eqApplier: ((player: NativePlayer) => void) | null = null
  private memoryPromotionAbort: AbortController | null = null
  private memoryPromotionToken = 0
  private loadGeneration = 0
  private loadTail: Promise<void> = Promise.resolve()

  setOnDeviceChanged(cb: ((deviceId: number) => void) | null): void {
    this.onDeviceChanged = cb
  }

  setGaplessHooks(hooks: GaplessHooks | null): void {
    this.gaplessHooks = hooks
  }

  /** EQManager installs this to push its state into the native player. */
  setEqApplier(apply: ((player: NativePlayer) => void) | null): void {
    this.eqApplier = apply
    if (apply && this.player) apply(this.player)
  }

  /** The main native player, for EQ updates. Null until the engine starts. */
  getPlayer(): NativePlayer | null {
    return this.player
  }

  private cancelMemoryPromotion(): void {
    this.memoryPromotionToken += 1
    if (this.memoryPromotionAbort) {
      this.memoryPromotionAbort.abort()
      this.memoryPromotionAbort = null
    }
  }

  ensureInit(): void {
    if (this.initialized) return
    // Automated smoke tests route audio to miniaudio's silent null device.
    initEngine(process.env.CRATE_AUDIO_NULL_OUTPUT === '1' ? CA_INIT_NULL_BACKEND : 0)
    this.player = new NativePlayer(true)
    this.player.setVolume(this.volume)
    this.initialized = true
    this.eqApplier?.(this.player)
    this.outputReady = this.openOutputDevice().catch(err => {
      console.error('[audio] could not open the audio output:', err instanceof Error ? err.message : err)
    })
    this.eventTimer = setInterval(() => this.handleEvents(), EVENT_POLL_MS)
    this.eventTimer.unref?.()
    console.log('[audio] crate-audio engine initialized')
  }

  private async openOutputDevice(): Promise<void> {
    await openOutput(this.outputDeviceId, this.outputPolicy)
    this.broadcastOutputInfo()
  }

  private get deck(): NativePlayer {
    this.ensureInit()
    return this.player!
  }

  private nextSerial(): number {
    this.serialCounter += 1
    return this.serialCounter
  }

  // ------------------------------------------------------------ helpers

  private closeDecoder(decoder: Decoder | null | undefined): void {
    if (!decoder) return
    if (!decoder.closed) this.retiring.delete(decoder.nativeHandle)
    decoder.close()
  }

  /** Keeps a decoder alive until the native player retires it. */
  private retireLater(item: DeckItem | null): void {
    if (!item || item.decoder.closed) return
    this.retiring.set(item.decoder.nativeHandle, item.decoder)
  }

  private toStreamInfo(info: CaStreamInfo): StreamInfo {
    const output = this.player ? getOutputInfo() : null
    return {
      freq: output?.open && output.sampleRate > 0 ? output.sampleRate : info.sampleRate,
      chans: info.channels,
      codec: info.codec,
      duration: info.duration > 0 ? info.duration : 0,
      sourceRate: info.sourceSampleRate,
      bitsPerSample: info.bitsPerSample,
    }
  }

  private refreshStreamInfo(item: DeckItem | null): void {
    if (item && !item.decoder.closed) item.info = this.toStreamInfo(item.decoder.info)
  }

  private telemetryFrom(result: StreamCreateResult, source: StreamLoadSource): StreamLoadTelemetry {
    return {
      source,
      reason: null,
      sizeBytes: result.sizeBytes,
      durationMs: result.durationMs,
      attemptedMemory: result.attemptedMemory,
      buffer: result.buffer,
    }
  }

  private resultFor(item: DeckItem | null, telemetry: StreamLoadTelemetry): StreamLoadResult {
    return {
      source: telemetry.source,
      reason: telemetry.reason,
      sizeBytes: telemetry.sizeBytes,
      durationMs: telemetry.durationMs,
      attemptedMemory: telemetry.attemptedMemory,
      streamInfo: item?.info ?? null,
      bufferedBytes: telemetry.buffer.bufferedBytes,
      totalBytes: telemetry.buffer.totalBytes,
      bufferedSec: telemetry.buffer.bufferedSec,
      bufferComplete: telemetry.buffer.bufferComplete,
    }
  }

  private updateCurrentStreamSource(nextSource: StreamLoadSource): void {
    const path = this.current?.path ?? null
    this.currentStreamSource = nextSource
    broadcast('audio:stream-source-changed', { source: this.currentStreamSource, currentPath: path })
  }

  private resetCurrentStreamLoadResult(): void {
    this.currentStreamLoadResult = {
      source: 'none',
      reason: null,
      sizeBytes: null,
      durationMs: 0,
      attemptedMemory: false,
      buffer: noBufferTelemetry(),
    }
  }

  // ------------------------------------------------------------- loading

  async load(path: string, options: LoadOptions = {}): Promise<StreamLoadResult> {
    const generation = ++this.loadGeneration
    const previousLoad = this.loadTail
    let releaseLoad!: () => void
    this.loadTail = new Promise<void>(resolve => { releaseLoad = resolve })

    await previousLoad
    try {
      if (generation !== this.loadGeneration) {
        throw new Error(`Audio load superseded before opening ${path}`)
      }
      return await this.loadExclusive(path, options, generation)
    } finally {
      releaseLoad()
    }
  }

  private async loadExclusive(path: string, options: LoadOptions, generation: number): Promise<StreamLoadResult> {
    this.ensureInit()
    this.cancelMemoryPromotion()
    const previousStatus = this.status
    this.setStatus('loading')

    const createdResult = await this.createStream(path, {
      estimatedDurationSec: options.estimatedDurationSec ?? null,
      cloudRef: options.cloudRef,
      cloudSizeBytes: options.cloudSizeBytes ?? null,
    })

    if (generation !== this.loadGeneration) {
      this.closeDecoder(createdResult.stream?.decoder)
      this.setStatus(previousStatus)
      throw new Error(`Audio load superseded while opening ${path}`)
    }

    if (!createdResult.stream) {
      // The old track keeps playing until a replacement exists: a corrupt or
      // missing next track must not stop audio that is already playing.
      this.setStatus(previousStatus)
      throw new Error(`Failed to load ${path}: ${createdResult.reason ?? 'unknown reason'}`)
    }

    await this.outputReady
    const created = createdResult.stream
    const source = createdResult.source === 'none' ? 'file' : createdResult.source
    const item: DeckItem = {
      serial: this.nextSerial(),
      path,
      decoder: created.decoder,
      info: created.info,
      memoryBuffer: created.memoryBuffer,
      telemetry: this.telemetryFrom(createdResult, source),
    }

    // Like BASS, a freshly loaded track waits for play().
    this.deck.pause()
    const replaced = [this.current, this.next]
    try {
      await this.deck.setSource(item.decoder, this.normalizationGain, item.serial)
    } catch (error) {
      this.closeDecoder(item.decoder)
      this.setStatus(previousStatus)
      throw error
    }
    for (const old of replaced) this.closeDecoder(old?.decoder)
    this.current = item
    this.next = null
    this.refreshStreamInfo(item)
    this.currentStreamSource = source
    this.currentStreamLoadResult = { ...item.telemetry }
    this.updateCurrentStreamSource(this.currentStreamSource)
    this.setStatus('paused')
    this.stopProgressTimer()
    this.broadcastOutputInfo()
    return this.getCurrentStreamLoadResult()
  }

  async promoteCurrentToMemory(options: PromoteCurrentToMemoryOptions = {}): Promise<StreamLoadResult> {
    this.ensureInit()
    const current = this.current
    if (!current) return this.getCurrentStreamLoadResult()
    if (this.currentStreamSource !== 'file') return this.getCurrentStreamLoadResult()
    if (options.expectedPath && options.expectedPath !== current.path) return this.getCurrentStreamLoadResult()

    const targetPath = current.path
    const controller = new AbortController()
    this.cancelMemoryPromotion()
    const promotionToken = ++this.memoryPromotionToken
    this.memoryPromotionAbort = controller

    const createResult = await this.createStream(targetPath, {
      memoryOnly: true,
      memoryReadTimeoutMs: options.memoryReadTimeoutMs ?? BACKGROUND_MEMORY_PROMOTION_TIMEOUT_MS,
      estimatedDurationSec: options.estimatedDurationSec ?? current.info.duration,
      abortSignal: controller.signal,
      onBufferProgress: buffer => {
        broadcast('audio:buffer-progress', {
          currentPath: targetPath,
          source: 'file',
          reason: null,
          bufferedBytes: buffer.bufferedBytes,
          totalBytes: buffer.totalBytes,
          bufferedSec: buffer.bufferedSec,
          bufferComplete: buffer.bufferComplete,
        })
      },
    })

    if (this.memoryPromotionAbort === controller) this.memoryPromotionAbort = null

    const stillCurrent = this.current === current && this.currentStreamSource === 'file'
    if (controller.signal.aborted || promotionToken !== this.memoryPromotionToken || !stillCurrent) {
      this.closeDecoder(createResult.stream?.decoder)
      return this.getCurrentStreamLoadResult()
    }

    if (!createResult.stream || createResult.source !== 'memory') {
      this.currentStreamLoadResult = {
        source: this.currentStreamSource,
        reason: createResult.reason,
        sizeBytes: createResult.sizeBytes,
        durationMs: createResult.durationMs,
        attemptedMemory: createResult.attemptedMemory,
        buffer: createResult.buffer,
      }
      broadcast('audio:buffer-progress', {
        currentPath: targetPath,
        source: this.currentStreamSource,
        reason: createResult.reason,
        bufferedBytes: createResult.buffer.bufferedBytes,
        totalBytes: createResult.buffer.totalBytes,
        bufferedSec: createResult.buffer.bufferedSec,
        bufferComplete: createResult.buffer.bufferComplete,
      })
      return this.getCurrentStreamLoadResult()
    }

    // The player continues from the RAM copy at the exact sample where the
    // file decoder stopped: no seek, no gap.
    const replaced = await this.deck.replaceSource(createResult.stream.decoder, current.serial)
    if (!replaced || this.current !== current) {
      this.closeDecoder(createResult.stream.decoder)
      return this.getCurrentStreamLoadResult()
    }
    this.closeDecoder(current.decoder)
    current.decoder = createResult.stream.decoder
    current.memoryBuffer = createResult.stream.memoryBuffer
    current.telemetry = {
      source: 'memory',
      reason: null,
      sizeBytes: createResult.sizeBytes,
      durationMs: createResult.durationMs,
      attemptedMemory: true,
      buffer: createResult.buffer,
    }
    this.currentStreamLoadResult = { ...current.telemetry }
    this.updateCurrentStreamSource('memory')
    return this.getCurrentStreamLoadResult()
  }

  getCurrentStreamSource(): StreamLoadSource { return this.currentStreamSource }
  getCurrentStreamLoadResult(): StreamLoadResult {
    return this.resultFor(this.current, this.currentStreamLoadResult)
  }

  // --------------------------------------------------------- gapless queue

  /** Queues a created stream right after the current track (gapless). */
  async queueNext(path: string, created: StreamCreateResult, gain: number): Promise<StreamLoadResult | null> {
    if (!created.stream) return null
    await this.outputReady
    if (!this.current) {
      this.closeDecoder(created.stream.decoder)
      return null
    }
    const source = created.source === 'none' ? 'file' : created.source
    const item: DeckItem = {
      serial: this.nextSerial(),
      path,
      decoder: created.stream.decoder,
      info: created.stream.info,
      memoryBuffer: created.stream.memoryBuffer,
      telemetry: this.telemetryFrom(created, source),
    }
    const previous = this.next
    try {
      await this.deck.queueNext(item.decoder, gain, item.serial)
    } catch (error) {
      this.closeDecoder(item.decoder)
      throw error
    }
    this.closeDecoder(previous?.decoder)
    this.next = item
    this.refreshStreamInfo(item)
    return this.resultFor(item, item.telemetry)
  }

  getNextPath(): string | null { return this.next?.path ?? null }
  hasNext(): boolean { return this.next !== null }
  getNextResult(): StreamLoadResult | null {
    return this.next ? this.resultFor(this.next, this.next.telemetry) : null
  }

  clearNext(): void {
    if (!this.next) return
    const next = this.next
    this.next = null
    if (this.player) this.player.clearNext()
    this.closeDecoder(next.decoder)
  }

  /** Starts the queued track now (manual "next"). */
  async skipToNext(expectedPath?: string | null): Promise<StreamLoadResult | null> {
    const next = this.next
    if (!next || (expectedPath && next.path !== expectedPath)) return null
    const ok = await this.deck.skipToNext(next.serial)
    if (!ok) return null
    if (this.next === next) {
      // Not already followed through a natural transition event.
      const previous = this.current
      this.adoptNext()
      this.closeDecoder(previous?.decoder)
    }
    this.deck.play()
    this.setStatus('playing')
    this.startProgressTimer()
    return this.getCurrentStreamLoadResult()
  }

  private adoptNext(): void {
    const next = this.next
    if (!next) return
    this.current = next
    this.next = null
    this.refreshStreamInfo(next)
    this.currentStreamSource = next.telemetry.source
    this.currentStreamLoadResult = { ...next.telemetry }
    this.updateCurrentStreamSource(this.currentStreamSource)
  }

  // ------------------------------------------------------------ events

  private handleEvents(): void {
    if (!this.player) return
    let events
    try {
      events = pollEvents()
    } catch {
      return
    }
    for (const event of events) {
      switch (event.type) {
        case CA_EVENT_TRACK_STARTED:
          if (event.playerId === this.player.id && this.next && event.serial === this.next.serial) {
            // The sample-accurate hand-over already happened natively; follow it.
            this.retireLater(this.current)
            this.adoptNext()
            const current = this.current!
            broadcast('audio:gapless-fired', {
              path: current.path,
              streamInfo: current.info,
              source: this.currentStreamSource,
            })
            this.gaplessHooks?.onNaturalAdvance(current.path, this.getCurrentStreamLoadResult())
            this.broadcastOutputInfo()
          }
          break
        case CA_EVENT_TRACK_ENDED:
          if (event.playerId === this.player.id && this.current && event.serial === this.current.serial) {
            this.setStatus('stopped')
            this.stopProgressTimer()
            this.emitProgress()
            this.gaplessHooks?.onTrackEnded()
            broadcast('audio:track-ended')
          }
          break
        case CA_EVENT_DECODER_RETIRED: {
          const decoder = this.retiring.get(event.decoder)
          if (decoder) {
            this.retiring.delete(event.decoder)
            decoder.close()
          }
          break
        }
        case CA_EVENT_OUTPUT_CHANGED:
          this.refreshStreamInfo(this.current)
          this.refreshStreamInfo(this.next)
          this.broadcastOutputInfo()
          break
        case CA_EVENT_DEVICE_LOST:
          this.handleDeviceLost()
          break
        case CA_EVENT_DEVICE_REROUTED:
          // The system default changed: reopen so the format matches the new device.
          if (this.outputDeviceId == null) {
            this.outputReady = this.openOutputDevice().catch(err => {
              console.warn('[audio] reopening after a device change failed:', err instanceof Error ? err.message : err)
            })
          }
          broadcast('audio:devices-changed')
          break
        case CA_EVENT_DECODE_ERROR:
          console.warn(`[audio] decode error in track ${event.serial} (code ${event.code})`)
          break
        default:
          break
      }
    }
  }

  private handleDeviceLost(): void {
    console.warn('[audio] the output device disappeared; falling back to the system default')
    this.outputDeviceId = null
    this.outputReady = this.openOutputDevice().catch(err => {
      console.error('[audio] could not reopen the default output:', err instanceof Error ? err.message : err)
    })
    broadcast('audio:devices-changed')
  }

  // ------------------------------------------------------------ transport

  play(): void {
    if (!this.current) return
    this.deck.play()
    this.setStatus('playing')
    this.startProgressTimer()
  }

  pause(): void {
    if (!this.current) return
    this.deck.pause()
    this.setStatus('paused')
    this.stopProgressTimer()
  }

  stop(): void {
    if (!this.current) return
    this.deck.pause()
    this.deck.seek(0)
    this.setStatus('paused')
    this.stopProgressTimer()
    this.emitProgress()
  }

  seek(seconds: number): void {
    if (!this.current) return
    const duration = this.current.info.duration
    const clamped = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds)
    this.deck.seek(clamped)
    this.emitProgress()
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.player) this.player.setVolume(this.volume)
  }

  // Set the volume-leveler multiplier (1.0 = unchanged) of the track being
  // heard; applied immediately so a config change is audible right away.
  setNormalizationGain(linear: number): void {
    const gain = Number.isFinite(linear) && linear > 0 ? linear : 1.0
    if (this.normalizationGain === gain) return
    this.normalizationGain = gain
    if (this.player) this.player.setGain(gain)
  }

  getNormalizationGain(): number { return this.normalizationGain }

  setFftMode(mode: FftMode, screenHz?: number): void {
    const nextScreenIntervalMs = this.intervalFromScreenHz(screenHz)
    if (this.fftMode === mode && this.screenFftIntervalMs === nextScreenIntervalMs) return
    this.fftMode = mode
    this.screenFftIntervalMs = nextScreenIntervalMs
    this.syncFrameTimer()
  }

  // Toggle real-time L/R level metering. The renderer turns this on only while a
  // VU meter is mounted; the actual timer is additionally gated on playback.
  setMeterEnabled(enabled: boolean): void {
    if (this.meterEnabled === enabled) return
    this.meterEnabled = enabled
    this.syncFrameTimer()
  }

  getStatus(): PlaybackStatus {
    if (this.status === 'loading') return 'loading'
    if (!this.current || !this.player) return 'stopped'
    const state = this.player.status()
    if (state.state === CA_PLAYER_PLAYING) return 'playing'
    if (state.state === CA_PLAYER_PAUSED) return 'paused'
    return state.ended ? 'stopped' : 'paused'
  }

  getCurrentPath(): string | null { return this.current?.path ?? null }
  getStreamInfo(): StreamInfo | null { return this.current?.info ?? null }
  getVolume(): number { return this.volume }

  // Position (in seconds) in the track being heard.
  getPosition(): number {
    if (!this.current || !this.player) return 0
    return this.player.status().position
  }

  // ------------------------------------------------------------- output

  private deviceNumber(uid: string): number {
    let number = this.deviceNumbers.get(uid)
    if (number == null) {
      number = this.nextDeviceNumber++
      this.deviceNumbers.set(uid, number)
    }
    return number
  }

  private toOutputDevice(device: NativeDeviceInfo, output: NativeOutputInfo | null): AudioOutputDevice {
    const isCurrent = this.outputDeviceId == null ? device.isDefault : device.id === this.outputDeviceId
    return {
      id: this.deviceNumber(device.id),
      uid: device.id,
      name: device.name.trim() || 'Output',
      driver: device.id || null,
      flags: 0,
      isDefault: device.isDefault,
      isCurrent,
      isInitialized: isCurrent && Boolean(output?.open),
      supportsExclusive: device.supportsExclusive,
      maxSampleRate: device.maxSampleRate,
      maxBits: device.maxBits,
    }
  }

  listOutputDevices(): AudioOutputDevice[] {
    this.ensureInit()
    const output = getOutputInfo()
    return listNativeDevices().map(device => this.toOutputDevice(device, output))
  }

  getOutputDevice(): AudioOutputDevice | null {
    const devices = this.listOutputDevices()
    return devices.find(d => d.isCurrent) ?? devices.find(d => d.isDefault) ?? devices[0] ?? null
  }

  async setOutputDevice(deviceId: number): Promise<AudioOutputDevice> {
    this.ensureInit()
    const devices = listNativeDevices()
    const target = devices.find(device => this.deviceNumber(device.id) === deviceId)
    if (!target) throw new Error(`Audio output device ${deviceId} is not available`)
    this.outputDeviceId = target.id
    this.outputReady = this.openOutputDevice()
    await this.outputReady
    const selected = this.getOutputDevice() ?? this.toOutputDevice(target, getOutputInfo())
    this.onDeviceChanged?.(selected.id)
    return selected
  }

  getOutputPolicy(): NativeOutputPolicy {
    return { ...this.outputPolicy }
  }

  /** Bit-perfect and exclusive mode. Playback continues where it was. */
  async setOutputPolicy(policy: Partial<NativeOutputPolicy>): Promise<OutputInfoPayload> {
    this.outputPolicy = { ...this.outputPolicy, ...policy }
    if (!this.initialized) return this.getOutputInfoPayload()
    await this.outputReady
    await setNativeOutputPolicy(this.outputPolicy)
    this.broadcastOutputInfo()
    return this.getOutputInfoPayload()
  }

  getOutputInfoPayload(): OutputInfoPayload {
    const info = this.initialized ? getOutputInfo() : null
    const source = this.current && !this.current.decoder.closed ? this.current.decoder.info : null
    return {
      open: Boolean(info?.open),
      deviceName: info?.deviceName ?? '',
      exclusive: info?.exclusive ?? this.outputPolicy.exclusive,
      bitPerfectSetting: this.outputPolicy.bitPerfect,
      sourceRate: source ? source.sourceSampleRate : null,
      sourceBits: source ? source.bitsPerSample : null,
      sourceIsDsd: source?.isDsd ?? false,
      sourceIsFloat: source?.isFloat ?? false,
      sourceLossless: source?.isLossless ?? false,
      sourceChannels: source?.sourceChannels ?? null,
      outputRate: info?.open ? info.sampleRate : null,
      outputBits: info?.open ? info.current.bits || info.bits : null,
      outputChannels: info?.open ? info.channels : null,
      resampled: info?.current.resampled ?? false,
      dithered: info?.current.dithered ?? false,
      downmixed: info?.current.downmixed ?? false,
      limitedBy: info?.current.limitedBy ?? 0,
      volume: this.volume,
      normalizationGain: this.normalizationGain,
    }
  }

  broadcastOutputInfo(): void {
    if (!this.initialized) return
    broadcast('audio:output-changed', this.getOutputInfoPayload())
  }

  // ------------------------------------------------------------ creation

  // Create a stream for playback. We prefer a full in-memory file buffer so
  // playback is detached from slow/removable storage after the initial read.
  async createStream(
    path: string,
    options: CreateStreamOptions = {},
  ): Promise<StreamCreateResult> {
    this.ensureInit()
    const start = Date.now()

    // Cloud identifiers are never filesystem paths. Fetch the complete track
    // into RAM and intentionally avoid stat/open/file-stream fallbacks.
    if (options.cloudRef) {
      return this.createCloudStream(path, options.cloudRef, options, start)
    }

    const fileStats = await this.getAudioFileStats(path, start)
    if (!fileStats.ok) return fileStats.result

    const fileSizeBytes = fileStats.sizeBytes
    // A gapless preload while the current track is already in memory is the
    // "second track": relax the memory budget so both can stay resident when
    // free RAM > 1 GB.
    const allowSecondTrack = !!options.isPreload && this.currentStreamSource === 'memory'
    const memoryResult = options.skipMemory
      ? {
        stream: null,
        source: 'none',
        reason: 'memory-skipped',
        sizeBytes: fileSizeBytes,
        durationMs: 0,
        attemptedMemory: false,
        buffer: noBufferTelemetry(),
      } as StreamCreateResult
      : await this.createMemoryStream(path, fileSizeBytes, {
        timeoutMs: options.memoryReadTimeoutMs,
        allowSecondTrack,
        estimatedDurationSec: options.estimatedDurationSec ?? null,
        abortSignal: options.abortSignal,
        onBufferProgress: options.onBufferProgress,
      })

    if (memoryResult.stream) {
      return memoryResult
    }
    if (options.memoryOnly) {
      return {
        ...memoryResult,
        source: memoryResult.source,
      }
    }

    // A preload that could not get its RAM copy reports why; the renderer
    // falls back to a normal load later.
    if (options.isPreload) {
      return {
        stream: null,
        source: 'none',
        reason: memoryResult.reason,
        sizeBytes: memoryResult.sizeBytes ?? fileSizeBytes,
        durationMs: Date.now() - start,
        attemptedMemory: memoryResult.attemptedMemory,
        buffer: noBufferTelemetry(),
      }
    }

    // Decode straight from the file; FFmpeg reads it on the player's thread.
    const fileStream = await this.createFileStream(path)
    return {
      stream: fileStream,
      source: fileStream ? 'file' : 'none',
      reason: fileStream ? null : (memoryResult.reason ?? 'file-stream-failed'),
      sizeBytes: memoryResult.sizeBytes ?? fileSizeBytes,
      durationMs: Date.now() - start,
      attemptedMemory: memoryResult.attemptedMemory,
      buffer: noBufferTelemetry(),
    }
  }

  private async createCloudStream(
    path: string,
    cloudRef: CloudTrackRef,
    options: CreateStreamOptions,
    start: number,
  ): Promise<StreamCreateResult> {
    const sizeBytes = options.cloudSizeBytes ?? 0
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      return {
        stream: null,
        source: 'none',
        reason: 'cloud-size-unknown',
        sizeBytes: null,
        durationMs: Date.now() - start,
        attemptedMemory: false,
        buffer: noBufferTelemetry(),
      }
    }
    if (options.skipMemory) {
      return {
        stream: null,
        source: 'none',
        reason: 'memory-skipped',
        sizeBytes,
        durationMs: Date.now() - start,
        attemptedMemory: false,
        buffer: noBufferTelemetry(),
      }
    }

    const allowSecondTrack = !!options.isPreload && this.currentStreamSource === 'memory'
    return this.createMemoryStream(path, sizeBytes, {
      timeoutMs: options.memoryReadTimeoutMs ?? CLOUD_MEMORY_TIMEOUT_MS,
      allowSecondTrack,
      estimatedDurationSec: options.estimatedDurationSec ?? null,
      abortSignal: options.abortSignal,
      onBufferProgress: options.onBufferProgress,
      cloudRef,
    })
  }

  private async getAudioFileStats(path: string, start: number): Promise<
    | { ok: true; stats: Awaited<ReturnType<typeof stat>>; sizeBytes: number }
    | { ok: false; result: StreamCreateResult }
  > {
    try {
      const stats = await stat(path)
      if (!stats.isFile()) {
        return {
          ok: false,
          result: {
            stream: null,
            source: 'none',
            reason: 'not-a-file',
            sizeBytes: stats.size,
            durationMs: Date.now() - start,
            attemptedMemory: true,
            buffer: noBufferTelemetry(),
          },
        }
      }
      return { ok: true, stats, sizeBytes: Number(stats.size) }
    } catch {
      return {
        ok: false,
        result: {
          stream: null,
          source: 'none',
          reason: 'file-stat-failed',
          sizeBytes: null,
          durationMs: Date.now() - start,
          attemptedMemory: true,
          buffer: noBufferTelemetry(),
        },
      }
    }
  }

  private makeBufferTelemetry(bufferedBytes: number, totalBytes: number, estimatedDurationSec: number | null | undefined): ProgressiveBufferTelemetry {
    return {
      bufferedBytes,
      totalBytes,
      bufferedSec: estimateBufferedSeconds(bufferedBytes, totalBytes, estimatedDurationSec),
      bufferComplete: bufferedBytes >= totalBytes,
    }
  }

  private async readPlaybackFileIntoBuffer(args: {
    path: string
    sizeBytes: number
    timeoutMs: number
    estimatedDurationSec?: number | null
    abortSignal?: AbortSignal
    onBufferProgress?: (telemetry: ProgressiveBufferTelemetry) => void
  }): Promise<{ buffer: Buffer | null; reason: StreamCreateFailureReason | null }> {
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => timeoutController.abort(), args.timeoutMs)
    let lastProgressAt = 0

    const emitProgress = (bufferedBytes: number, force = false) => {
      if (!args.onBufferProgress) return
      const now = Date.now()
      if (!force && now - lastProgressAt < 250) return
      lastProgressAt = now
      args.onBufferProgress(this.makeBufferTelemetry(bufferedBytes, args.sizeBytes, args.estimatedDurationSec))
    }

    try {
      const buffer = Buffer.allocUnsafe(args.sizeBytes)
      const file = await open(args.path, 'r')
      let offset = 0
      emitProgress(0, true)

      try {
        while (offset < args.sizeBytes) {
          if (timeoutController.signal.aborted) return { buffer: null, reason: 'memory-timeout' }
          if (args.abortSignal?.aborted) return { buffer: null, reason: 'memory-read-failed' }

          const bytesToRead = Math.min(PLAYBACK_MEMORY_READ_CHUNK_BYTES, args.sizeBytes - offset)
          const { bytesRead } = await file.read(buffer, offset, bytesToRead, offset)
          if (bytesRead <= 0) break
          offset += bytesRead
          emitProgress(offset)
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      } finally {
        await file.close().catch(() => { /* best-effort close */ })
      }

      if (timeoutController.signal.aborted) return { buffer: null, reason: 'memory-timeout' }
      if (args.abortSignal?.aborted) return { buffer: null, reason: 'memory-read-failed' }
      if (offset !== args.sizeBytes) return { buffer: null, reason: 'memory-read-failed' }
      emitProgress(args.sizeBytes, true)
      return { buffer, reason: null }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async readCloudTrackIntoBuffer(args: {
    cloudRef: CloudTrackRef
    sizeBytes: number
    timeoutMs: number
    estimatedDurationSec?: number | null
    abortSignal?: AbortSignal
    onBufferProgress?: (telemetry: ProgressiveBufferTelemetry) => void
  }): Promise<{ buffer: Buffer | null; reason: StreamCreateFailureReason | null }> {
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => timeoutController.abort(), args.timeoutMs)
    const combined = new AbortController()
    const onAbort = (): void => combined.abort()
    timeoutController.signal.addEventListener('abort', onAbort, { once: true })
    args.abortSignal?.addEventListener('abort', onAbort, { once: true })
    let lastProgressAt = 0

    const emitProgress = (bufferedBytes: number, force = false): void => {
      if (!args.onBufferProgress) return
      const now = Date.now()
      if (!force && now - lastProgressAt < 250) return
      lastProgressAt = now
      args.onBufferProgress(this.makeBufferTelemetry(bufferedBytes, args.sizeBytes, args.estimatedDurationSec))
    }

    try {
      const buffer = Buffer.allocUnsafe(args.sizeBytes)
      emitProgress(0, true)
      await getOneDriveClient().fetchFullIntoBuffer({
        driveId: args.cloudRef.driveId,
        itemId: args.cloudRef.itemId,
        sizeBytes: args.sizeBytes,
        buffer,
        signal: combined.signal,
        onProgress: loaded => emitProgress(loaded),
      })
      if (timeoutController.signal.aborted) return { buffer: null, reason: 'memory-timeout' }
      if (args.abortSignal?.aborted) return { buffer: null, reason: 'memory-read-failed' }
      emitProgress(args.sizeBytes, true)
      return { buffer, reason: null }
    } catch (error) {
      if (timeoutController.signal.aborted) return { buffer: null, reason: 'memory-timeout' }
      if (args.abortSignal?.aborted) return { buffer: null, reason: 'memory-read-failed' }
      if (error instanceof CloudAuthError) return { buffer: null, reason: 'cloud-auth-required' }
      console.warn('[audio] cloud stream read failed:', error instanceof Error ? error.message : error)
      return { buffer: null, reason: 'cloud-unreachable' }
    } finally {
      clearTimeout(timeoutId)
      timeoutController.signal.removeEventListener('abort', onAbort)
      args.abortSignal?.removeEventListener('abort', onAbort)
    }
  }

  private async createMemoryStream(path: string, sizeBytes: number, options: {
    timeoutMs?: number
    allowSecondTrack?: boolean
    estimatedDurationSec?: number | null
    abortSignal?: AbortSignal
    onBufferProgress?: (telemetry: ProgressiveBufferTelemetry) => void
    cloudRef?: CloudTrackRef
  } = {}): Promise<StreamCreateResult> {
    const start = Date.now()

    const memorySnapshot = getPlaybackMemorySnapshot()
    const memoryDecision = this.canUseMemoryForPlayback(sizeBytes, options.allowSecondTrack ?? false, memorySnapshot)
    if (!memoryDecision.canUse) {
      console.info('[audio] playback memory rejected', {
        path,
        reason: memoryDecision.reason,
        sizeBytes,
        freeMem: memorySnapshot.freeMemBytes,
        availableMem: memorySnapshot.availableMemBytes,
        totalMem: memorySnapshot.totalMemBytes,
        reserveBytes: calculatePlaybackMemoryReserveBytes({
          totalMemBytes: memorySnapshot.totalMemBytes,
          reserveBytes: PLAYBACK_MEMORY_RESERVE_BYTES,
        }),
        smallTrackGraceBytes: PLAYBACK_MEMORY_SMALL_TRACK_BYTES,
        minFreeAfterSmallTrackBytes: PLAYBACK_MEMORY_MIN_FREE_AFTER_SMALL_TRACK_BYTES,
      })
      return {
        stream: null,
        source: 'none',
        reason: memoryDecision.reason,
        sizeBytes: memoryDecision.sizeBytes,
        durationMs: Date.now() - start,
        attemptedMemory: true,
        buffer: noBufferTelemetry(),
      }
    }
    if (sizeBytes <= 0) {
      return {
        stream: null,
        source: 'none',
        reason: 'memory-empty',
        sizeBytes: null,
        durationMs: Date.now() - start,
        attemptedMemory: true,
        buffer: noBufferTelemetry(),
      }
    }

    try {
      const readResult = options.cloudRef
        ? await this.readCloudTrackIntoBuffer({
          cloudRef: options.cloudRef,
          sizeBytes,
          timeoutMs: options.timeoutMs ?? CLOUD_MEMORY_TIMEOUT_MS,
          estimatedDurationSec: options.estimatedDurationSec,
          abortSignal: options.abortSignal,
          onBufferProgress: options.onBufferProgress,
        })
        : await this.readPlaybackFileIntoBuffer({
          path,
          sizeBytes,
          timeoutMs: options.timeoutMs ?? PRELOAD_MEMORY_TIMEOUT_MS,
          estimatedDurationSec: options.estimatedDurationSec,
          abortSignal: options.abortSignal,
          onBufferProgress: options.onBufferProgress,
        })
      if (!readResult.buffer) {
        return {
          stream: null,
          source: 'none',
          reason: readResult.reason ?? 'memory-read-failed',
          sizeBytes: readResult.reason === 'memory-timeout' ? null : sizeBytes,
          durationMs: Date.now() - start,
          attemptedMemory: true,
          buffer: noBufferTelemetry(),
        }
      }

      const buffer = readResult.buffer
      if (buffer.byteLength === 0) {
        return {
          stream: null,
          source: 'none',
          reason: 'memory-empty',
          sizeBytes: null,
          durationMs: Date.now() - start,
          attemptedMemory: true,
          buffer: noBufferTelemetry(),
        }
      }

      let decoder: Decoder
      try {
        decoder = Decoder.openMemory(buffer, path, { exactDuration: true })
      } catch (err) {
        console.warn(`[audio] cannot decode ${path} from memory:`, (err as Error).message)
        return {
          stream: null,
          source: 'none',
          reason: 'memory-stream-failed',
          sizeBytes: buffer.byteLength,
          durationMs: Date.now() - start,
          attemptedMemory: true,
          buffer: noBufferTelemetry(),
        }
      }

      const info = this.toStreamInfo(decoder.info)
      return {
        stream: { decoder, info, memoryBuffer: buffer },
        source: 'memory',
        reason: null,
        sizeBytes: buffer.byteLength,
        durationMs: Date.now() - start,
        attemptedMemory: true,
        buffer: completeBufferTelemetry(buffer.byteLength, info.duration),
      }
    } catch (err) {
      if (options.abortSignal?.aborted) {
        return {
          stream: null,
          source: 'none',
          reason: 'memory-read-failed',
          sizeBytes: null,
          durationMs: Date.now() - start,
          attemptedMemory: true,
          buffer: noBufferTelemetry(),
        }
      }
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          stream: null,
          source: 'none',
          reason: 'memory-timeout',
          sizeBytes: null,
          durationMs: Date.now() - start,
          attemptedMemory: true,
          buffer: noBufferTelemetry(),
        }
      }
      console.warn(`[audio] memory stream read failed for ${path}:`, (err as Error).message)
      return {
        stream: null,
        source: 'none',
        reason: 'memory-read-failed',
        sizeBytes: null,
        durationMs: Date.now() - start,
        attemptedMemory: true,
        buffer: noBufferTelemetry(),
      }
    }
  }

  private async createFileStream(path: string): Promise<CreatedStream | null> {
    try {
      const decoder = await Decoder.openFileAsync(path, { exactDuration: true })
      return { decoder, info: this.toStreamInfo(decoder.info), memoryBuffer: null }
    } catch (err) {
      console.warn(`[audio] cannot decode ${path}:`, (err as Error).message)
      return null
    }
  }

  private canUseMemoryForPlayback(
    size: number,
    allowSecondTrack = false,
    memorySnapshot: PlaybackMemorySnapshot = getPlaybackMemorySnapshot(),
  ): { canUse: boolean; reason: StreamCreateFailureReason | null; sizeBytes: number } {
    return decidePlaybackMemoryUse({
      fileSizeBytes: size,
      freeMemBytes: memorySnapshot.availableMemBytes,
      totalMemBytes: memorySnapshot.totalMemBytes,
      reserveBytes: PLAYBACK_MEMORY_RESERVE_BYTES,
      allowSecondTrack,
    })
  }

  /** Closes a stream that was created but never handed to the player. */
  freeStream(stream: CreatedStream | null | undefined): void {
    this.closeDecoder(stream?.decoder)
  }

  // ------------------------------------------------------------- timers

  private setStatus(status: PlaybackStatus): void {
    if (this.status === status) return
    this.status = status
    broadcast('audio:state-changed', { status })
  }

  private startProgressTimer(): void {
    this.clearProgressTimer()
    this.progressTimer = setInterval(() => this.emitProgress(), 250)
    this.syncFrameTimer()
  }

  private stopProgressTimer(): void {
    this.clearProgressTimer()
    this.stopFrameTimer(true, true)
  }

  private clearProgressTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer)
      this.progressTimer = null
    }
  }

  private emitProgress(): void {
    if (!this.current) return
    broadcast('audio:progress', {
      positionSec: this.getPosition(),
      durationSec: this.current.info.duration,
    })
  }

  // Unified frame timer: a single setInterval pulses both FFT and meter at
  // their respective cadences, so the renderer doesn't get hit by two parallel
  // IPC streams when both are active at the same rate (the common case).
  private syncFrameTimer(): void {
    const playing = this.getStatus() === 'playing'
    const fftActive = playing && this.fftMode !== 'off'
    const meterActive = playing && this.meterEnabled

    if (!fftActive && !meterActive) {
      this.stopFrameTimer(true, true)
      return
    }

    const fftMs = fftActive
      ? (this.fftMode === 'screen'
        ? this.screenFftIntervalMs
        : this.fftMode === 'off'
          ? 0
          : FFT_INTERVAL_MS[this.fftMode])
      : 0
    const meterMs = meterActive ? METER_INTERVAL_MS : 0
    this.fftIntervalMs = fftMs

    const candidates = [fftMs, meterMs].filter(ms => ms > 0)
    const tickMs = Math.max(1, Math.min(...candidates))

    if (this.frameTimer && this.frameTickMs === tickMs) return

    this.stopFrameTimer(false, false)
    this.frameTickMs = tickMs
    this.lastFftAt = 0
    this.lastMeterAt = 0
    this.framePulse()
    this.frameTimer = setInterval(() => this.framePulse(), tickMs)
  }

  private framePulse(): void {
    const now = Date.now()
    if (this.getStatus() !== 'playing') return
    if (this.fftMode !== 'off' && this.fftIntervalMs > 0 && now - this.lastFftAt >= this.fftIntervalMs - 1) {
      this.lastFftAt = now
      this.emitFft()
    }
    if (this.meterEnabled && now - this.lastMeterAt >= METER_INTERVAL_MS - 1) {
      this.lastMeterAt = now
      this.emitLevels()
    }
  }

  private stopFrameTimer(sendFftFlatline: boolean, sendMeterFlatline: boolean): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer)
      this.frameTimer = null
      this.frameTickMs = 0
      this.fftIntervalMs = 0
    }
    if (sendFftFlatline) {
      this.fftOut.fill(0)
      broadcast('audio:fft', { bins: this.fftOut })
    }
    if (sendMeterFlatline) {
      broadcast('audio:levels', { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 })
    }
  }

  private emitFft(): void {
    if (!this.player || !this.current) return
    toDisplayBins(this.player.fft(), this.fftOut)
    broadcast('audio:fft', { bins: this.fftOut })
  }

  private emitLevels(): void {
    if (!this.player || !this.current) return
    const [peakL, peakR, rmsL, rmsR] = this.player.levels(METER_WINDOW_SEC)
    broadcast('audio:levels', { peakL, peakR, rmsL, rmsR })
  }

  private intervalFromScreenHz(screenHz: number | undefined): number {
    const hz = Number(screenHz)
    if (!Number.isFinite(hz) || hz <= 0) return DEFAULT_SCREEN_FFT_INTERVAL_MS
    const clampedHz = Math.max(30, Math.min(MAX_SCREEN_FFT_HZ, hz))
    return Math.max(DEFAULT_SCREEN_FFT_INTERVAL_MS, Math.round(1000 / clampedHz))
  }

  // ----------------------------------------------------------- lifecycle

  /** Release only the active track while keeping the output open. */
  unload(): void {
    this.cancelMemoryPromotion()
    if (this.player) this.player.detach()
    this.closeDecoder(this.current?.decoder)
    this.closeDecoder(this.next?.decoder)
    this.current = null
    this.next = null
    this.currentStreamSource = 'none'
    this.resetCurrentStreamLoadResult()
    this.stopProgressTimer()
    this.setStatus('stopped')
  }

  dispose(): void {
    this.unload()
    if (this.eventTimer) clearInterval(this.eventTimer)
    this.eventTimer = null
    if (!this.initialized) return
    // Closing the output restores the device's original rate and releases
    // exclusive access before the process exits.
    closeOutput()
    this.player?.destroy()
    this.player = null
    for (const decoder of this.retiring.values()) decoder.close()
    this.retiring.clear()
    shutdownEngine()
    this.initialized = false
  }
}

export function getAudioEngine(): AudioEngine {
  if (!engine) engine = new AudioEngine()
  return engine
}

export type NativePlayerHandle = NativePlayer
