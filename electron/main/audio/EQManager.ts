// Multi-band peaking equalizer. We attach one BASS_FX_BFX_PEAKEQ effect per band
// to the current stream and update its parameters whenever a band's gain
// changes. The FX handles must be re-attached when the underlying stream changes
// (gapless swap, track change), so AudioEngine notifies us via the reapply()
// entry point.

import { BASS_FX_BFX_PEAKEQ } from './bass-constants'
import {
  BASS_BFX_CHANALL,
  loadBassFx,
  type PeakEqParams,
} from './bass-fx-ffi'
import { loadBass, type HFX, type HSTREAM } from './bass-ffi'
import {
  EQ_BAND_COUNT,
  EQ_BAND_FREQUENCIES,
  EQ_FILTER_BANDWIDTH,
  clampEqGain,
  normalizeEqBands,
} from '@shared/constants/equalizer'

export interface EQState {
  enabled: boolean
  preset: string
  bands: number[]  // gains in dB, one per EQ_BAND_FREQUENCIES entry
}

const FLAT_BANDS: number[] = normalizeEqBands(null)

const LEGACY_PRESETS: Record<string, number[]> = {
  Flat:       [  0,  0,  0,  0,  0,  0,  0,  0,  0,  0 ],
  Vocal:      [ -2, -1,  0,  1,  3,  3,  2,  1,  0, -1 ],
  Jazz:       [  2,  1,  0,  0, -1,  0,  1,  2,  3,  3 ],
  Electronic: [  4,  3,  1,  0, -2, -1,  1,  2,  3,  4 ],
  Acoustic:   [  3,  2,  1,  1,  2,  2,  1,  2,  3,  2 ],
}

const PRESETS: Record<string, number[]> = Object.fromEntries(
  Object.entries(LEGACY_PRESETS).map(([name, bands]) => [name, normalizeEqBands(bands)]),
) as Record<string, number[]>

let manager: EQManager | null = null

export class EQManager {
  private state: EQState = { enabled: false, preset: 'Flat', bands: [...FLAT_BANDS] }
  private currentStream: HSTREAM = 0
  private fxHandles: HFX[] = []

  getState(): EQState {
    return { ...this.state, bands: [...this.state.bands] }
  }

  getPresetNames(): string[] {
    return Object.keys(PRESETS)
  }

  setEnabled(enabled: boolean): void {
    if (this.state.enabled === enabled) return
    this.state.enabled = enabled
    this.reattachFX()
  }

  setPreset(name: string): void {
    const preset = PRESETS[name]
    if (!preset) return
    this.state.preset = name
    this.state.bands = [...preset]
    if (this.state.enabled && this.currentStream !== 0) {
      this.applyAllBandsToFx()
    }
  }

  setBand(index: number, gainDb: number): void {
    if (index < 0 || index >= EQ_BAND_COUNT) return
    const clamped = clampEqGain(gainDb)
    this.state.bands[index] = clamped
    this.state.preset = 'Custom'
    if (this.state.enabled && this.fxHandles[index]) {
      this.applyBand(index)
    }
  }

  setBands(bands: number[]): void {
    if (!Array.isArray(bands)) return
    this.state.bands = normalizeEqBands(bands)
    this.state.preset = 'Custom'
    if (this.state.enabled && this.currentStream !== 0) {
      this.applyAllBandsToFx()
    }
  }

  previewBand(index: number, gainDb: number): boolean {
    if (!this.state.enabled || this.currentStream === 0) return false
    if (index < 0 || index >= EQ_BAND_COUNT) return false
    if (!this.fxHandles[index]) return false
    this.applyBandWithGain(index, clampEqGain(gainDb))
    return true
  }

  // Called whenever the underlying stream changes (initial load, gapless swap).
  // Tears down old FX handles (they were attached to a stream that may no longer
  // exist) and re-attaches if the EQ is enabled.
  reapply(stream: HSTREAM): void {
    this.currentStream = stream
    this.reattachFX()
  }

  private reattachFX(): void {
    this.detachFX()
    if (!this.state.enabled || this.currentStream === 0) return

    const bass = loadBass()
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      // Each band gets its own PEAKEQ instance. Priority is 0; ordering
      // within BASS doesn't matter for parallel peaking filters.
      const fx = bass.ChannelSetFX(this.currentStream, BASS_FX_BFX_PEAKEQ, 0)
      this.fxHandles[i] = fx
      this.applyBand(i)
    }
  }

  private detachFX(): void {
    if (this.fxHandles.length === 0 || this.currentStream === 0) return
    const bass = loadBass()
    for (const fx of this.fxHandles) {
      if (fx !== 0) bass.ChannelRemoveFX(this.currentStream, fx)
    }
    this.fxHandles = []
  }

  private applyAllBandsToFx(): void {
    for (let i = 0; i < this.fxHandles.length; i++) this.applyBand(i)
  }

  private applyBand(index: number): void {
    this.applyBandWithGain(index, this.state.bands[index])
  }

  private applyBandWithGain(index: number, gainDb: number): void {
    const fx = this.fxHandles[index]
    if (!fx) return
    const fxLib = loadBassFx()
    const params: PeakEqParams = {
      lBand:      index,
      fBandwidth: EQ_FILTER_BANDWIDTH,
      fQ:         0,
      fCenter:    EQ_BAND_FREQUENCIES[index],
      fGain:      clampEqGain(gainDb),
      lChannel:   BASS_BFX_CHANALL,
    }
    fxLib.FXSetParameters(fx, params)
  }
}

export function getEQManager(): EQManager {
  if (!manager) manager = new EQManager()
  return manager
}

export { EQ_BAND_FREQUENCIES, PRESETS }

