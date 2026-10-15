// Multi-band peaking equalizer. Each visible band is an RBJ peaking biquad
// (the filter BASS_FX called BQF PEAKINGEQ) run by the native player. The band
// count is user-configurable (up to EQ_MAX_BAND_COUNT); the center frequencies
// and per-band bandwidth are derived from that count. The EQ lives in the
// player, so it carries over track changes and gapless hand-overs without
// being re-attached.

import { getAudioEngine, type NativePlayerHandle } from './AudioEngine'
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
  private frequencies: number[] = eqBandFrequencies(EQ_DEFAULT_BAND_COUNT)
  private bandwidth: number = eqBandwidthForCount(EQ_DEFAULT_BAND_COUNT)

  constructor() {
    // Pushes the state as soon as the engine (and its player) exists.
    getAudioEngine().setEqApplier(player => this.applyTo(player, this.state.bands))
  }

  getState(): EQState {
    return { ...this.state, bands: [...this.state.bands] }
  }

  getPresetNames(): string[] {
    return Object.keys(PRESET_DEFINITIONS)
  }

  setEnabled(enabled: boolean): void {
    if (this.state.enabled === enabled) return
    this.state.enabled = enabled
    this.apply()
  }

  // Changing the band count remaps the current curve onto the new band centers
  // and recomputes the derived frequency/bandwidth tables.
  setBandCount(count: number): void {
    const next = clampEqBandCount(count)
    if (next === this.state.bandCount) return
    this.state.bands = normalizeEqBands(this.state.bands, next)
    this.state.bandCount = next
    this.frequencies = eqBandFrequencies(next)
    this.bandwidth = eqBandwidthForCount(next)
    this.apply()
  }

  setPreset(name: string): void {
    const preset = PRESET_DEFINITIONS[name]
    if (!preset) return
    this.state.preset = name
    this.state.bands = normalizeEqBands(preset, this.state.bandCount)
    this.apply()
  }

  setBand(index: number, gainDb: number): void {
    if (index < 0 || index >= this.state.bandCount) return
    this.state.bands[index] = clampEqGain(gainDb)
    this.state.preset = 'Custom'
    this.apply()
  }

  setBands(bands: number[]): void {
    if (!Array.isArray(bands)) return
    this.state.bands = normalizeEqBands(bands, this.state.bandCount)
    this.state.preset = 'Custom'
    this.apply()
  }

  // Live preview while dragging a slider: audible immediately, not stored.
  previewBand(index: number, gainDb: number): boolean {
    if (!this.state.enabled) return false
    if (index < 0 || index >= this.state.bandCount) return false
    const player = getAudioEngine().getPlayer()
    if (!player) return false
    const bands = [...this.state.bands]
    bands[index] = clampEqGain(gainDb)
    this.applyTo(player, bands)
    return true
  }

  private apply(): void {
    const player = getAudioEngine().getPlayer()
    if (player) this.applyTo(player, this.state.bands)
  }

  private applyTo(player: NativePlayerHandle, bands: number[]): void {
    player.setEq(this.state.enabled, this.frequencies, bands.map(clampEqGain), this.bandwidth)
  }
}

export function getEQManager(): EQManager {
  if (!manager) manager = new EQManager()
  return manager
}
