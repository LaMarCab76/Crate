// Volume leveler (loudness normalization / "Sound Check") config store. The
// renderer owns persistence (localStorage) and pushes the config to the main
// process, which is where the gain is actually applied. Both the Preferences
// panel and the in-player Audio Output popover read/write this one store, so the
// two surfaces stay in lock-step.
//
// Mirrors eqStore's seed-from-main + sync-via-events shape, with the addition of
// localStorage persistence so the toggle survives relaunches (the old
// tweak.soundcheck boolean is migrated on first load).

import { create } from 'zustand'
import {
  LEVELER_DEFAULTS,
  clampTargetLufs,
  normalizeLevelerConfig,
  type LevelerConfig,
} from '@shared/constants/leveler'
import type { LevelerState } from '@shared/types/ipc-contract'

const STORAGE_KEY = 'crate.leveler.v1'
const LEGACY_TWEAKS_KEY = 'crate.tweaks.v1'

function loadConfig(): LevelerConfig {
  if (typeof window === 'undefined') return { ...LEVELER_DEFAULTS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) return normalizeLevelerConfig(JSON.parse(raw) as Partial<LevelerConfig>)
    // First run after the upgrade: inherit the old "Sound check" toggle.
    const legacyRaw = window.localStorage.getItem(LEGACY_TWEAKS_KEY)
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as { soundcheck?: unknown }
      if (legacy && typeof legacy === 'object' && 'soundcheck' in legacy) {
        return normalizeLevelerConfig({ ...LEVELER_DEFAULTS, enabled: Boolean(legacy.soundcheck) })
      }
    }
  } catch {
    /* ignore quota / parse errors */
  }
  return { ...LEVELER_DEFAULTS }
}

function persist(config: LevelerConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    /* ignore quota / private-mode errors */
  }
}

interface LevelerStore extends LevelerState {
  setEnabled(enabled: boolean): Promise<void>
  setTargetLufs(targetLufs: number): Promise<void>
  setPreventClipping(preventClipping: boolean): Promise<void>
}

// Apply a config patch: persist locally, update the store, push to main, then
// reflect the resulting gain readout back. Function declaration (hoisted) so the
// store's setters can reference it.
async function update(patch: Partial<LevelerConfig>): Promise<void> {
  const s = useLevelerStore.getState()
  const next = normalizeLevelerConfig({
    enabled: s.enabled,
    targetLufs: s.targetLufs,
    preventClipping: s.preventClipping,
    ...patch,
  })
  persist(next)
  useLevelerStore.setState(next)
  try {
    const state = await window.api?.leveler?.setConfig(next)
    if (state) useLevelerStore.setState({ currentGainDb: state.currentGainDb })
  } catch {
    /* main not ready yet, config is persisted and will be pushed on next boot */
  }
}

export const useLevelerStore = create<LevelerStore>(() => ({
  ...loadConfig(),
  currentGainDb: 0,
  setEnabled: (enabled) => update({ enabled }),
  setTargetLufs: (targetLufs) => update({ targetLufs: clampTargetLufs(targetLufs) }),
  setPreventClipping: (preventClipping) => update({ preventClipping }),
}))

if (typeof window !== 'undefined' && window.api?.leveler) {
  // Push the persisted config to main on boot so the leveler is live before the
  // user ever opens a settings surface, then reflect the resulting state.
  void window.api.leveler.setConfig(loadConfig()).then(state => {
    useLevelerStore.setState({
      enabled: state.enabled,
      targetLufs: state.targetLufs,
      preventClipping: state.preventClipping,
      currentGainDb: state.currentGainDb,
    })
  }).catch(() => { /* main not ready yet */ })

  // Live updates: the current gain changes as tracks change and as background
  // loudness analysis warms up.
  window.api.leveler.onChanged(state => {
    useLevelerStore.setState({
      enabled: state.enabled,
      targetLufs: state.targetLufs,
      preventClipping: state.preventClipping,
      currentGainDb: state.currentGainDb,
    })
  })
}
