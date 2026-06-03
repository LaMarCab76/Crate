// Multi-band peaking equalizer. Each visible band is a standalone BASS_FX BQF
// peaking filter attached to the current stream. The band count is user-
// configurable (up to EQ_MAX_BAND_COUNT); the center frequencies and per-band
// bandwidth are derived from that count. FX handles must be re-attached when the
// underlying stream changes (gapless swap, track change) or when the band count
// changes, so AudioEngine notifies us via the reapply() entry point and
// setBandCount() reattaches internally.

import {
  BASS_FX_BFX_BQF,
  bassErrorName,
} from './bass-constants'
import {
  BASS_BFX_CHANALL,
  BASS_BFX_BQF_PEAKINGEQ,
  loadBassFx,
  type BqfParams,
} from './bass-fx-ffi'
import { loadBass, type HFX, type HSTREAM } from './bass-ffi'
import {
  EQ_DEFAULT_BAND_COUNT,
  clampEqBandCount,
  clampEqGain,
  eqBandFrequencies,
  eqBandwidthForCount,
  normalizeEqBands,
} from '@shared/constants/equalizer'

export interface EQState {
  enabled: boolean
  preset: string
  bands: number[]  // gains in dB, one per active band frequency
  bandCount: number
}

// Canonical preset curves, defined at the historical 10-band layout. They are
// re-interpolated onto whatever band count is currently active when applied.
const PRESET_DEFINITIONS: Record<string, number[]> = {
  Flat:       [  0,  0,  0,  0,  0,  0,  0,  0,  0,  0 ],
  Vocal:      [ -2, -1,  0,  1,  3,  3,  2,  1,  0, -1 ],
  Jazz:       [  2,  1,  0,  0, -1,  0,  1,  2,  3,  3 ],
  Electronic: [  4,  3,  1,  0, -2, -1,  1,  2,  3,  4 ],
  Acoustic:   [  3,  2,  1,  1,  2,  2,  1,  2,  3,  2 ],
}

let manager: EQManager | null = null

export class EQManager {
  private state: EQState = {
    enabled: false,
    preset: 'Flat',
    bands: normalizeEqBands(null, EQ_DEFAULT_BAND_COUNT),
    bandCount: EQ_DEFAULT_BAND_COUNT,
  }
  private currentStream: HSTREAM = 0
  private fxHandles: HFX[] = []
  private fxStream: HSTREAM = 0
  private streamSampleRate = 0
  private frequencies: number[] = eqBandFrequencies(EQ_DEFAULT_BAND_COUNT)
  private bandwidth: number = eqBandwidthForCount(EQ_DEFAULT_BAND_COUNT)

  getState(): EQState {
    return { ...this.state, bands: [...this.state.bands] }
  }

  getPresetNames(): string[] {
    return Object.keys(PRESET_DEFINITIONS)
  }

  setEnabled(enabled: boolean): void {
    if (this.state.enabled === enabled) return
    this.state.enabled = enabled
    this.reattachFX()
  }

  // Changing the band count remaps the current curve onto the new band centers,
  // recomputes the derived frequency/bandwidth tables, and fully reattaches the
  // FX chain because the active BQF band layout changed.
  setBandCount(count: number): void {
    const next = clampEqBandCount(count)
    if (next === this.state.bandCount) return
    this.state.bands = normalizeEqBands(this.state.bands, next)
    this.state.bandCount = next
    this.frequencies = eqBandFrequencies(next)
    this.bandwidth = eqBandwidthForCount(next)
    this.reattachFX()
  }

  setPreset(name: string): void {
    const preset = PRESET_DEFINITIONS[name]
    if (!preset) return
    this.state.preset = name
    this.state.bands = normalizeEqBands(preset, this.state.bandCount)
    if (this.ensureAttached()) {
      this.applyAllBandsToFx()
    }
  }

  setBand(index: number, gainDb: number): void {
    if (index < 0 || index >= this.state.bandCount) return
    const clamped = clampEqGain(gainDb)
    this.state.bands[index] = clamped
    this.state.preset = 'Custom'
    if (this.ensureAttached()) {
      this.applyBand(index)
    }
  }

  setBands(bands: number[]): void {
    if (!Array.isArray(bands)) return
    this.state.bands = normalizeEqBands(bands, this.state.bandCount)
    this.state.preset = 'Custom'
    if (this.ensureAttached()) {
      this.applyAllBandsToFx()
    }
  }

  previewBand(index: number, gainDb: number): boolean {
    if (!this.state.enabled || this.currentStream === 0) return false
    if (index < 0 || index >= this.state.bandCount) return false
    if (!this.ensureAttached() || !this.fxHandles[index]) return false
    this.applyBandWithGain(index, clampEqGain(gainDb))
    return true
  }

  // Called whenever the underlying stream changes (initial load, gapless swap).
  // Tears down old FX handles (they were attached to a stream that may no longer
  // exist) and re-attaches if the EQ is enabled.
  reapply(stream: HSTREAM): void {
    this.detachFX()
    this.currentStream = stream
    this.attachFX()
  }

  private reattachFX(): void {
    this.detachFX()
    this.attachFX()
  }

  private ensureAttached(): boolean {
    if (!this.state.enabled || this.currentStream === 0) return false
    if (this.fxHandles.length === 0) this.attachFX()
    return this.fxHandles.some(fx => fx !== 0)
  }

  private attachFX(): void {
    if (!this.state.enabled || this.currentStream === 0) return

    // Force libbass_fx to be dlopen'd before the first BASS_ChannelSetFX call.
    // Loading the library runs its static constructor, which registers the BFX
    // effect handlers with the core BASS. Without this, BASS doesn't recognise
    // the BASS_FX_BFX_* types and ChannelSetFX fails.
    loadBassFx()
    const bass = loadBass()
    this.fxStream = this.currentStream
    this.streamSampleRate = this.readStreamSampleRate(this.currentStream)
    this.fxHandles = []

    for (let i = 0; i < this.state.bandCount; i++) {
      const fx = bass.ChannelSetFX(this.currentStream, BASS_FX_BFX_BQF, 0)
      if (fx === 0) {
        const code = bass.ErrorGetCode()
        console.warn(`[eq] ChannelSetFX failed for band ${i} (${this.frequencies[i]} Hz): ${bassErrorName(code)} (${code})`)
        this.fxHandles[i] = 0
        continue
      }
      this.fxHandles[i] = fx
      this.applyBand(i)
    }
  }

  private detachFX(): void {
    if (this.fxHandles.length === 0) {
      this.fxStream = 0
      this.streamSampleRate = 0
      return
    }
    const bass = loadBass()
    if (this.fxStream !== 0) {
      for (const fx of this.fxHandles) {
        if (fx !== 0) bass.ChannelRemoveFX(this.fxStream, fx)
      }
    }
    this.fxHandles = []
    this.fxStream = 0
    this.streamSampleRate = 0
  }

  private applyAllBandsToFx(): void {
    for (let i = 0; i < this.state.bandCount; i++) this.applyBand(i)
  }

  private applyBand(index: number): void {
    this.applyBandWithGain(index, this.state.bands[index])
  }

  private applyBandWithGain(index: number, gainDb: number): void {
    const fx = this.fxHandles[index]
    if (!fx) return
    const fxLib = loadBassFx()
    const bass = loadBass()
    const center = this.clampCenterFrequency(this.frequencies[index])
    const params: BqfParams = {
      lFilter:    BASS_BFX_BQF_PEAKINGEQ,
      fCenter:    center,
      fGain:      clampEqGain(gainDb),
      fBandwidth: this.bandwidth,
      fQ:         0,
      fS:         0,
      lChannel:   BASS_BFX_CHANALL,
    }
    const ok = fxLib.FXSetBqfParameters(fx, params)
    if (!ok) {
      const code = bass.ErrorGetCode()
      console.warn(`[eq] FXSetParameters failed for band ${index} (${center} Hz): ${bassErrorName(code)} (${code})`)
    }
  }

  private readStreamSampleRate(stream: HSTREAM): number {
    const bass = loadBass()
    const info = {
      freq: 0, chans: 0, flags: 0, ctype: 0,
      origres: 0, plugin: 0, sample: 0, filename: null,
    } as Record<string, unknown>
    if (!bass.ChannelGetInfo(stream, info)) return 0
    const freq = Number(info.freq)
    return Number.isFinite(freq) && freq > 0 ? freq : 0
  }

  private clampCenterFrequency(freq: number | undefined): number {
    const center = Number.isFinite(freq) && freq != null ? freq : 1000
    if (this.streamSampleRate <= 0) return center
    return Math.max(1, Math.min(center, (this.streamSampleRate / 2) - 1))
  }
}

export function getEQManager(): EQManager {
  if (!manager) manager = new EQManager()
  return manager
}
