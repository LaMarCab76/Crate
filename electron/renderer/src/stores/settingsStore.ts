import { create } from 'zustand'

export type Layout = 'classic' | 'editorial' | 'dense'
export type Density = 'compact' | 'regular' | 'comfy'
export type ArtistsMode = 'manual' | 'topPlays'

export interface Tweak {
  dark: boolean
  layout: Layout
  density: Density
  translucent: boolean
  showMini: boolean
  crossfade: number
  gapless: boolean
  soundcheck: boolean
  artistsPrincipalOnly: boolean
  artistsMode: ArtistsMode
  artistsTopN: number
  libraryBackup: boolean
}

const TWEAK_DEFAULTS: Tweak = {
  dark: true,
  layout: 'classic',
  density: 'regular',
  translucent: true,
  showMini: false,
  crossfade: 4,
  gapless: true,
  soundcheck: false,
  artistsPrincipalOnly: false,
  artistsMode: 'manual',
  artistsTopN: 20,
  libraryBackup: true,
}

const STORAGE_KEY = 'hifidelity.tweaks.v1'

function load(): Tweak {
  if (typeof window === 'undefined') return TWEAK_DEFAULTS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return TWEAK_DEFAULTS
    return { ...TWEAK_DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return TWEAK_DEFAULTS
  }
}

interface TweakStore {
  tweak: Tweak
  setTweak<K extends keyof Tweak>(k: K, v: Tweak[K]): void
}

// Single zustand store so views outside Settings (e.g. ArtistsView) can read
// preferences without prop drilling.
export const useTweakStore = create<TweakStore>(set => ({
  tweak: load(),
  setTweak: (k, v) =>
    set(state => {
      const next = { ...state.tweak, [k]: v }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // ignore quota / privacy errors
      }
      if (k === 'libraryBackup') {
        void window.api?.settings?.setLibraryBackup(v as boolean).catch(() => {
          // main not ready yet, ignore
        })
      }
      return { tweak: next }
    }),
}))

// Push the persisted preference to main on boot so the LibraryBackup service
// honors a previously-disabled toggle even before the user opens Settings.
if (typeof window !== 'undefined') {
  const initial = load()
  void window.api?.settings?.setLibraryBackup(initial.libraryBackup).catch(() => {
    /* main not ready yet, ignore */
  })
}

// Compatibility wrapper for the existing useTweaks() callsites (App, Settings).
// Returns the same [tweak, setter] tuple but backed by the singleton store.
export function useTweaks(): [Tweak, <K extends keyof Tweak>(k: K, v: Tweak[K]) => void] {
  const tweak = useTweakStore(s => s.tweak)
  const setTweak = useTweakStore(s => s.setTweak)
  return [tweak, setTweak]
}
