// Renderer mirror of a track's lyrics. Loads the authoritative LyricsView from
// main on track change, parses synced LRC once, and recomputes the active line
// cheaply on every playhead tick (binary search, change-gated setState — never
// re-parses per frame). All mutations go through window.api.lyrics.*.

import { create } from 'zustand'
import { clampLyricsOffsetMs, currentLineIndex, parseLrc, plainTextLines, type ParsedLrc } from '@shared/lyrics/lrc'
import type {
  LyricsCandidate,
  LyricsStatus,
  LyricsView,
} from '@shared/types/lyrics'
import { usePlaybackStore } from './playbackStore'
import { useTweakStore } from './settingsStore'

export type LyricsViewStatus = LyricsStatus | 'idle' | 'loading' | 'error'

interface LyricsStoreState {
  trackId: number | null
  view: LyricsView | null
  parsed: ParsedLrc | null
  plainLines: string[] | null
  status: LyricsViewStatus
  loading: boolean
  busy: boolean
  searching: boolean
  error: string | null
  currentLineIndex: number
  candidates: LyricsCandidate[] | null
  visibleConsumerCount: number

  loadForTrack(id: number | null, opts?: { allowAutoFetch?: boolean }): Promise<void>
  fetchOnline(force?: boolean): Promise<void>
  searchOnline(): Promise<void>
  chooseCandidate(lrclibId: string): Promise<void>
  importFromFile(): Promise<void>
  importFromText(text: string): Promise<void>
  exportToFile(): Promise<void>
  saveEdited(plain: string | null, synced: string | null): Promise<void>
  setTrackOffset(offsetMs: number): Promise<void>
  remove(): Promise<void>
  recomputeNow(): void
  clearError(): void
  dismissCandidates(): void
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const visibleLyricsConsumers = new Set<symbol>()

function hiddenState(trackId: number | null): Pick<
  LyricsStoreState,
  'trackId' | 'view' | 'parsed' | 'plainLines' | 'status' | 'loading' | 'searching' | 'error' | 'currentLineIndex' | 'candidates'
> {
  return {
    trackId,
    view: null,
    parsed: null,
    plainLines: null,
    status: 'idle',
    loading: false,
    searching: false,
    error: null,
    currentLineIndex: -1,
    candidates: null,
  }
}

export function hasVisibleLyricsConsumers(): boolean {
  return visibleLyricsConsumers.size > 0
}

// Cache parseLrc results so rapid track changes (or repeats) don't re-parse
// large LRC strings. Bounded so the renderer doesn't hold every LRC ever seen.
const PARSE_LRC_CACHE_MAX = 32
const parseLrcCache = new Map<string, ParsedLrc>()

function parseLrcCached(text: string): ParsedLrc {
  const cached = parseLrcCache.get(text)
  if (cached) return cached
  const parsed = parseLrc(text)
  parseLrcCache.set(text, parsed)
  if (parseLrcCache.size > PARSE_LRC_CACHE_MAX) {
    const oldest = parseLrcCache.keys().next().value
    if (oldest !== undefined) parseLrcCache.delete(oldest)
  }
  return parsed
}

// Map an authoritative LyricsView into the renderable derived state.
function derive(view: LyricsView): Pick<LyricsStoreState, 'parsed' | 'plainLines' | 'status'> {
  if (view.instrumental) return { parsed: null, plainLines: null, status: 'instrumental' }
  const low = view.status === 'low_confidence'

  if (view.syncedLyricsLrc) {
    const parsed = parseLrcCached(view.syncedLyricsLrc)
    if (parsed.hasTimestamps) {
      return { parsed, plainLines: null, status: low ? 'low_confidence' : 'found_synced' }
    }
    return { parsed: null, plainLines: plainTextLines(view.syncedLyricsLrc), status: low ? 'low_confidence' : 'found_plain' }
  }
  if (view.plainLyrics) {
    return { parsed: null, plainLines: plainTextLines(view.plainLyrics), status: low ? 'low_confidence' : 'found_plain' }
  }
  return { parsed: null, plainLines: null, status: view.status }
}

export const useLyricsStore = create<LyricsStoreState>((set, get) => ({
  trackId: null,
  view: null,
  parsed: null,
  plainLines: null,
  status: 'idle',
  loading: false,
  busy: false,
  searching: false,
  error: null,
  currentLineIndex: -1,
  candidates: null,
  visibleConsumerCount: 0,

  async loadForTrack(id, opts) {
    if (!window.api?.lyrics) return
    if (!hasVisibleLyricsConsumers()) {
      set(hiddenState(id))
      return
    }
    if (id == null) {
      set({ trackId: null, view: null, parsed: null, plainLines: null, status: 'idle', loading: false, error: null, currentLineIndex: -1, candidates: null })
      return
    }
    set({ trackId: id, loading: true, status: 'loading', error: null, candidates: null, currentLineIndex: -1, view: null, parsed: null, plainLines: null })
    try {
      const view = await window.api.lyrics.get(id)
      if (get().trackId !== id) return
      if (!hasVisibleLyricsConsumers()) {
        set(hiddenState(id))
        return
      }
      const d = derive(view)
      set({ view, ...d, loading: false })
      get().recomputeNow()
      if (opts?.allowAutoFetch !== false && (d.status === 'none' || d.status === 'not_found')) {
        const auto = useTweakStore.getState().tweak.lyricsAutoFetch
        if (auto && hasVisibleLyricsConsumers()) void get().fetchOnline(false)
      }
    } catch (e) {
      if (get().trackId !== id) return
      if (!hasVisibleLyricsConsumers()) {
        set(hiddenState(id))
        return
      }
      set({ loading: false, status: 'error', error: msg(e) })
    }
  },

  async fetchOnline(force = false) {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    if (!hasVisibleLyricsConsumers()) return
    set({ loading: true, status: 'loading', error: null, candidates: null })
    try {
      const view = await window.api.lyrics.fetch(id, force)
      if (get().trackId !== id) return
      if (!hasVisibleLyricsConsumers()) {
        set(hiddenState(id))
        return
      }
      set({ view, ...derive(view), loading: false })
      get().recomputeNow()
    } catch (e) {
      if (get().trackId === id) {
        if (!hasVisibleLyricsConsumers()) {
          set(hiddenState(id))
          return
        }
        set({ loading: false, status: 'error', error: msg(e) })
      }
    }
  },

  async searchOnline() {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    if (!hasVisibleLyricsConsumers()) return
    set({ searching: true, error: null })
    try {
      const candidates = await window.api.lyrics.search(id)
      if (get().trackId !== id) return
      if (!hasVisibleLyricsConsumers()) {
        set({ searching: false, candidates: null })
        return
      }
      if (candidates.length === 0) {
        const found = get().status === 'found_synced' || get().status === 'found_plain'
        set({ searching: false, status: found ? get().status : 'not_found' })
        return
      }
      if (candidates.length === 1) {
        set({ searching: false })
        await get().chooseCandidate(candidates[0].id)
        return
      }
      set({ candidates, searching: false })
    } catch (e) {
      if (get().trackId === id) {
        if (!hasVisibleLyricsConsumers()) {
          set({ searching: false, candidates: null })
          return
        }
        set({ searching: false, error: msg(e) })
      }
    }
  },

  async chooseCandidate(lrclibId) {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    if (!hasVisibleLyricsConsumers()) return
    set({ busy: true, error: null })
    try {
      const view = await window.api.lyrics.importCandidate(id, lrclibId)
      if (get().trackId !== id) return
      if (!hasVisibleLyricsConsumers()) {
        set({ busy: false, candidates: null })
        return
      }
      set({ view, ...derive(view), busy: false, candidates: null })
      get().recomputeNow()
    } catch (e) {
      if (get().trackId === id) set({ busy: false, error: msg(e) })
    }
  },

  async importFromFile() {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    set({ busy: true, error: null })
    try {
      const view = await window.api.lyrics.importFile(id)
      if (get().trackId !== id) return
      if (!view) { set({ busy: false }); return } // user canceled
      set({ view, ...derive(view), busy: false })
      get().recomputeNow()
    } catch (e) {
      if (get().trackId === id) set({ busy: false, error: msg(e) })
    }
  },

  async importFromText(text) {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    set({ busy: true, error: null })
    try {
      const view = await window.api.lyrics.importLrc(id, text)
      if (get().trackId !== id) return
      set({ view, ...derive(view), busy: false })
      get().recomputeNow()
    } catch (e) {
      if (get().trackId === id) set({ busy: false, error: msg(e) })
    }
  },

  async exportToFile() {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    set({ busy: true, error: null })
    try {
      await window.api.lyrics.export(id)
    } catch (e) {
      set({ error: msg(e) })
    } finally {
      set({ busy: false })
    }
  },

  async saveEdited(plain, synced) {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    set({ busy: true, error: null })
    try {
      const view = await window.api.lyrics.save(id, plain, synced)
      if (get().trackId !== id) return
      set({ view, ...derive(view), busy: false })
      get().recomputeNow()
    } catch (e) {
      if (get().trackId === id) set({ busy: false, error: msg(e) })
    }
  },

  async setTrackOffset(offsetMs) {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    set({ busy: true, error: null })
    try {
      const view = await window.api.lyrics.setOffset(id, clampLyricsOffsetMs(offsetMs))
      if (get().trackId !== id) {
        set({ busy: false })
        return
      }
      set({ view, ...derive(view), busy: false })
      get().recomputeNow()
    } catch (e) {
      if (get().trackId === id) set({ busy: false, error: msg(e) })
    }
  },

  async remove() {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    set({ view: null, parsed: null, plainLines: null, status: 'not_found', currentLineIndex: -1, candidates: null })
    try {
      await window.api.lyrics.remove(id)
    } catch (e) {
      set({ error: msg(e) })
      void get().loadForTrack(id, { allowAutoFetch: false })
    }
  },

  recomputeNow() {
    if (!hasVisibleLyricsConsumers()) return
    const s = get()
    if (!s.parsed) {
      if (s.currentLineIndex !== -1) set({ currentLineIndex: -1 })
      return
    }
    const pos = usePlaybackStore.getState().positionSec
    const globalOffsetSec = clampLyricsOffsetMs(useTweakStore.getState().tweak.lyricsGlobalOffsetMs) / 1000
    const idx = currentLineIndex(s.parsed.lines, pos - s.parsed.meta.offsetSec - globalOffsetSec)
    if (idx !== s.currentLineIndex) set({ currentLineIndex: idx })
  },

  clearError() { set({ error: null }) },
  dismissCandidates() { set({ candidates: null }) },
}))

export function setLyricsPanelVisible(consumer: symbol, visible: boolean): void {
  const before = visibleLyricsConsumers.size
  if (visible) visibleLyricsConsumers.add(consumer)
  else visibleLyricsConsumers.delete(consumer)

  const after = visibleLyricsConsumers.size
  if (before === after) return

  useLyricsStore.setState({ visibleConsumerCount: after })

  if (after === 0) {
    useLyricsStore.setState(state => ({
      ...hiddenState(state.trackId),
      busy: false,
      visibleConsumerCount: 0,
    }))
    return
  }

  if (before === 0) {
    const id = usePlaybackStore.getState().currentTrack?.dbId ?? null
    void useLyricsStore.getState().loadForTrack(id)
  }
}

let lyricsListenerCleanups: Array<() => void> | null = null

function initializeLyricsListeners(): void {
  if (typeof window === 'undefined' || !window.api?.lyrics) return
  if (lyricsListenerCleanups) {
    for (const off of lyricsListenerCleanups) off()
    lyricsListenerCleanups = null
  }
  const offTrackChange = usePlaybackStore.subscribe((state, prev) => {
    const id = state.currentTrack?.dbId ?? null
    if (id !== (prev.currentTrack?.dbId ?? null)) {
      if (hasVisibleLyricsConsumers()) {
        void useLyricsStore.getState().loadForTrack(id)
      } else {
        useLyricsStore.setState(hiddenState(id))
      }
    }
  })

  const offPlayhead = usePlaybackStore.subscribe((state, prev) => {
    if (state.positionSec === prev.positionSec) return
    if (!hasVisibleLyricsConsumers()) return
    useLyricsStore.getState().recomputeNow()
  })

  const offTweak = useTweakStore.subscribe((state, prev) => {
    if (state.tweak.lyricsGlobalOffsetMs === prev.tweak.lyricsGlobalOffsetMs) return
    if (!hasVisibleLyricsConsumers()) return
    useLyricsStore.getState().recomputeNow()
  })

  const offChanged = window.api.lyrics.onChanged(({ trackId }) => {
    const ls = useLyricsStore.getState()
    if (!hasVisibleLyricsConsumers()) return
    if (trackId === ls.trackId) void ls.loadForTrack(trackId, { allowAutoFetch: false })
  })

  lyricsListenerCleanups = [offTrackChange, offPlayhead, offTweak, offChanged]

  if (hasVisibleLyricsConsumers()) {
    void useLyricsStore.getState().loadForTrack(usePlaybackStore.getState().currentTrack?.dbId ?? null)
  }
}

initializeLyricsListeners()

if (typeof import.meta !== 'undefined' && (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (import.meta as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    if (lyricsListenerCleanups) {
      for (const off of lyricsListenerCleanups) off()
      lyricsListenerCleanups = null
    }
  })
}
