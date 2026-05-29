// AudioEngine — single-track playback wrapper on top of the BASS FFI bindings.
// The renderer drives it via IPC; gapless + queue handling live in higher-level
// modules (GaplessController, queueStore).
//
// Design choices:
//   - All BASS calls are confined to the Electron main process main thread.
//   - Playback streams prefer a full in-memory copy of the source file. Disk
//     streaming remains a fallback when the RAM budget says no.
//   - The current stream handle is owned by this class. Gapless preloading
//     hands an additional in-memory stream over via adoptStream().

import { broadcast } from '../ipc/events'
import { open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import {
  BASS_ACTIVE_PAUSED, BASS_ACTIVE_PLAYING, BASS_ACTIVE_STOPPED,
  BASS_ATTRIB_VOL, BASS_DATA_FFT2048, BASS_DEVICE_DEFAULT, BASS_DEVICE_ENABLED,
  BASS_DEVICE_INIT, BASS_DEVICE_LOOPBACK, BASS_FILEDATA_END, BASS_FILE_MEM, BASS_FILE_NAME,
  BASS_LEVEL_RMS, BASS_LEVEL_STEREO, BASS_POS_BYTE, BASS_SAMPLE_FLOAT,
  BASS_STREAM_DECODE, BASS_STREAM_PRESCAN, STREAMFILE_BUFFERPUSH,
  bassErrorName,
} from './bass-constants'
import {
  copyBufferToPointer,
  loadBass,
  makeChannelGetInfo,
  registerFileProcs,
  type BassChannelInfo,
  type BassDeviceInfo,
  type HSTREAM,
  type RegisteredFileProcs,
} from './bass-ffi'
import { loadAllPlugins } from './PluginLoader'
import type {
  AudioOutputDevice,
  FftMode,
  PlaybackAnalysisResult,
  PlaybackTableBarsResult,
  StreamLoadSource,
  StreamLoadFailureReason,
} from '@shared/types/ipc-contract'
import {
  calculateProgressiveInitialBytes,
  decidePlaybackMemoryUse,
  estimateBufferedSeconds,
  PLAYBACK_MEMORY_RESERVE_BYTES,
  pumpProgressiveChunks,
  type ProgressiveBufferTelemetry,
} from './progressiveBuffering'

// FFT2048 returns 1024 complex bins as magnitudes (0..1).
const FFT_BINS_RAW = 1024
const FFT_BINS_OUT = 64
// Pre-computed log-spaced indices into the raw FFT array.
// Skewed so low frequencies get more visual real estate (bass is where most
// energy lives). Computed as floor(pow(1023, i / (n-1))).
const FFT_LOG_INDEX: number[] = Array.from({ length: FFT_BINS_OUT }, (_, i) => {
  const ratio = i / (FFT_BINS_OUT - 1)
  return Math.max(1, Math.min(FFT_BINS_RAW - 1, Math.floor(Math.pow(FFT_BINS_RAW - 1, ratio))))
})
const FFT_INTERVAL_MS: Record<Exclude<FftMode, 'off' | 'screen'>, number> = {
  mini: 90,
  full: 33,
}
const MAX_SCREEN_FFT_HZ = 60
const DEFAULT_SCREEN_FFT_INTERVAL_MS = Math.round(1000 / MAX_SCREEN_FFT_HZ)
const DEFAULT_OUTPUT_FREQ = 48000
const DEFAULT_OUTPUT_FLAGS = 0

// Level metering (VU): independent of FFT so the meters keep working even when
// no spectrum visualizer is mounted. ~30 Hz matches the 'full' FFT cadence.
const METER_INTERVAL_MS = 33
// How much audio ChannelGetLevelEx averages per measurement, in seconds.
const METER_WINDOW_SEC = 0.035

// Waveform extraction: decode the whole file once and downsample to this many
// max-abs buckets. Reads run in float chunks with event-loop yields so a long
// FLAC doesn't block playback. Results are cached per file fingerprint
// (bounded LRU-ish) as a short-lived layer over the persistent DB cache.
const WAVEFORM_DEFAULT_BUCKETS = 1200
const WAVEFORM_READ_FLOATS = 65536
const ANALYSIS_CACHE_MAX = 50
const TABLE_BARS_FPS = 60
const TABLE_BARS_BANDS = 5
const TABLE_BARS_DISPLAY_GAIN = 2.8
const PRELOAD_MEMORY_TIMEOUT_MS = 1000

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
  freq: number          // sample rate in Hz
  chans: number
  ctype: number         // BASS stream type (codec id)
  duration: number      // seconds
  durationBytes: bigint
  bytesPerSecond: number
}

interface CreatedStream {
  handle: HSTREAM
  info: StreamInfo
  memoryBuffer: Buffer | null
  progressive: ProgressiveStreamState | null
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

interface AdoptStreamOptions {
  shouldPlay?: boolean
  startPositionSec?: number
  restoreStatus?: PlaybackStatus
  // Optional source metadata when this stream was created as part of a known
  // load attempt (e.g. memory promotion).
  sourceResult?: {
    source: StreamLoadSource
    reason: StreamLoadFailureReason | null
    sizeBytes: number | null
    durationMs: number
    attemptedMemory: boolean
    buffer?: ProgressiveBufferTelemetry
  }
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
}

interface CreateStreamOptions {
  memoryOnly?: boolean
  skipMemory?: boolean
  memoryReadTimeoutMs?: number
  allowProgressive?: boolean
  estimatedDurationSec?: number | null
}

interface ProgressiveStreamState {
  handle: HSTREAM
  path: string
  totalBytes: number
  bufferedBytes: number
  durationSec: number | null
  initialBytes: number
  complete: boolean
  aborted: boolean
  fileHandle: FileHandle
  callbacks: RegisteredFileProcs
}

let engine: AudioEngine | null = null

export class AudioEngine {
  private initialized = false
  private currentStream: HSTREAM = 0
  private currentPath: string | null = null
  private streamInfo: StreamInfo | null = null
  private volume = 1.0
  private status: PlaybackStatus = 'stopped'
  private progressTimer: NodeJS.Timeout | null = null
  private frameTimer: NodeJS.Timeout | null = null
  private frameTickMs = 0
  private fftMode: FftMode = 'off'
  private fftIntervalMs = 0
  private screenFftIntervalMs = DEFAULT_SCREEN_FFT_INTERVAL_MS
  private fftBuffer: Float32Array = new Float32Array(FFT_BINS_RAW)
  private fftOut: number[] = new Array(FFT_BINS_OUT).fill(0)
  private lastFftAt = 0
  private lastMeterAt = 0
  private meterEnabled = false
  private levelBuf: Float32Array = new Float32Array(2)
  private currentMemoryBuffer: Buffer | null = null
  private currentStreamSource: StreamLoadSource = 'none'
  private currentStreamLoadResult: StreamLoadTelemetry = {
    source: 'none',
    reason: null,
    sizeBytes: null,
    durationMs: 0,
    attemptedMemory: false,
    buffer: noBufferTelemetry(),
  }
  private currentProgressiveStream: ProgressiveStreamState | null = null
  private progressiveStreamsByHandle = new Map<HSTREAM, ProgressiveStreamState>()
  private analysisCache = new Map<string, PlaybackAnalysisResult>()
  private tableBarsCache = new Map<string, PlaybackTableBarsResult>()
  private getInfo: ReturnType<typeof makeChannelGetInfo> | null = null
  // Optional listener invoked after setOutputDevice succeeds. Used by
  // ExclusiveModeManager to transfer hog ownership across device switches
  // without coupling the manager into the engine directly.
  private onDeviceChanged: ((bassDeviceId: number) => void) | null = null

  setOnDeviceChanged(cb: ((bassDeviceId: number) => void) | null): void {
    this.onDeviceChanged = cb
  }

  ensureInit(): void {
    if (this.initialized) return
    const bass = loadBass()
    // device=-1 lets BASS pick the default output, freq=44100 is a sane
    // default — BASS will resample our streams as needed. flags=0 keeps the
    // BASSFLOAT/sample-rate-sync features off for now.
    const ok = bass.Init(-1, DEFAULT_OUTPUT_FREQ, DEFAULT_OUTPUT_FLAGS, 0n, 0n)
    if (!ok) {
      const code = bass.ErrorGetCode()
      throw new Error(`BASS_Init failed: ${bassErrorName(code)} (${code})`)
    }
    const result = loadAllPlugins()
    if (result.skipped.length > 0) {
      console.warn('[audio] skipped plugins:', result.skipped.map(s => `${s.name}(${s.reason})`).join(', '))
    }
    console.log(`[audio] BASS initialized, ${result.loaded.length} plugins loaded`)
    this.getInfo = makeChannelGetInfo()
    this.initialized = true
  }

  // Free the current stream (if any) and clear cached info.
  private freeCurrent(): void {
    if (this.currentStream !== 0) {
      this.freeStream(this.currentStream)
      this.currentStream = 0
    }
    this.currentPath = null
    this.streamInfo = null
    this.currentStreamSource = 'none'
    this.resetCurrentStreamLoadResult()
    this.currentMemoryBuffer = null
    this.currentProgressiveStream = null
    this.stopProgressTimer()
    this.setStatus('stopped')
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

  private updateCurrentStreamSource(nextSource: StreamLoadSource): void {
    const path = this.currentPath
    this.currentStreamSource = nextSource
    broadcast('audio:stream-source-changed', { source: this.currentStreamSource, currentPath: path })
  }

  private setCurrentStreamLoadResult(sourceResult: {
    source: StreamLoadSource
    reason: StreamLoadFailureReason | null
    sizeBytes: number | null
    durationMs: number
    attemptedMemory: boolean
    buffer?: ProgressiveBufferTelemetry
  }): void {
    this.currentStreamLoadResult = {
      source: sourceResult.source,
      reason: sourceResult.reason,
      sizeBytes: sourceResult.sizeBytes,
      durationMs: sourceResult.durationMs,
      attemptedMemory: sourceResult.attemptedMemory,
      buffer: sourceResult.buffer ?? noBufferTelemetry(),
    }
  }

  async load(path: string, options: LoadOptions = {}): Promise<StreamLoadResult> {
    this.ensureInit()
    this.setStatus('loading')

    const createdResult = await this.createStream(path, {
      allowProgressive: true,
      estimatedDurationSec: options.estimatedDurationSec ?? null,
    })
    if (!createdResult.stream) {
      this.currentPath = path
      this.currentStream = 0
      this.currentMemoryBuffer = null
      this.streamInfo = null
      this.currentProgressiveStream = null
      this.setCurrentStreamLoadResult({
        source: 'none',
        reason: createdResult.reason,
        sizeBytes: createdResult.sizeBytes,
        durationMs: createdResult.durationMs,
        attemptedMemory: createdResult.attemptedMemory,
        buffer: createdResult.buffer,
      })
      this.currentStreamSource = 'none'
      this.stopProgressTimer()
      this.setStatus('stopped')
      throw new Error(`Failed to load ${path}: ${createdResult.reason ?? 'unknown reason'}`)
    }
    const created = createdResult.stream
    const { handle, info } = created
    const old = this.releaseCurrent()
    if (old.handle !== 0) this.freeStream(old.handle)

    this.currentStream = handle
    this.currentPath = path
    this.currentMemoryBuffer = created.memoryBuffer
    this.currentProgressiveStream = created.progressive
    this.currentStreamSource = createdResult.source
    this.setCurrentStreamLoadResult({
      source: this.currentStreamSource,
      reason: null,
      sizeBytes: createdResult.sizeBytes,
      durationMs: createdResult.durationMs,
      attemptedMemory: createdResult.attemptedMemory,
      buffer: createdResult.buffer,
    })

    // Apply current volume to the freshly created stream.
    loadBass().ChannelSetAttribute(handle, BASS_ATTRIB_VOL, this.volume)
    this.updateCurrentStreamSource(this.currentStreamSource)

    this.streamInfo = info
    this.setStatus('paused')
    return this.getCurrentStreamLoadResult()
  }

  async promoteCurrentToMemory(): Promise<StreamLoadResult> {
    this.ensureInit()
    if (this.currentStream === 0 || !this.currentPath || !this.streamInfo) {
      return this.getCurrentStreamLoadResult()
    }
    if (this.currentStreamSource !== 'file') return this.getCurrentStreamLoadResult()

    const currentPosition = this.getPosition()
    const restoreStatus = this.getStatus()
    const shouldPlay = restoreStatus === 'playing'
    const createResult = await this.createStream(this.currentPath, {
      memoryOnly: true,
      memoryReadTimeoutMs: PRELOAD_MEMORY_TIMEOUT_MS,
    })

    if (!createResult.stream || createResult.source !== 'memory') {
      this.setCurrentStreamLoadResult({
        source: this.currentStreamSource,
        reason: createResult.reason,
        sizeBytes: createResult.sizeBytes,
        durationMs: createResult.durationMs,
        attemptedMemory: createResult.attemptedMemory,
        buffer: createResult.buffer,
      })
      return this.getCurrentStreamLoadResult()
    }

    const old = this.releaseCurrent()
    if (old.handle !== 0) this.freeStream(old.handle)
    this.adoptStream(createResult.stream.handle, this.currentPath, createResult.stream.memoryBuffer, {
      startPositionSec: currentPosition,
      shouldPlay,
      restoreStatus,
      sourceResult: {
        source: 'memory',
        reason: null,
        sizeBytes: createResult.sizeBytes,
        durationMs: createResult.durationMs,
        attemptedMemory: true,
        buffer: createResult.buffer,
      },
    })
    this.updateCurrentStreamSource('memory')
    return this.getCurrentStreamLoadResult()
  }

  getCurrentStreamSource(): StreamLoadSource { return this.currentStreamSource }
  getCurrentStreamLoadResult(): StreamLoadResult {
    return {
      source: this.currentStreamLoadResult.source,
      reason: this.currentStreamLoadResult.reason,
      sizeBytes: this.currentStreamLoadResult.sizeBytes,
      durationMs: this.currentStreamLoadResult.durationMs,
      attemptedMemory: this.currentStreamLoadResult.attemptedMemory,
      streamInfo: this.streamInfo,
      bufferedBytes: this.currentStreamLoadResult.buffer.bufferedBytes,
      totalBytes: this.currentStreamLoadResult.buffer.totalBytes,
      bufferedSec: this.currentStreamLoadResult.buffer.bufferedSec,
      bufferComplete: this.currentStreamLoadResult.buffer.bufferComplete,
    }
  }

  private computeStreamInfo(handle: HSTREAM): StreamInfo {
    const bass = loadBass()
    const lengthBytes = bass.ChannelGetLength(handle, BASS_POS_BYTE)
    const chInfo = this.getInfo!(handle) as BassChannelInfo

    // For float-sample streams BASS reports lengthBytes in bytes regardless,
    // and seconds = bytes / (freq * chans * bytesPerSample). We let BASS do
    // the math via attribute query in newer versions, but a manual calc
    // (assuming 32-bit float) works for our common case.
    const bytesPerSample = 4 // BASS_SAMPLE_FLOAT → 32-bit
    const bytesPerSecond = chInfo.freq * chInfo.chans * bytesPerSample
    const duration = Number(lengthBytes) / bytesPerSecond

    return {
      freq: chInfo.freq,
      chans: chInfo.chans,
      ctype: chInfo.ctype,
      duration,
      durationBytes: lengthBytes,
      bytesPerSecond,
    }
  }

  play(): void {
    if (this.currentStream === 0) return
    const bass = loadBass()
    const ok = bass.ChannelPlay(this.currentStream, 0)
    if (!ok) {
      const code = bass.ErrorGetCode()
      throw new Error(`BASS_ChannelPlay failed: ${bassErrorName(code)} (${code})`)
    }
    this.setStatus('playing')
    this.startProgressTimer()
  }

  pause(): void {
    if (this.currentStream === 0) return
    const bass = loadBass()
    bass.ChannelPause(this.currentStream)
    this.setStatus('paused')
    this.stopProgressTimer()
  }

  stop(): void {
    if (this.currentStream === 0) return
    const bass = loadBass()
    bass.ChannelStop(this.currentStream)
    bass.ChannelSetPosition(this.currentStream, 0n, BASS_POS_BYTE)
    this.setStatus('paused')
    this.stopProgressTimer()
    this.emitProgress()
  }

  seek(seconds: number): void {
    if (this.currentStream === 0 || !this.streamInfo) return
    const bass = loadBass()
    const clamped = Math.max(0, Math.min(seconds, this.streamInfo.duration))
    const bytes = BigInt(Math.floor(clamped * this.streamInfo.bytesPerSecond))
    bass.ChannelSetPosition(this.currentStream, bytes, BASS_POS_BYTE)
    this.emitProgress()
  }

  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v))
    this.volume = clamped
    if (this.currentStream !== 0) {
      const bass = loadBass()
      bass.ChannelSetAttribute(this.currentStream, BASS_ATTRIB_VOL, clamped)
    }
  }

  setFftMode(mode: FftMode, screenHz?: number): void {
    const nextScreenIntervalMs = this.intervalFromScreenHz(screenHz)
    if (this.fftMode === mode && this.screenFftIntervalMs === nextScreenIntervalMs) return
    this.fftMode = mode
    this.screenFftIntervalMs = nextScreenIntervalMs
    this.syncFftTimer()
  }

  // Toggle real-time L/R level metering. The renderer turns this on only while a
  // VU meter is mounted; the actual timer is additionally gated on playback.
  setMeterEnabled(enabled: boolean): void {
    if (this.meterEnabled === enabled) return
    this.meterEnabled = enabled
    this.syncMeterTimer()
  }

  listOutputDevices(): AudioOutputDevice[] {
    this.ensureInit()
    const bass = loadBass()
    const currentDevice = bass.GetDevice()
    const devices: AudioOutputDevice[] = []

    for (let id = 1; id < 256; id += 1) {
      const info = this.readDeviceInfo(id)
      if (!info) break
      if ((info.flags & BASS_DEVICE_ENABLED) === 0) continue
      if ((info.flags & BASS_DEVICE_LOOPBACK) !== 0) continue
      devices.push(this.toOutputDevice(id, info, currentDevice))
    }

    return devices
  }

  getOutputDevice(): AudioOutputDevice | null {
    const devices = this.listOutputDevices()
    return devices.find(d => d.isCurrent) ?? devices.find(d => d.isDefault) ?? devices[0] ?? null
  }

  setOutputDevice(deviceId: number): AudioOutputDevice {
    this.ensureInit()
    const target = this.readDeviceInfo(deviceId)
    if (!target || (target.flags & BASS_DEVICE_ENABLED) === 0 || (target.flags & BASS_DEVICE_LOOPBACK) !== 0) {
      throw new Error(`Audio output device ${deviceId} is not available`)
    }

    const bass = loadBass()
    const wasPlaying = this.getStatus() === 'playing'

    if ((target.flags & BASS_DEVICE_INIT) === 0) {
      const ok = bass.Init(deviceId, DEFAULT_OUTPUT_FREQ, DEFAULT_OUTPUT_FLAGS, 0n, 0n)
      if (!ok) {
        const code = bass.ErrorGetCode()
        throw new Error(`BASS_Init device ${deviceId} failed: ${bassErrorName(code)} (${code})`)
      }
    }

    if (!bass.SetDevice(deviceId)) {
      const code = bass.ErrorGetCode()
      throw new Error(`BASS_SetDevice ${deviceId} failed: ${bassErrorName(code)} (${code})`)
    }

    if (this.currentStream !== 0) {
      if (!bass.ChannelSetDevice(this.currentStream, deviceId)) {
        const code = bass.ErrorGetCode()
        throw new Error(`BASS_ChannelSetDevice failed: ${bassErrorName(code)} (${code})`)
      }
      bass.ChannelSetAttribute(this.currentStream, BASS_ATTRIB_VOL, this.volume)

      if (wasPlaying) {
        if (!bass.Start()) {
          const code = bass.ErrorGetCode()
          console.warn(`[audio] BASS_Start on device ${deviceId} failed: ${bassErrorName(code)} (${code})`)
        }
        if (!bass.ChannelPlay(this.currentStream, 0)) {
          const code = bass.ErrorGetCode()
          throw new Error(`BASS_ChannelPlay after device switch failed: ${bassErrorName(code)} (${code})`)
        }
        this.setStatus('playing')
        this.startProgressTimer()
      }
    }

    const result = this.getOutputDevice() ?? this.toOutputDevice(deviceId, target, deviceId)
    if (this.onDeviceChanged) this.onDeviceChanged(deviceId)
    return result
  }

  // Tear BASS down on the currently active output device so the underlying
  // OS audio device can be mutated (e.g. taking CoreAudio hog mode). Frees
  // the current stream and the BASS device but leaves engine state so
  // reinitDevice() + load() can resume from the same path/position.
  teardownForReinit(): void {
    if (!this.initialized) return
    const bass = loadBass()
    if (this.currentStream !== 0) {
      try { bass.ChannelStop(this.currentStream) } catch { /* may already be stopped */ }
      try { this.freeStream(this.currentStream) } catch { /* best-effort */ }
      this.currentStream = 0
    }
    this.currentPath = null
    this.streamInfo = null
    this.currentMemoryBuffer = null
    this.currentProgressiveStream = null
    this.currentStreamSource = 'none'
    this.resetCurrentStreamLoadResult()
    this.stopProgressTimer()
    this.setStatus('stopped')
    // BASS_Free targets the current device; ensure we're on the right one
    // before calling. SetDevice can fail if the device wasn't initialized,
    // which is fine — there's nothing to free in that case.
    bass.Free()
  }

  // Re-initialize BASS on the requested device after a teardownForReinit().
  // The caller is responsible for re-loading whatever stream they had before.
  reinitDevice(deviceId: number): void {
    const bass = loadBass()
    const ok = bass.Init(deviceId, DEFAULT_OUTPUT_FREQ, DEFAULT_OUTPUT_FLAGS, 0n, 0n)
    if (!ok) {
      const code = bass.ErrorGetCode()
      throw new Error(`BASS_Init device ${deviceId} reinit failed: ${bassErrorName(code)} (${code})`)
    }
    if (!bass.SetDevice(deviceId)) {
      const code = bass.ErrorGetCode()
      throw new Error(`BASS_SetDevice ${deviceId} after reinit failed: ${bassErrorName(code)} (${code})`)
    }
    this.initialized = true
  }

  moveStreamToOutputDevice(handle: HSTREAM, deviceId: number): boolean {
    if (handle === 0) return true
    this.ensureInit()
    const bass = loadBass()
    return Boolean(bass.ChannelSetDevice(handle, deviceId))
  }

  getStatus(): PlaybackStatus {
    if (this.currentStream === 0) return 'stopped'
    const bass = loadBass()
    const active = bass.ChannelIsActive(this.currentStream)
    switch (active) {
      case BASS_ACTIVE_PLAYING: return 'playing'
      case BASS_ACTIVE_PAUSED:  return 'paused'
      case BASS_ACTIVE_STOPPED: return 'stopped'
      default:                  return this.status
    }
  }

  getCurrentStream(): HSTREAM { return this.currentStream }
  getCurrentPath(): string | null { return this.currentPath }
  getStreamInfo(): StreamInfo | null { return this.streamInfo }
  getVolume(): number { return this.volume }

  private readDeviceInfo(deviceId: number): BassDeviceInfo | null {
    const bass = loadBass()
    const info = { name: null, driver: null, flags: 0 } as Record<string, unknown>
    if (!bass.GetDeviceInfo(deviceId, info)) return null
    return info as unknown as BassDeviceInfo
  }

  private toOutputDevice(deviceId: number, info: BassDeviceInfo, currentDevice: number): AudioOutputDevice {
    return {
      id: deviceId,
      name: info.name?.trim() || `Output ${deviceId}`,
      driver: info.driver?.trim() || null,
      flags: info.flags,
      isDefault: (info.flags & BASS_DEVICE_DEFAULT) !== 0,
      isCurrent: deviceId === currentDevice,
      isInitialized: (info.flags & BASS_DEVICE_INIT) !== 0,
      // The engine doesn't know about CoreAudio — supportsExclusive is filled
      // in at the IPC boundary by ExclusiveModeManager.isSupportedDevice().
      supportsExclusive: false,
    }
  }

  // Position (in seconds) computed from the current byte cursor.
  getPosition(): number {
    if (this.currentStream === 0 || !this.streamInfo) return 0
    const bass = loadBass()
    const bytes = bass.ChannelGetPosition(this.currentStream, BASS_POS_BYTE)
    return Number(bytes) / this.streamInfo.bytesPerSecond
  }

  // Hand the current stream off to a caller (e.g. GaplessController preserving
  // a preloaded stream). This class no longer owns it after the call.
  releaseCurrent(): { handle: HSTREAM; path: string | null; info: StreamInfo | null; memoryBuffer: Buffer | null } {
    const out = {
      handle: this.currentStream,
      path: this.currentPath,
      info: this.streamInfo,
      memoryBuffer: this.currentMemoryBuffer,
    }
    this.currentStream = 0
    this.currentPath = null
    this.streamInfo = null
    this.currentMemoryBuffer = null
    this.currentStreamSource = 'none'
    this.currentProgressiveStream = null
    this.resetCurrentStreamLoadResult()
    this.stopProgressTimer()
    return out
  }

  // Adopt a preloaded stream as the current one (used by GaplessController
  // when swapping).
  adoptStream(handle: HSTREAM, path: string, memoryBuffer: Buffer | null = null, options: AdoptStreamOptions = {}): StreamInfo {
    const shouldPlay = options.shouldPlay ?? true
    const startPosition = options.startPositionSec ?? 0
    const restoreStatus = options.restoreStatus ?? (shouldPlay ? 'playing' : 'paused')

    let info: StreamInfo
    try {
      info = this.computeStreamInfo(handle)
    } catch (err) {
      this.freeStream(handle)
      throw new Error(`Adopted stream is no longer valid: ${(err as Error).message}`)
    }
    this.currentStream = handle
    this.currentPath = path
    this.currentMemoryBuffer = memoryBuffer
    this.currentProgressiveStream = this.progressiveStreamsByHandle.get(handle) ?? null
    this.currentStreamSource = options.sourceResult?.source ?? (memoryBuffer ? 'memory' : 'file')
    this.setCurrentStreamLoadResult({
      source: options.sourceResult?.source ?? this.currentStreamSource,
      reason: options.sourceResult?.reason ?? null,
      sizeBytes: options.sourceResult?.sizeBytes ?? Number(info.durationBytes),
      durationMs: options.sourceResult?.durationMs ?? 0,
      attemptedMemory: options.sourceResult?.attemptedMemory ?? memoryBuffer != null,
      buffer: options.sourceResult?.buffer ?? completeBufferTelemetry(memoryBuffer ? memoryBuffer.byteLength : null, info.duration),
    })
    this.streamInfo = info
    const bass = loadBass()
    const clampedStart = Math.max(0, Math.min(startPosition, info.duration))
    const startBytes = BigInt(Math.floor(clampedStart * info.bytesPerSecond))

    if (startBytes > 0n) bass.ChannelSetPosition(handle, startBytes, BASS_POS_BYTE)
    // Set volume before starting playback so the swap doesn't blip to full
    // volume for a frame. Start playback BEFORE setStatus/startProgressTimer:
    // syncFftTimer() queries BASS for the live channel state, so the channel
    // must already be playing or it would stop the FFT timer (visualizer
    // freezes after a gapless swap).
    bass.ChannelSetAttribute(handle, BASS_ATTRIB_VOL, this.volume)

    if (shouldPlay) {
      const playStarted = bass.ChannelPlay(handle, 0)
      if (!playStarted) {
        const code = bass.ErrorGetCode()
        this.freeStream(handle)
        this.currentStream = 0
        this.currentPath = null
        this.currentMemoryBuffer = null
        this.streamInfo = null
        this.currentStreamSource = 'none'
        this.resetCurrentStreamLoadResult()
        this.currentStreamLoadResult.reason = 'file-stream-failed'
        this.setStatus('stopped')
        throw new Error(`Failed to start playback after gapless swap: ${bassErrorName(code)} (${code})`)
      }
      this.setStatus('playing')
      this.startProgressTimer()
    } else {
      this.setStatus(restoreStatus)
      this.stopProgressTimer()
    }
    this.updateCurrentStreamSource(this.currentStreamSource)
    return info
  }

  // Create a stream for playback. We prefer a full in-memory file buffer so
  // playback is detached from slow/removable storage after the initial read.
  async createStream(
    path: string,
    options: CreateStreamOptions = {},
  ): Promise<StreamCreateResult> {
    this.ensureInit()
    const start = Date.now()
    const fileStats = await this.getAudioFileStats(path, start)
    if (!fileStats.ok) return fileStats.result

    const fileSizeBytes = fileStats.sizeBytes
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
      : await this.createMemoryStream(path, fileSizeBytes, options.memoryReadTimeoutMs)

    if (memoryResult.stream) {
      return memoryResult
    }
    if (options.memoryOnly) {
      return {
        ...memoryResult,
        source: memoryResult.source,
      }
    }

    if (options.allowProgressive && memoryResult.reason === 'memory-timeout') {
      const progressiveStream = await this.createProgressiveStream(
        path,
        fileSizeBytes,
        options.estimatedDurationSec ?? null,
        start,
      )
      if (progressiveStream.stream) return progressiveStream
    }

    const fileStream = this.createFileStream(path)
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

  private async createMemoryStream(path: string, sizeBytes: number, timeoutMs = PRELOAD_MEMORY_TIMEOUT_MS): Promise<StreamCreateResult> {
    const start = Date.now()

    const memoryDecision = this.canUseMemoryForPlayback(sizeBytes)
    if (!memoryDecision.canUse) {
      console.info('[audio] preload memory rejected', {
        path,
        reason: memoryDecision.reason,
        sizeBytes,
        freeMem: freemem(),
        totalMem: totalmem(),
        reserveBytes: Math.max(PLAYBACK_MEMORY_RESERVE_BYTES, Math.floor(totalmem() * 0.05)),
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

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const signal = controller.signal
      const buffer = await readFile(path, { signal })
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

      const bass = loadBass()
      const handle = bass.StreamCreateFileMemory(
        BASS_FILE_MEM,
        buffer,
        0n,
        BigInt(buffer.byteLength),
        BASS_STREAM_PRESCAN | BASS_SAMPLE_FLOAT,
      )
      if (handle === 0) {
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

      const info = this.computeStreamInfo(handle)
      return {
        stream: { handle, info, memoryBuffer: buffer, progressive: null },
        source: 'memory',
        reason: null,
        sizeBytes: buffer.byteLength,
        durationMs: Date.now() - start,
        attemptedMemory: true,
        buffer: completeBufferTelemetry(buffer.byteLength, info.duration),
      }
    } catch (err) {
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
    } finally {
      clearTimeout(timeoutId)
    }

  }

  private async createProgressiveStream(
    path: string,
    sizeBytes: number,
    estimatedDurationSec: number | null,
    overallStart: number,
  ): Promise<StreamCreateResult> {
    const memoryDecision = this.canUseMemoryForPlayback(sizeBytes)
    if (!memoryDecision.canUse || sizeBytes <= 0) {
      return {
        stream: null,
        source: 'none',
        reason: memoryDecision.reason ?? 'memory-size-limit',
        sizeBytes,
        durationMs: Date.now() - overallStart,
        attemptedMemory: true,
        buffer: noBufferTelemetry(),
      }
    }

    const initialBytes = calculateProgressiveInitialBytes({
      fileSizeBytes: sizeBytes,
      durationSec: estimatedDurationSec,
    })
    if (initialBytes <= 0) {
      return {
        stream: null,
        source: 'none',
        reason: 'memory-empty',
        sizeBytes,
        durationMs: Date.now() - overallStart,
        attemptedMemory: true,
        buffer: noBufferTelemetry(),
      }
    }

    let fileHandle: FileHandle | null = null
    let callbacks: RegisteredFileProcs | null = null
    let handle: HSTREAM = 0
    const initialBuffer = Buffer.allocUnsafe(initialBytes)
    let initialBufferLength = 0
    let initialReadOffset = 0

    try {
      fileHandle = await open(path, 'r')
      initialBufferLength = await this.readIntoBuffer(fileHandle, initialBuffer, 0, initialBytes)
      if (initialBufferLength <= 0) {
        await fileHandle.close().catch(() => undefined)
        return {
          stream: null,
          source: 'none',
          reason: 'memory-empty',
          sizeBytes,
          durationMs: Date.now() - overallStart,
          attemptedMemory: true,
          buffer: noBufferTelemetry(),
        }
      }

      callbacks = registerFileProcs({
        close: () => undefined,
        length: () => BigInt(sizeBytes),
        read: (bufferPtr, requestedLength) => {
          const remaining = initialBufferLength - initialReadOffset
          if (remaining <= 0) return 0
          const bytesToCopy = Math.min(requestedLength, remaining)
          copyBufferToPointer(bufferPtr, initialBuffer.subarray(initialReadOffset, initialReadOffset + bytesToCopy))
          initialReadOffset += bytesToCopy
          return bytesToCopy
        },
        seek: offset => {
          const next = Number(offset)
          if (!Number.isSafeInteger(next) || next < 0 || next > initialBufferLength) return false
          initialReadOffset = next
          return true
        },
      })

      const bass = loadBass()
      handle = bass.StreamCreateFileUser(
        STREAMFILE_BUFFERPUSH,
        BASS_SAMPLE_FLOAT,
        callbacks.procs,
        0n,
      )
      if (handle === 0) {
        callbacks.unregister()
        await fileHandle.close().catch(() => undefined)
        return {
          stream: null,
          source: 'none',
          reason: 'progressive-stream-failed',
          sizeBytes,
          durationMs: Date.now() - overallStart,
          attemptedMemory: true,
          buffer: noBufferTelemetry(),
        }
      }

      const info = this.computeStreamInfo(handle)
      const durationSec = Number.isFinite(estimatedDurationSec ?? NaN) && (estimatedDurationSec ?? 0) > 0
        ? estimatedDurationSec
        : info.duration
      const state: ProgressiveStreamState = {
        handle,
        path,
        totalBytes: sizeBytes,
        bufferedBytes: initialBufferLength,
        durationSec,
        initialBytes: initialBufferLength,
        complete: initialBufferLength >= sizeBytes,
        aborted: false,
        fileHandle,
        callbacks,
      }
      this.progressiveStreamsByHandle.set(handle, state)
      this.startProgressivePump(state)

      const buffer = this.progressiveTelemetry(state)
      return {
        stream: { handle, info, memoryBuffer: null, progressive: state },
        source: state.complete ? 'memory' : 'progressive',
        reason: null,
        sizeBytes,
        durationMs: Date.now() - overallStart,
        attemptedMemory: true,
        buffer,
      }
    } catch (err) {
      console.warn(`[audio] progressive stream failed for ${path}:`, (err as Error).message)
      if (handle !== 0 && this.progressiveStreamsByHandle.has(handle)) {
        this.freeStream(handle)
      } else {
        if (handle !== 0) {
          try { loadBass().StreamFree(handle) } catch { /* best-effort */ }
        }
        callbacks?.unregister()
        if (fileHandle) await fileHandle.close().catch(() => undefined)
      }
      return {
        stream: null,
        source: 'none',
        reason: 'progressive-read-failed',
        sizeBytes,
        durationMs: Date.now() - overallStart,
        attemptedMemory: true,
        buffer: noBufferTelemetry(),
      }
    }
  }

  private async readIntoBuffer(fileHandle: FileHandle, target: Buffer, position: number, wantedBytes: number): Promise<number> {
    let bytesReadTotal = 0
    while (bytesReadTotal < wantedBytes) {
      const { bytesRead } = await fileHandle.read(
        target,
        bytesReadTotal,
        wantedBytes - bytesReadTotal,
        position + bytesReadTotal,
      )
      if (bytesRead <= 0) break
      bytesReadTotal += bytesRead
    }
    return bytesReadTotal
  }

  private progressiveTelemetry(state: ProgressiveStreamState): ProgressiveBufferTelemetry {
    return {
      bufferedBytes: state.bufferedBytes,
      totalBytes: state.totalBytes,
      bufferedSec: estimateBufferedSeconds(state.bufferedBytes, state.totalBytes, state.durationSec),
      bufferComplete: state.complete,
    }
  }

  private updateProgressiveBufferTelemetry(state: ProgressiveStreamState): void {
    const buffer = this.progressiveTelemetry(state)
    if (this.currentStream === state.handle && this.currentProgressiveStream === state) {
      this.currentStreamLoadResult = {
        ...this.currentStreamLoadResult,
        buffer,
      }
      broadcast('audio:buffer-progress', {
        currentPath: state.path,
        source: this.currentStreamLoadResult.source,
        ...buffer,
      })
    }
  }

  private startProgressivePump(state: ProgressiveStreamState): void {
    void pumpProgressiveChunks({
      totalBytes: state.totalBytes,
      startOffset: state.initialBytes,
      isAborted: () => state.aborted || !this.progressiveStreamsByHandle.has(state.handle),
      readChunk: async (offset, length) => {
        const buffer = Buffer.allocUnsafe(length)
        const bytesRead = await this.readIntoBuffer(state.fileHandle, buffer, offset, length)
        return bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead)
      },
      writeChunk: chunk => {
        const written = loadBass().StreamPutFileData(state.handle, chunk, chunk.byteLength)
        return written === 0xFFFFFFFF ? -1 : written
      },
      writeEnd: () => {
        loadBass().StreamPutFileData(state.handle, null, BASS_FILEDATA_END)
      },
      onProgress: bufferedBytes => {
        state.bufferedBytes = bufferedBytes
        this.updateProgressiveBufferTelemetry(state)
      },
    }).then(() => {
      if (state.aborted || !this.progressiveStreamsByHandle.has(state.handle)) return
      state.complete = true
      state.bufferedBytes = state.totalBytes
      this.updateProgressiveBufferTelemetry(state)
      if (this.currentStream === state.handle && this.currentProgressiveStream === state) {
        this.currentStreamLoadResult = {
          ...this.currentStreamLoadResult,
          source: 'memory',
          reason: null,
          buffer: this.progressiveTelemetry(state),
        }
        this.updateCurrentStreamSource('memory')
      }
      void state.fileHandle.close().catch(() => undefined)
    }).catch(err => {
      if (state.aborted || !this.progressiveStreamsByHandle.has(state.handle)) return
      console.warn(`[audio] progressive buffer failed for ${state.path}:`, (err as Error).message)
      if (this.currentStream === state.handle && this.currentProgressiveStream === state) {
        this.currentStreamLoadResult = {
          ...this.currentStreamLoadResult,
          reason: 'progressive-read-failed',
        }
        this.currentStream = 0
        this.currentPath = null
        this.streamInfo = null
        this.currentMemoryBuffer = null
        this.currentStreamSource = 'none'
        this.currentProgressiveStream = null
        this.stopProgressTimer()
        this.setStatus('stopped')
      }
      this.freeStream(state.handle)
    })
  }

  private createFileStream(path: string): CreatedStream | null {
    const bass = loadBass()
    const handle = bass.StreamCreateFile(BASS_FILE_NAME, path, 0n, 0n, BASS_STREAM_PRESCAN | BASS_SAMPLE_FLOAT)
    if (handle === 0) return null
    return { handle, info: this.computeStreamInfo(handle), memoryBuffer: null, progressive: null }
  }

  private canUseMemoryForPlayback(size: number): { canUse: boolean; reason: StreamCreateFailureReason | null; sizeBytes: number } {
    return decidePlaybackMemoryUse({
      fileSizeBytes: size,
      freeMemBytes: freemem(),
      totalMemBytes: totalmem(),
      reserveBytes: PLAYBACK_MEMORY_RESERVE_BYTES,
    })
  }

  private canFitPlaybackFileInMemory(bytes: number): boolean {
    const evalResult = this.canUseMemoryForPlayback(bytes)
    return evalResult.canUse
  }

  freeStream(handle: HSTREAM): void {
    if (handle === 0) return
    const bass = loadBass()
    bass.StreamFree(handle)
    const progressive = this.progressiveStreamsByHandle.get(handle)
    if (progressive) {
      progressive.aborted = true
      this.progressiveStreamsByHandle.delete(handle)
      if (this.currentProgressiveStream === progressive) this.currentProgressiveStream = null
      try { progressive.callbacks.unregister() } catch { /* already unregistered */ }
      void progressive.fileHandle.close().catch(() => undefined)
    }
  }

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
    if (!this.streamInfo) return
    broadcast('audio:progress', {
      positionSec: this.getPosition(),
      durationSec: this.streamInfo.duration,
    })
  }

  private syncFftTimer(): void {
    this.syncFrameTimer()
  }

  private syncMeterTimer(): void {
    this.syncFrameTimer()
  }

  // Unified frame timer: a single setInterval pulses both FFT and meter at
  // their respective cadences, so the renderer doesn't get hit by two parallel
  // IPC streams when both are active at the same rate (the common case).
  private syncFrameTimer(): void {
    const playing = this.getStatus() === 'playing' && this.currentStream !== 0
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

    if (this.frameTimer && this.frameTickMs === tickMs) {
      // Active set may have changed (e.g. meter turned off): emit a final
      // flatline on the channel that just stopped.
      return
    }

    this.stopFrameTimer(false, false)
    this.frameTickMs = tickMs
    this.lastFftAt = 0
    this.lastMeterAt = 0
    this.framePulse()
    this.frameTimer = setInterval(() => this.framePulse(), tickMs)
  }

  private framePulse(): void {
    const now = Date.now()
    const playing = this.getStatus() === 'playing' && this.currentStream !== 0
    if (!playing) return
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
    if (this.currentStream === 0) return
    const bass = loadBass()
    const ret = bass.ChannelGetData(this.currentStream, this.fftBuffer, BASS_DATA_FFT2048)
    if (ret === 0xFFFFFFFF) return  // -1 as uint32 → error / stream not playing
    // Downsample to FFT_BINS_OUT log-spaced bins with light scaling so faint
    // mids/highs are still visible. sqrt() pushes near-zero values up; the *1.6
    // gain keeps peaks near 1.0 for typical material.
    for (let i = 0; i < FFT_BINS_OUT; i++) {
      const idx = FFT_LOG_INDEX[i]
      const amp = this.fftBuffer[idx]
      this.fftOut[i] = Math.min(1, Math.sqrt(Math.max(0, amp)) * 1.6)
    }
    broadcast('audio:fft', { bins: this.fftOut })
  }

  private emitLevels(): void {
    if (this.currentStream === 0) return
    const bass = loadBass()
    // ChannelGetLevelEx writes one float per channel into levelBuf. STEREO → 2
    // values [L, R]; a second call with RMS swaps peak for RMS. length is in
    // SECONDS (not bytes like ChannelGetData). Returns FALSE when not playing.
    const okPeak = bass.ChannelGetLevelEx(this.currentStream, this.levelBuf, METER_WINDOW_SEC, BASS_LEVEL_STEREO)
    const peakL = okPeak ? this.levelBuf[0] : 0
    const peakR = okPeak ? this.levelBuf[1] : 0
    const okRms = bass.ChannelGetLevelEx(this.currentStream, this.levelBuf, METER_WINDOW_SEC, BASS_LEVEL_STEREO | BASS_LEVEL_RMS)
    const rmsL = okRms ? this.levelBuf[0] : 0
    const rmsR = okRms ? this.levelBuf[1] : 0
    broadcast('audio:levels', { peakL, peakR, rmsL, rmsR })
  }

  private analysisCacheKey(path: string, buckets: number): string {
    try {
      const st = statSync(path)
      return `${path}:${buckets}:${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      return `${path}:${buckets}`
    }
  }

  private tableBarsCacheKey(path: string): string {
    try {
      const st = statSync(path)
      return `${path}:table-bars:${st.size}:${Math.round(st.mtimeMs)}`
    } catch {
      return `${path}:table-bars`
    }
  }

  // Decode the whole file once on a separate decode stream and downsample to a
  // max-abs envelope. Computes a crest-factor approximation of dynamic range and
  // the true peak in the same pass. Yields to the event loop between reads so a
  // long file doesn't stall playback.
  async decodePlaybackAnalysis(path: string, buckets = WAVEFORM_DEFAULT_BUCKETS): Promise<PlaybackAnalysisResult> {
    const cacheKey = this.analysisCacheKey(path, buckets)
    const cached = this.analysisCache.get(cacheKey)
    if (cached && cached.buckets === buckets) return { ...cached, source: 'decoded' }

    this.ensureInit()
    const bass = loadBass()
    const handle = bass.StreamCreateFile(0, path, 0n, 0n, BASS_STREAM_DECODE | BASS_SAMPLE_FLOAT)
    if (handle === 0) {
      const code = bass.ErrorGetCode()
      throw new Error(`Waveform decode failed for ${path}: ${bassErrorName(code)} (${code})`)
    }

    try {
      const info = this.getInfo!(handle) as BassChannelInfo
      const chans = Math.max(1, info.chans)
      const lengthBytes = Number(bass.ChannelGetLength(handle, BASS_POS_BYTE))
      const totalFrames = Math.max(1, Math.floor(lengthBytes / (4 * chans)))
      const framesPerBucket = Math.max(1, Math.floor(totalFrames / buckets))

      const peaks = new Array(buckets).fill(0)
      const readFloats = WAVEFORM_READ_FLOATS - (WAVEFORM_READ_FLOATS % chans)
      const buf = new Float32Array(readFloats)
      let frameCursor = 0
      let globalPeak = 0
      let sumSq = 0
      let sampleCount = 0

      for (;;) {
        const ret = bass.ChannelGetData(handle, buf, readFloats * 4)
        if (ret === 0xFFFFFFFF) break          // error / end of stream
        const floatsRead = ret >>> 2           // bytes → float count
        if (floatsRead === 0) break
        for (let i = 0; i + chans <= floatsRead; i += chans) {
          let frameMax = 0
          for (let c = 0; c < chans; c++) {
            const s = buf[i + c]
            const a = Math.abs(s)
            if (a > frameMax) frameMax = a
            sumSq += s * s
          }
          sampleCount += chans
          if (frameMax > globalPeak) globalPeak = frameMax
          const b = Math.min(buckets - 1, Math.floor(frameCursor / framesPerBucket))
          if (frameMax > peaks[b]) peaks[b] = frameMax
          frameCursor++
        }
        await new Promise(resolve => setImmediate(resolve))
      }

      const rms = Math.sqrt(sumSq / Math.max(1, sampleCount))
      const peakDb = 20 * Math.log10(Math.max(1e-6, globalPeak))
      const drApprox = 20 * Math.log10(Math.max(1e-6, globalPeak) / Math.max(1e-6, rms))

      const result: PlaybackAnalysisResult = {
        peaks,
        drApprox,
        peakDb,
        buckets,
        analysisVersion: 2,
        source: 'decoded',
      }

      if (this.analysisCache.size >= ANALYSIS_CACHE_MAX) {
        const oldest = this.analysisCache.keys().next().value
        if (oldest !== undefined) this.analysisCache.delete(oldest)
      }
      this.analysisCache.set(cacheKey, result)
      return result
    } finally {
      bass.StreamFree(handle)
    }
  }

  async getWaveform(path: string, buckets = WAVEFORM_DEFAULT_BUCKETS): Promise<PlaybackAnalysisResult> {
    return this.decodePlaybackAnalysis(path, buckets)
  }

  async decodeTableBars(path: string): Promise<PlaybackTableBarsResult> {
    const cacheKey = this.tableBarsCacheKey(path)
    const cached = this.tableBarsCache.get(cacheKey)
    if (cached) return { ...cached, source: 'decoded' }

    this.ensureInit()
    const bass = loadBass()
    const handle = bass.StreamCreateFile(0, path, 0n, 0n, BASS_STREAM_DECODE | BASS_STREAM_PRESCAN | BASS_SAMPLE_FLOAT)
    if (handle === 0) {
      const code = bass.ErrorGetCode()
      throw new Error(`Table-bars decode failed for ${path}: ${bassErrorName(code)} (${code})`)
    }

    try {
      const info = this.computeStreamInfo(handle)
      const frames = Math.max(1, Math.ceil(info.duration * TABLE_BARS_FPS))
      const values = new Array(frames * TABLE_BARS_BANDS).fill(0)
      const fftBuffer = new Float32Array(FFT_BINS_RAW)
      const sourceBins = new Float32Array(FFT_BINS_OUT)
      const bands = new Float32Array(TABLE_BARS_BANDS)

      for (let frame = 0; frame < frames; frame++) {
        const seconds = Math.min(info.duration, frame / TABLE_BARS_FPS)
        const bytes = BigInt(Math.floor(seconds * info.bytesPerSecond))
        bass.ChannelSetPosition(handle, bytes, BASS_POS_BYTE)

        const ret = bass.ChannelGetData(handle, fftBuffer, BASS_DATA_FFT2048)
        if (ret !== 0xFFFFFFFF && ret !== 0) {
          for (let i = 0; i < FFT_BINS_OUT; i++) {
            const idx = FFT_LOG_INDEX[i]
            const amp = fftBuffer[idx]
            sourceBins[i] = Math.min(1, Math.sqrt(Math.max(0, amp)) * 1.6)
          }

          for (let b = 0; b < TABLE_BARS_BANDS; b++) {
            const start = Math.floor((b * FFT_BINS_OUT) / TABLE_BARS_BANDS)
            const end = Math.max(start + 1, Math.floor(((b + 1) * FFT_BINS_OUT) / TABLE_BARS_BANDS))
            let sum = 0
            for (let i = start; i < end; i++) sum += sourceBins[i] ?? 0
            bands[b] = sum / (end - start)
          }

          const offset = frame * TABLE_BARS_BANDS
          for (let b = 0; b < TABLE_BARS_BANDS; b++) {
            const raw = Math.max(0, Math.min(1, bands[b] ?? 0))
            values[offset + b] = Math.max(0, Math.min(1, Math.sqrt(raw * TABLE_BARS_DISPLAY_GAIN)))
          }
        }

        if (frame % TABLE_BARS_FPS === 0) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }

      const result: PlaybackTableBarsResult = {
        analysisVersion: 2,
        source: 'decoded',
        fps: TABLE_BARS_FPS,
        bands: TABLE_BARS_BANDS,
        frames,
        durationSec: info.duration,
        complete: true,
        values,
      }

      if (this.tableBarsCache.size >= ANALYSIS_CACHE_MAX) {
        const oldest = this.tableBarsCache.keys().next().value
        if (oldest !== undefined) this.tableBarsCache.delete(oldest)
      }
      this.tableBarsCache.set(cacheKey, result)
      return result
    } finally {
      bass.StreamFree(handle)
    }
  }

  private intervalFromScreenHz(screenHz: number | undefined): number {
    const hz = Number(screenHz)
    if (!Number.isFinite(hz) || hz <= 0) return DEFAULT_SCREEN_FFT_INTERVAL_MS
    const clampedHz = Math.max(30, Math.min(MAX_SCREEN_FFT_HZ, hz))
    return Math.max(DEFAULT_SCREEN_FFT_INTERVAL_MS, Math.round(1000 / clampedHz))
  }

  dispose(): void {
    this.freeCurrent()
    if (this.initialized) {
      loadBass().Free()
      this.initialized = false
    }
  }
}

export function getAudioEngine(): AudioEngine {
  if (!engine) engine = new AudioEngine()
  return engine
}
