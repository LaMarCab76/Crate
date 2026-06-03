import { create } from 'zustand'
import { createListPrefsDefaults } from '@renderer/utils/listSort'
import {
  normalizeUpNextToastWindow,
  UP_NEXT_TOAST_END_SEC_DEFAULT,
  UP_NEXT_TOAST_START_SEC_DEFAULT,
} from '@renderer/utils/upNextToast'
import { DEVICE_ARTWORK_EDGE_DEFAULT, clampDeviceArtworkEdge } from '@shared/constants/device-sync'
import { clampLyricsOffsetMs } from '@shared/lyrics/lrc'
import type { ListPrefsMap, ListViewKind } from '@renderer/utils/listSort'
import type { LyricsSettingsState } from '@shared/types/lyrics'

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
  artistsPrincipalOnly: boolean
  artistsMode: ArtistsMode
  artistsTopN: number
  libraryBackup: boolean
  libraryScanLogRetentionDays: number | null
  deviceArtworkMaxEdge: number
  // Bypasses the macOS mixer (CoreAudio hog mode) so audio goes straight to
  // the output device. Persisted so the toggle restores on relaunch, but
  // reconciled against the engine's actual state on boot.
  exclusiveMode: boolean
  playerTintSource: PlayerTintSource
  playerTintColor: string
  upNextToastStartSec: number
  upNextToastEndSec: number
  // Show the FFT bar visualizer in the player pane. Off skips the FFT
  // subscription so the engine can downshift its FFT mode and save work.
  showPlayerVisualizer: boolean
  // Show the inline lyrics section in the player pane. The side lyrics pane can
  // still be opened from the section header while this preview is collapsed.
  showPlayerLyrics: boolean
  // Show the full-screen background spectrum in the fullscreen player. Off
  // keeps just the artwork; persisted so the toggle restores on reopen.
  fullPlayerVisualizer: boolean
  // --- Lyrics. Mirror of LyricsSettingsState; pushed to main via setLyrics so
  // it knows cache/fetch behavior before any action. Sidecar writes are mandatory.
  lyricsAutoFetch: boolean
  lyricsPreferSynced: boolean
  lyricsGlobalOffsetMs: number
  // Background backfill of missing lyrics as songs are added + a startup sweep.
  // Distinct from lyricsAutoFetch (which fetches on playback). Off by default.
  lyricsBackgroundFetch: boolean
  // Delete orphaned .lrc files (no matching audio) during library scans. Off by
  // default (destructive).
  lyricsDeleteOrphans: boolean
}

const TWEAK_DEFAULTS: Tweak = {
  dark: true,
  layout: 'classic',
  density: 'regular',
  translucent: true,
  crossfade: 4,
  gapless: true,
  artistsPrincipalOnly: false,
  artistsMode: 'manual',
  artistsTopN: 20,
  libraryBackup: true,
  libraryScanLogRetentionDays: 30,
  deviceArtworkMaxEdge: DEVICE_ARTWORK_EDGE_DEFAULT,
  exclusiveMode: false,
  playerTintSource: 'artwork',
  playerTintColor: '#0a84ff',
  upNextToastStartSec: UP_NEXT_TOAST_START_SEC_DEFAULT,
  upNextToastEndSec: UP_NEXT_TOAST_END_SEC_DEFAULT,
  showPlayerVisualizer: false,
  showPlayerLyrics: false,
  fullPlayerVisualizer: true,
  lyricsAutoFetch: true,
  lyricsPreferSynced: true,
  lyricsGlobalOffsetMs: 0,
  lyricsBackgroundFetch: false,
  lyricsDeleteOrphans: false,
}

// Maps the renderer tweak keys onto the main-process LyricsSettingsState shape.
function lyricsPrefsFromTweak(t: Tweak): LyricsSettingsState {
  return {
    autoFetch: t.lyricsAutoFetch,
    preferSynced: t.lyricsPreferSynced,
    backgroundFetch: t.lyricsBackgroundFetch,
    deleteOrphanLyrics: t.lyricsDeleteOrphans,
  }
}

const STORAGE_KEY = 'crate.tweaks.v1'
const LIST_PREFS_STORAGE_KEY = 'crate.listPrefs.v1'

function load(): Tweak {
  if (typeof window === 'undefined') return TWEAK_DEFAULTS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return TWEAK_DEFAULTS
    const parsed = JSON.parse(raw) as Partial<Tweak> & { bgSource?: string; fullPlayerFileDataVisible?: unknown; soundcheck?: unknown }
    const merged = { ...TWEAK_DEFAULTS, ...parsed } as Tweak & { fullPlayerFileDataVisible?: unknown; soundcheck?: unknown }
    delete merged.fullPlayerFileDataVisible
    // soundcheck migrated to the dedicated leveler store (crate.leveler.v1).
    delete merged.soundcheck
    // Migrate users that had the old bgSource = 'artwork' to the player tint.
    // The removed accent/bg color fields fall away on the next persist.
    if (parsed.bgSource === 'artwork' && merged.playerTintSource === 'default') {
      merged.playerTintSource = 'artwork'
    }
    Object.assign(merged, normalizeUpNextToastWindow(merged.upNextToastStartSec, merged.upNextToastEndSec))
    merged.deviceArtworkMaxEdge = clampDeviceArtworkEdge(merged.deviceArtworkMaxEdge)
    merged.lyricsGlobalOffsetMs = clampLyricsOffsetMs(merged.lyricsGlobalOffsetMs)
    if (merged.libraryScanLogRetentionDays !== null) {
      const days = Number(merged.libraryScanLogRetentionDays)
      merged.libraryScanLogRetentionDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30
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

interface ListPrefsStore {
  listPrefs: ListPrefsMap
  setListPrefs: <K extends ListViewKind>(kind: K, patch: Partial<ListPrefsMap[K]>) => void
}

function parseListPrefs(raw: string | null): ListPrefsMap | null {
  try {
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ListPrefsMap>
    const defaults = createListPrefsDefaults()
    return {
      library: { ...defaults.library, ...(parsed.library ?? {}) },
      albums: { ...defaults.albums, ...(parsed.albums ?? {}) },
      artists: { ...defaults.artists, ...(parsed.artists ?? {}) },
      genres: { ...defaults.genres, ...(parsed.genres ?? {}) },
      playlist: { ...defaults.playlist, ...(parsed.playlist ?? {}) },
      favoriteTracks: { ...defaults.favoriteTracks, ...(parsed.favoriteTracks ?? {}) },
      album: { ...defaults.album, ...(parsed.album ?? {}) },
      artist: { ...defaults.artist, ...(parsed.artist ?? {}) },
    }
  } catch {
    return null
  }
}

function loadListPrefs(): ListPrefsMap {
  if (typeof window === 'undefined') return createListPrefsDefaults()
  try {
    const raw = window.localStorage.getItem(LIST_PREFS_STORAGE_KEY)
    return parseListPrefs(raw) ?? createListPrefsDefaults()
  } catch {
    return createListPrefsDefaults()
  }
}

function persistListPrefs(listPrefs: ListPrefsMap): void {
  try {
    window.localStorage.setItem(LIST_PREFS_STORAGE_KEY, JSON.stringify(listPrefs))
  } catch {
    // ignore quota / private mode failures
  }
}

export const useListPrefsStore = create<ListPrefsStore>((set) => ({
  listPrefs: loadListPrefs(),
  setListPrefs: (kind, patch) => {
    set(state => {
      const current = state.listPrefs[kind]
      const nextByKind = { ...current, ...patch }
      const next = {
        ...state.listPrefs,
        [kind]: nextByKind,
      } as ListPrefsMap
      persistListPrefs(next)
      return { listPrefs: next }
    })
  },
}))

export function useListPrefs<K extends ListViewKind>(kind: K): [ListPrefsMap[K], (patch: Partial<ListPrefsMap[K]>) => void] {
  const prefs = useListPrefsStore(state => state.listPrefs[kind])
  const setListPrefs = useListPrefsStore(state => state.setListPrefs)
  return [prefs, patch => setListPrefs(kind, patch)]
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
      const value =
        k === 'deviceArtworkMaxEdge' ? clampDeviceArtworkEdge(v)
        : k === 'lyricsGlobalOffsetMs' ? clampLyricsOffsetMs(v)
        : v
      let next = { ...state.tweak, [k]: value } as Tweak
      if (k === 'upNextToastStartSec' || k === 'upNextToastEndSec') {
        next = {
          ...next,
          ...normalizeUpNextToastWindow(next.upNextToastStartSec, next.upNextToastEndSec),
        }
      }
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
      if (k === 'libraryScanLogRetentionDays') {
        void window.api?.settings?.setLibraryScanLogRetention(value as number | null).catch(() => {
          // main not ready yet, ignore
        })
      }
      if (String(k).startsWith('lyrics')) {
        void window.api?.settings?.setLyrics(lyricsPrefsFromTweak(next)).catch(() => {
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
  void window.api?.settings?.setLibraryScanLogRetention(initial.libraryScanLogRetentionDays).catch(() => {
    /* main not ready yet, ignore */
  })
  // Push lyrics prefs to main on boot so cache/fetch behavior is known.
  // before the user opens Settings.
  void window.api?.settings?.setLyrics(lyricsPrefsFromTweak(initial)).catch(() => {
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
