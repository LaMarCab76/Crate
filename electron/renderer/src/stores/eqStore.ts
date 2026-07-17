// Mirror of the main-process EQ state. The store seeds itself on first import
// by calling eq:getState, then keeps in sync via eq:changed events.

import { create } from 'zustand'
import type { EqState } from '@shared/types/ipc-contract'
import {
  EQ_DEFAULT_BAND_COUNT,
  clampEqBandCount,
  normalizeEqBands,
} from '@shared/constants/equalizer'

interface EqStoreState extends EqState {
  presetNames: string[]
  setEnabled(enabled: boolean): Promise<void>
  setBand(index: number, gain: number): Promise<void>
  setBands(bands: number[]): Promise<void>
  setBandCount(count: number): Promise<void>
  previewBand(index: number, gain: number): Promise<void>
  setPreset(name: string): Promise<void>
}

export const useEqStore = create<EqStoreState>((set, get) => ({
  enabled: false,
  preset: 'Flat',
  bandCount: EQ_DEFAULT_BAND_COUNT,
  bands: normalizeEqBands(null, EQ_DEFAULT_BAND_COUNT),
  presetNames: ['Flat', 'Vocal', 'Jazz', 'Electronic', 'Acoustic'],

  async setEnabled(enabled) {
    await window.api.eq.setEnabled(enabled)
    set({ enabled })
  },
  async setBand(index, gain) {
    await window.api.eq.setBand(index, gain)
    set(state => {
      if (index < 0 || index >= state.bandCount) return state
      const bands = [...state.bands]
      bands[index] = gain
      return { bands, preset: 'Custom' }
    })
  },
  async setBands(bands) {
    await window.api.eq.setBands(bands)
    set(state => ({ bands: normalizeEqBands(bands, state.bandCount), preset: 'Custom' }))
  },
  async setBandCount(count) {
    const next = clampEqBandCount(count)
    if (next === get().bandCount) return
    await window.api.eq.setBandCount(next)
    set(state => ({ bandCount: next, bands: normalizeEqBands(state.bands, next) }))
  },
  async previewBand(index, gain) {
    await window.api.eq.previewBand(index, gain)
  },
  async setPreset(name) {
    await window.api.eq.setPreset(name)
    set({ preset: name })
  },
}))

function applyRemoteState(s: EqState): void {
  const bandCount = clampEqBandCount(s.bandCount)
  useEqStore.setState({
    enabled: s.enabled,
    preset: s.preset,
    bandCount,
    bands: normalizeEqBands(s.bands, bandCount),
  })
}

if (typeof window !== 'undefined' && window.api?.eq) {
  window.api.eq.getState().then(applyRemoteState).catch(() => { /* main not ready yet */ })
  window.api.eq.presets().then(names => {
    useEqStore.setState({ presetNames: names })
  }).catch(() => { /* main not ready yet */ })
  const offChanged = window.api.eq.onChanged(applyRemoteState)
  import.meta.hot?.dispose(offChanged)
}
