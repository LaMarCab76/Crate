// Mirror of the main-process EQ state. The store seeds itself on first import
// by calling eq:getState, then keeps in sync via eq:changed events.

import { create } from 'zustand'
import type { EqPreviewScope, EqState, EqTrackOverride } from '@shared/types/ipc-contract'
import { EQ_BAND_COUNT, normalizeEqBands } from '@shared/constants/equalizer'

interface EqStoreState extends EqState {
  presetNames: string[]
  setEnabled(enabled: boolean): Promise<void>
  setBand(index: number, gain: number): Promise<void>
  setBands(bands: number[]): Promise<void>
  previewBand(index: number, gain: number, scope: EqPreviewScope): Promise<void>
  setPreset(name: string): Promise<void>
  setTrackOverride(trackId: number, override: EqTrackOverride | null): Promise<void>
}

export const useEqStore = create<EqStoreState>(set => ({
  enabled: false,
  preset: 'Flat',
  bands: new Array(EQ_BAND_COUNT).fill(0),
  overrideBands: null,
  presetNames: ['Flat', 'Vocal', 'Jazz', 'Electronic', 'Acoustic'],

  async setEnabled(enabled) {
    await window.api.eq.setEnabled(enabled)
    set({ enabled })
  },
  async setBand(index, gain) {
    await window.api.eq.setBand(index, gain)
    set(state => {
      if (index < 0 || index >= EQ_BAND_COUNT) return state
      const bands = [...state.bands]
      bands[index] = gain
      return { bands, preset: 'Custom' }
    })
  },
  async setBands(bands) {
    await window.api.eq.setBands(bands)
    set({ bands: normalizeEqBands(bands), preset: 'Custom' })
  },
  async previewBand(index, gain, scope) {
    await window.api.eq.previewBand(index, gain, scope)
  },
  async setPreset(name) {
    await window.api.eq.setPreset(name)
    set({ preset: name })
  },
  async setTrackOverride(trackId, override) {
    await window.api.eq.setTrackOverride(trackId, override)
    set({ overrideBands: override?.enabled ? normalizeEqBands(override.bands) : null })
  },
}))

if (typeof window !== 'undefined' && window.api?.eq) {
  window.api.eq.getState().then(s => {
    useEqStore.setState({
      enabled: s.enabled,
      preset: s.preset,
      bands: normalizeEqBands(s.bands),
      overrideBands: s.overrideBands ? normalizeEqBands(s.overrideBands) : null,
    })
  }).catch(() => { /* main not ready yet */ })
  window.api.eq.presets().then(names => {
    useEqStore.setState({ presetNames: names })
  }).catch(() => { /* main not ready yet */ })
  window.api.eq.onChanged(state => {
    useEqStore.setState({
      enabled: state.enabled,
      preset: state.preset,
      bands: normalizeEqBands(state.bands),
      overrideBands: state.overrideBands ? normalizeEqBands(state.overrideBands) : null,
    })
  })
}
