import { create } from 'zustand'

export type Layout = 'classic' | 'editorial' | 'dense'
export type Density = 'compact' | 'regular' | 'comfy'
export type ArtistsMode = 'manual' | 'topPlays'
export type PlayerTintSource = 'default' | 'preset' | 'custom' | 'artwork'

export interface Tweak {
  dark: boolean
  layout: Layout
  density: Density
  translucent: boolean
  crossfade: number
  gapless: boolean
  soundcheck: boolean
  artistsPrincipalOnly: boolean
  artistsMode: ArtistsMode
  artistsTopN: number
  libraryBackup: boolean
  // Bypasses the macOS mixer (CoreAudio hog mode) so audio goes straight to
  // the output device. Persisted so the toggle restores on relaunch, but
  // reconciled against the engine's actual state on boot.
  exclusiveMode: boolean
  playerTintSource: PlayerTintSource
  playerTintColor: string
  // Show the FFT bar visualizer in the player pane. Off skips the FFT
  // subscription so the engine can downshift its FFT mode and save work.
  showPlayerVisualizer: boolean
}

const TWEAK_DEFAULTS: Tweak = {
  dark: true,
  layout: 'classic',
  density: 'regular',
  translucent: true,
  crossfade: 4,
  gapless: true,
  soundcheck: false,
  artistsPrincipalOnly: false,
  artistsMode: 'manual',
  artistsTopN: 20,
  libraryBackup: true,
  exclusiveMode: false,
  playerTintSource: 'artwork',
  playerTintColor: '#0a84ff',
  showPlayerVisualizer: true,
}

const STORAGE_KEY = 'crate.tweaks.v1'

function load(): Tweak {
  if (typeof window === 'undefined') return TWEAK_DEFAULTS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return TWEAK_DEFAULTS
    const parsed = JSON.parse(raw) as Partial<Tweak> & { bgSource?: string }
    const merged = { ...TWEAK_DEFAULTS, ...parsed } as Tweak
    // Migrate users that had the old bgSource = 'artwork' to the player tint.
    // The removed accent/bg color fields fall away on the next persist.
    if (parsed.bgSource === 'artwork' && merged.playerTintSource === 'default') {
      merged.playerTintSource = 'artwork'
    }
    return merged
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
export const useTweakStore = create<TweakStore>((set, get) => ({
  tweak: load(),
  setTweak: (k, v) => {
    // Exclusive mode is special: it needs a round-trip to main because the
    // call can fail (hog already held, mapping missing, etc.). Commit the
    // value only after the engine accepts it, so the toggle reflects truth.
    if (k === 'exclusiveMode') {
      void window.api?.audio?.setExclusiveMode(v as boolean).then(state => {
        set(prev => {
          const next = { ...prev.tweak, exclusiveMode: state.enabled }
          try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
          return { tweak: next }
        })
      }).catch(() => {
        // Engine errored: revert to the latest known state from main.
        void window.api?.audio?.getExclusiveMode().then(state => {
          set(prev => ({ tweak: { ...prev.tweak, exclusiveMode: state.enabled } }))
        }).catch(() => { /* main not ready yet */ })
      })
      return
    }
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
    })
  },
}))

// Push the persisted preference to main on boot so the LibraryBackup service
// honors a previously-disabled toggle even before the user opens Settings.
if (typeof window !== 'undefined') {
  const initial = load()
  void window.api?.settings?.setLibraryBackup(initial.libraryBackup).catch(() => {
    /* main not ready yet, ignore */
  })

  // Reconcile persisted exclusive-mode against the engine. If the persisted
  // value is on but the engine couldn't take hog (device unplugged, hog held
  // elsewhere), clear the local bit so the UI shows reality.
  void window.api?.audio?.getExclusiveMode().then(state => {
    if (state.enabled === initial.exclusiveMode) return
    useTweakStore.setState(prev => ({ tweak: { ...prev.tweak, exclusiveMode: state.enabled } }))
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...initial, exclusiveMode: state.enabled }))
    } catch { /* ignore */ }
  }).catch(() => { /* main not ready */ })

  // Live updates while the popup is closed (e.g. device switch transferred hog).
  window.api?.audio?.onExclusiveModeChanged(state => {
    useTweakStore.setState(prev => {
      if (prev.tweak.exclusiveMode === state.enabled) return prev
      const next = { ...prev.tweak, exclusiveMode: state.enabled }
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return { tweak: next }
    })
  })
}

// Compatibility wrapper for the existing useTweaks() callsites (App, Settings).
// Returns the same [tweak, setter] tuple but backed by the singleton store.
export function useTweaks(): [Tweak, <K extends keyof Tweak>(k: K, v: Tweak[K]) => void] {
  const tweak = useTweakStore(s => s.tweak)
  const setTweak = useTweakStore(s => s.setTweak)
  return [tweak, setTweak]
}
