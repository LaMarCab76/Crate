// Renderer mirror of a track's lyrics. Loads the authoritative LyricsView from
// main on track change, parses synced LRC once, and recomputes the active line
// cheaply on every playhead tick (binary search, change-gated setState — never
// re-parses per frame). All mutations go through window.api.lyrics.*.

import { create } from 'zustand'
import { clampLyricsOffsetMs, currentLineIndex, parseLrc, plainTextLines, type ParsedLrc } from '@shared/lyrics/lrc'
import type {
  LyricsCandidate,
  LyricsEmbedResult,
  LyricsFailureReason,
  LyricsStatus,
  LyricsView,
  LyricsWriteOptions,
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

  loadForTrack(id: number | null, opts?: { allowAutoFetch?: boolean }): Promise<void>
  fetchOnline(force?: boolean): Promise<void>
  searchOnline(): Promise<void>
  chooseCandidate(lrclibId: string): Promise<void>
  importFromFile(): Promise<void>
  importFromText(text: string): Promise<void>
  exportToFile(): Promise<void>
  saveEdited(plain: string | null, synced: string | null): Promise<void>
  setTrackOffset(offsetMs: number): Promise<void>
  embedInFile(options?: Partial<LyricsWriteOptions>): Promise<LyricsEmbedResult>
  remove(): Promise<void>
  recomputeNow(): void
  clearError(): void
  dismissCandidates(): void
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const EMBED_ERRORS: Record<LyricsFailureReason, string> = {
  missing_metadata: 'No lyrics to embed.',
  provider_timeout: 'The lyrics provider timed out.',
  provider_rate_limited: 'Rate limited — try again later.',
  provider_not_found: 'No lyrics found.',
  low_confidence_match: 'No confident match found.',
  file_not_writable: 'The file is read-only.',
  file_locked: 'The file is in use by another process.',
  file_not_found: 'The audio file no longer exists.',
  not_flac: 'Embedding is only supported for FLAC files.',
  existing_lyrics: 'The file already has lyrics. Enable "Overwrite existing" to replace them.',
  write_failed: 'Failed to write tags into the file.',
  verification_failed: 'Tags could not be verified after writing.',
  backup_failed: 'Could not create a backup before writing.',
  unknown: 'An unexpected error occurred.',
}

export function embedErrorMessage(reason?: LyricsFailureReason): string {
  return reason ? EMBED_ERRORS[reason] : EMBED_ERRORS.unknown
}

// Map an authoritative LyricsView into the renderable derived state.
function derive(view: LyricsView): Pick<LyricsStoreState, 'parsed' | 'plainLines' | 'status'> {
  if (view.instrumental) return { parsed: null, plainLines: null, status: 'instrumental' }
  const low = view.status === 'low_confidence'

  if (view.syncedLyricsLrc) {
    const parsed = parseLrc(view.syncedLyricsLrc)
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

  async loadForTrack(id, opts) {
    if (!window.api?.lyrics) return
    if (id == null) {
      set({ trackId: null, view: null, parsed: null, plainLines: null, status: 'idle', loading: false, error: null, currentLineIndex: -1, candidates: null })
      return
    }
    set({ trackId: id, loading: true, status: 'loading', error: null, candidates: null, currentLineIndex: -1, view: null, parsed: null, plainLines: null })
    try {
      const view = await window.api.lyrics.get(id)
      if (get().trackId !== id) return
      const d = derive(view)
      set({ view, ...d, loading: false })
      get().recomputeNow()
      if (opts?.allowAutoFetch !== false && (d.status === 'none' || d.status === 'not_found')) {
        const auto = useTweakStore.getState().tweak.lyricsAutoFetch
        if (auto) void get().fetchOnline(false)
      }
    } catch (e) {
      if (get().trackId !== id) return
      set({ loading: false, status: 'error', error: msg(e) })
    }
  },

  async fetchOnline(force = false) {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    set({ loading: true, status: 'loading', error: null, candidates: null })
    try {
      const view = await window.api.lyrics.fetch(id, force)
      if (get().trackId !== id) return
      set({ view, ...derive(view), loading: false })
      get().recomputeNow()
    } catch (e) {
      if (get().trackId === id) set({ loading: false, status: 'error', error: msg(e) })
    }
  },

  async searchOnline() {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    set({ searching: true, error: null })
    try {
      const candidates = await window.api.lyrics.search(id)
      if (get().trackId !== id) return
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
      if (get().trackId === id) set({ searching: false, error: msg(e) })
    }
  },

  async chooseCandidate(lrclibId) {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return
    set({ busy: true, error: null })
    try {
      const view = await window.api.lyrics.importCandidate(id, lrclibId)
      if (get().trackId !== id) return
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

  async embedInFile(options) {
    const id = get().trackId
    if (id == null || !window.api?.lyrics) return { ok: false, verified: false }
    set({ busy: true, error: null })
    try {
      const result = await window.api.lyrics.embedInFile(id, options)
      set({ busy: false, error: result.ok ? null : embedErrorMessage(result.reason) })
      return result
    } catch (e) {
      set({ busy: false, error: msg(e) })
      return { ok: false, verified: false }
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

if (typeof window !== 'undefined' && window.api?.lyrics) {
  // Load lyrics whenever the playing track changes.
  usePlaybackStore.subscribe((state, prev) => {
    const id = state.currentTrack?.dbId ?? null
    if (id !== (prev.currentTrack?.dbId ?? null)) {
      void useLyricsStore.getState().loadForTrack(id)
    }
  })

  // Recompute the active line on each playhead tick (cheap; no re-parse).
  usePlaybackStore.subscribe((state, prev) => {
    if (state.positionSec === prev.positionSec) return
    useLyricsStore.getState().recomputeNow()
  })

  useTweakStore.subscribe((state, prev) => {
    if (state.tweak.lyricsGlobalOffsetMs === prev.tweak.lyricsGlobalOffsetMs) return
    useLyricsStore.getState().recomputeNow()
  })

  // Authoritative refresh after any main-side mutation. allowAutoFetch:false
  // here avoids a fetch -> broadcast -> reload -> fetch loop.
  window.api.lyrics.onChanged(({ trackId }) => {
    const ls = useLyricsStore.getState()
    if (trackId === ls.trackId) void ls.loadForTrack(trackId, { allowAutoFetch: false })
  })

  // Initial load for whatever is already playing on boot.
  void useLyricsStore.getState().loadForTrack(usePlaybackStore.getState().currentTrack?.dbId ?? null)
}
