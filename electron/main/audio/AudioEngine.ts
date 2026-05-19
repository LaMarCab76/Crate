// AudioEngine — single-track playback wrapper on top of the BASS FFI bindings.
// The renderer drives it via IPC; gapless + queue handling live in higher-level
// modules (GaplessController, queueStore).
//
// Design choices:
//   - All BASS calls are confined to the Electron main process main thread.
//   - We stream from disk (BASS_StreamCreateFile mem=0). RAM-resident streams
//     and prefetching can be layered on later for fast skip-around behavior.
//   - The current stream handle is owned by this class. Gapless preloading
//     hands an additional preloaded stream over via takeStream().

import { broadcast } from '../ipc/events'
import {
  BASS_ACTIVE_PAUSED, BASS_ACTIVE_PLAYING, BASS_ACTIVE_STOPPED,
  BASS_ATTRIB_VOL, BASS_DATA_FFT2048, BASS_DEVICE_DEFAULT, BASS_DEVICE_ENABLED,
  BASS_DEVICE_INIT, BASS_DEVICE_LOOPBACK, BASS_POS_BYTE, BASS_SAMPLE_FLOAT,
  BASS_STREAM_PRESCAN, bassErrorName,
} from './bass-constants'
import {
  loadBass,
  makeChannelGetInfo,
  type BassChannelInfo,
  type BassDeviceInfo,
  type HSTREAM,
} from './bass-ffi'
import { loadAllPlugins } from './PluginLoader'
import type { AudioOutputDevice, FftMode } from '@shared/types/ipc-contract'

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

export type PlaybackStatus = 'stopped' | 'playing' | 'paused' | 'loading'

export interface StreamInfo {
  freq: number          // sample rate in Hz
  chans: number
  ctype: number         // BASS stream type (codec id)
  duration: number      // seconds
  durationBytes: bigint
  bytesPerSecond: number
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
  private fftTimer: NodeJS.Timeout | null = null
  private fftMode: FftMode = 'off'
  private fftIntervalMs = 0
  private screenFftIntervalMs = DEFAULT_SCREEN_FFT_INTERVAL_MS
  private fftBuffer: Float32Array = new Float32Array(FFT_BINS_RAW)
  private fftOut: number[] = new Array(FFT_BINS_OUT).fill(0)
  private getInfo: ReturnType<typeof makeChannelGetInfo> | null = null

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
      const bass = loadBass()
      bass.StreamFree(this.currentStream)
      this.currentStream = 0
    }
    this.currentPath = null
    this.streamInfo = null
    this.stopProgressTimer()
    this.setStatus('stopped')
  }

  load(path: string): StreamInfo {
    this.ensureInit()
    this.freeCurrent()
    this.setStatus('loading')

    const bass = loadBass()
    // BASS_STREAM_PRESCAN gives us accurate length on VBR formats up front,
    // BASS_SAMPLE_FLOAT keeps the decode path in 32-bit float so DSP (EQ)
    // doesn't introduce truncation noise.
    const handle = bass.StreamCreateFile(0, path, 0n, 0n, BASS_STREAM_PRESCAN | BASS_SAMPLE_FLOAT)
    if (handle === 0) {
      const code = bass.ErrorGetCode()
      throw new Error(`Failed to load ${path}: ${bassErrorName(code)} (${code})`)
    }
    this.currentStream = handle
    this.currentPath = path

    // Apply current volume to the freshly created stream.
    bass.ChannelSetAttribute(handle, BASS_ATTRIB_VOL, this.volume)

    const info = this.computeStreamInfo(handle)
    this.streamInfo = info
    this.setStatus('paused')
    return info
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

    return this.getOutputDevice() ?? this.toOutputDevice(deviceId, target, deviceId)
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
  releaseCurrent(): { handle: HSTREAM; path: string | null; info: StreamInfo | null } {
    const out = { handle: this.currentStream, path: this.currentPath, info: this.streamInfo }
    this.currentStream = 0
    this.currentPath = null
    this.streamInfo = null
    this.stopProgressTimer()
    return out
  }

  // Adopt a preloaded stream as the current one (used by GaplessController
  // when swapping).
  adoptStream(handle: HSTREAM, path: string): void {
    this.currentStream = handle
    this.currentPath = path
    this.streamInfo = this.computeStreamInfo(handle)
    const bass = loadBass()
    bass.ChannelSetAttribute(handle, BASS_ATTRIB_VOL, this.volume)
    this.setStatus('playing')
    this.startProgressTimer()
  }

  // Preload a stream for gapless. The handle is returned but no ownership
  // transfer happens — the caller (GaplessController) keeps it.
  createStream(path: string): { handle: HSTREAM; info: StreamInfo } {
    this.ensureInit()
    const bass = loadBass()
    const handle = bass.StreamCreateFile(0, path, 0n, 0n, BASS_STREAM_PRESCAN | BASS_SAMPLE_FLOAT)
    if (handle === 0) {
      const code = bass.ErrorGetCode()
      throw new Error(`Failed to preload ${path}: ${bassErrorName(code)} (${code})`)
    }
    return { handle, info: this.computeStreamInfo(handle) }
  }

  freeStream(handle: HSTREAM): void {
    if (handle === 0) return
    const bass = loadBass()
    bass.StreamFree(handle)
  }

  private setStatus(status: PlaybackStatus): void {
    if (this.status === status) return
    this.status = status
    broadcast('audio:state-changed', { status })
  }

  private startProgressTimer(): void {
    this.clearProgressTimer()
    this.progressTimer = setInterval(() => this.emitProgress(), 250)
    this.syncFftTimer()
  }

  private stopProgressTimer(): void {
    this.clearProgressTimer()
    this.stopFftTimer()
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
    if (this.fftMode === 'off' || this.getStatus() !== 'playing' || this.currentStream === 0) {
      this.stopFftTimer()
      return
    }

    const nextInterval = this.fftMode === 'screen'
      ? this.screenFftIntervalMs
      : FFT_INTERVAL_MS[this.fftMode]
    if (this.fftTimer && this.fftIntervalMs === nextInterval) return

    this.stopFftTimer(false)
    this.fftIntervalMs = nextInterval
    this.emitFft()
    this.fftTimer = setInterval(() => this.emitFft(), nextInterval)
  }

  private stopFftTimer(sendFlatline = true): void {
    if (this.fftTimer) {
      clearInterval(this.fftTimer)
      this.fftTimer = null
      this.fftIntervalMs = 0
    }
    if (sendFlatline) {
      // Send one final flatline frame so the renderer can settle bars to 0.
      this.fftOut.fill(0)
      broadcast('audio:fft', { bins: this.fftOut })
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
