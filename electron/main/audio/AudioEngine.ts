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
  BASS_DEVICE_INIT, BASS_DEVICE_LOOPBACK, BASS_LEVEL_RMS, BASS_LEVEL_STEREO,
  BASS_POS_BYTE, BASS_SAMPLE_FLOAT, BASS_STREAM_DECODE, BASS_STREAM_PRESCAN,
  bassErrorName,
} from './bass-constants'
import {
  loadBass,
  makeChannelGetInfo,
  type BassChannelInfo,
  type BassDeviceInfo,
  type HSTREAM,
} from './bass-ffi'
import { loadAllPlugins } from './PluginLoader'
import type { AudioOutputDevice, FftMode, WaveformResult } from '@shared/types/ipc-contract'

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
// FLAC doesn't block playback. Results are cached per path (bounded LRU-ish).
const WAVEFORM_DEFAULT_BUCKETS = 1200
const WAVEFORM_READ_FLOATS = 65536
const WAVEFORM_CACHE_MAX = 50

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
  private meterTimer: NodeJS.Timeout | null = null
  private meterEnabled = false
  private levelBuf: Float32Array = new Float32Array(2)
  private waveformCache = new Map<string, WaveformResult>()
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
      try { bass.StreamFree(this.currentStream) } catch { /* best-effort */ }
      this.currentStream = 0
    }
    this.currentPath = null
    this.streamInfo = null
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
    // Set volume before starting playback so the swap doesn't blip to full
    // volume for a frame. Start playback BEFORE setStatus/startProgressTimer:
    // syncFftTimer() queries BASS for the live channel state, so the channel
    // must already be playing or it would stop the FFT timer (visualizer
    // freezes after a gapless swap).
    bass.ChannelSetAttribute(handle, BASS_ATTRIB_VOL, this.volume)
    bass.ChannelPlay(handle, 0)
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
    this.syncMeterTimer()
  }

  private stopProgressTimer(): void {
    this.clearProgressTimer()
    this.stopFftTimer()
    this.stopMeterTimer()
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

  // Mirror of syncFftTimer for the VU meter feed. Runs only while metering is
  // requested, a stream exists, and it's actually playing.
  private syncMeterTimer(): void {
    if (!this.meterEnabled || this.getStatus() !== 'playing' || this.currentStream === 0) {
      this.stopMeterTimer()
      return
    }
    if (this.meterTimer) return
    this.emitLevels()
    this.meterTimer = setInterval(() => this.emitLevels(), METER_INTERVAL_MS)
  }

  private stopMeterTimer(sendFlatline = true): void {
    if (this.meterTimer) {
      clearInterval(this.meterTimer)
      this.meterTimer = null
    }
    if (sendFlatline) {
      broadcast('audio:levels', { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 })
    }
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

  // Decode the whole file once on a separate decode stream and downsample to a
  // max-abs envelope. Computes a crest-factor approximation of dynamic range and
  // the true peak in the same pass. Yields to the event loop between reads so a
  // long file doesn't stall playback. Results are cached per path.
  async getWaveform(path: string, buckets = WAVEFORM_DEFAULT_BUCKETS): Promise<WaveformResult> {
    const cached = this.waveformCache.get(path)
    if (cached && cached.buckets === buckets) return cached

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
      const result: WaveformResult = { peaks, drApprox, peakDb, buckets }

      if (this.waveformCache.size >= WAVEFORM_CACHE_MAX) {
        const oldest = this.waveformCache.keys().next().value
        if (oldest !== undefined) this.waveformCache.delete(oldest)
      }
      this.waveformCache.set(path, result)
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
