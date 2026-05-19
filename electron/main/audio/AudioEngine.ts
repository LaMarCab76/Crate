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
  BASS_ATTRIB_VOL, BASS_POS_BYTE, BASS_SAMPLE_FLOAT,
  BASS_STREAM_PRESCAN, bassErrorName,
} from './bass-constants'
import { loadBass, makeChannelGetInfo, type BassChannelInfo, type HSTREAM } from './bass-ffi'
import { loadAllPlugins } from './PluginLoader'

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
  private getInfo: ReturnType<typeof makeChannelGetInfo> | null = null

  ensureInit(): void {
    if (this.initialized) return
    const bass = loadBass()
    // device=-1 lets BASS pick the default output, freq=44100 is a sane
    // default — BASS will resample our streams as needed. flags=0 keeps the
    // BASSFLOAT/sample-rate-sync features off for now.
    const ok = bass.Init(-1, 48000, 0, 0n, 0n)
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
    this.stopProgressTimer()
    this.progressTimer = setInterval(() => this.emitProgress(), 250)
  }

  private stopProgressTimer(): void {
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
