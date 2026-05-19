// Plays the role of PlaybackController+Queue from the legacy Swift code:
// owns the upcoming track list, advances on gapless events, and asks the
// main-process audio engine to preload the next file when the current one
// crosses the gapless threshold.

import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Track } from '@shared/types/library'
import { usePlaybackStore } from './playbackStore'

export type RepeatMode = 'off' | 'one' | 'all'

interface QueueState {
  tracks: Track[]
  currentIndex: number
  repeat: RepeatMode
  shuffle: boolean
  history: Track[]

  playNow(track: Track, context?: Track[]): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  togglePlay(): Promise<void>
  seek(positionSec: number): Promise<void>
  setVolume(v: number): Promise<void>
  clear(): void
  setRepeat(mode: RepeatMode): void
  toggleShuffle(): void
}

let gaplessPreloadFiredFor: string | null = null

async function loadAndPlay(track: Track): Promise<void> {
  if (!track.path) return
  // Pass dbId so the engine can pick up a saved per-track EQ override.
  const info = await window.api.audio.load(track.path, track.dbId ?? null)
  usePlaybackStore.getState().setStreamInfo(info)
  usePlaybackStore.getState().setCurrentTrack(track)
  await window.api.audio.play()
}

export const useQueueStore = create<QueueState>((set, get) => ({
  tracks: [],
  currentIndex: -1,
  repeat: 'off',
  shuffle: false,
  history: [],

  async playNow(track: Track, context?: Track[]) {
    const tracks = context ?? [track]
    const currentIndex = tracks.findIndex(t => t.id === track.id)
    set({ tracks, currentIndex: Math.max(0, currentIndex), history: [] })
    gaplessPreloadFiredFor = null
    await loadAndPlay(track)
  },

  async next() {
    const { tracks, currentIndex, repeat, history } = get()
    if (tracks.length === 0) return
    let nextIndex: number
    if (repeat === 'one') {
      nextIndex = currentIndex
    } else if (currentIndex + 1 >= tracks.length) {
      if (repeat === 'all') nextIndex = 0
      else { await window.api.audio.stop(); return }
    } else {
      nextIndex = currentIndex + 1
    }
    const next = tracks[nextIndex]
    if (!next) return
    set({
      currentIndex: nextIndex,
      history: [...history, tracks[currentIndex]].filter(Boolean).slice(-50),
    })
    gaplessPreloadFiredFor = null
    await loadAndPlay(next)
  },

  async previous() {
    const { tracks, currentIndex, history } = get()
    if (tracks.length === 0) return
    // If we've been playing for more than 3 seconds, restart current track
    // instead of jumping back. Matches typical music player UX.
    const position = usePlaybackStore.getState().positionSec
    if (position > 3) {
      await window.api.audio.seek(0)
      return
    }
    if (currentIndex <= 0) return
    const prev = tracks[currentIndex - 1]
    set({
      currentIndex: currentIndex - 1,
      history: history.slice(0, -1),
    })
    gaplessPreloadFiredFor = null
    await loadAndPlay(prev)
  },

  async togglePlay() {
    const status = usePlaybackStore.getState().status
    if (status === 'playing') await window.api.audio.pause()
    else if (status === 'paused') await window.api.audio.play()
  },

  async seek(positionSec: number) {
    await window.api.audio.seek(positionSec)
    usePlaybackStore.setState({ positionSec })
  },

  async setVolume(v: number) {
    await window.api.audio.setVolume(v)
    usePlaybackStore.getState().setVolume(v)
  },

  clear() {
    set({ tracks: [], currentIndex: -1, history: [] })
    void window.api.audio.clearNext()
  },

  setRepeat(mode) { set({ repeat: mode }) },
  toggleShuffle() { set(s => ({ shuffle: !s.shuffle })) },
}))

// ---------------- Main-process event wiring ----------------

if (typeof window !== 'undefined' && window.api?.audio) {
  // When the user reaches the gapless threshold, preload the next track.
  usePlaybackStore.subscribe(state => {
    if (state.status !== 'playing') return
    if (!state.durationSec || state.durationSec <= 0) return
    const remaining = state.durationSec - state.positionSec
    if (remaining < 8 && remaining > 1) {
      const { tracks, currentIndex } = useQueueStore.getState()
      const next = tracks[currentIndex + 1]
      if (next?.path && gaplessPreloadFiredFor !== next.path) {
        gaplessPreloadFiredFor = next.path
        void window.api.audio.preloadNext(next.path)
      }
    }
  })

  // BASS fired its end-of-stream callback and the gapless controller swapped
  // to the preloaded stream. Advance our queue pointer so the UI reflects it.
  window.api.audio.onGaplessFired(({ path }) => {
    const { tracks, currentIndex, history } = useQueueStore.getState()
    const nextIndex = currentIndex + 1
    const next = tracks[nextIndex]
    if (next && next.path === path) {
      useQueueStore.setState({
        currentIndex: nextIndex,
        history: [...history, tracks[currentIndex]].filter(Boolean).slice(-50),
      })
      usePlaybackStore.getState().setCurrentTrack(next)
      gaplessPreloadFiredFor = null
      // Tell main to re-evaluate the per-track EQ override for the new track.
      void window.api.audio.setActiveTrack(next.dbId ?? null)
    }
  })

  // No gapless preload — when the current stream ended naturally we ask the
  // queue to advance the regular way.
  window.api.audio.onTrackEnded(() => {
    void useQueueStore.getState().next()
  })
}

// Hooks
export function useQueueTracks(): Track[] {
  return useQueueStore(s => s.tracks)
}
export function useQueueIndex(): number {
  return useQueueStore(s => s.currentIndex)
}
export function useQueueHistory(): Track[] {
  return useQueueStore(s => s.history)
}
export function useQueueUpNext(): Track[] {
  // useShallow compares element-wise so the returned array gets memoized and
  // we don't trigger an infinite render loop from .slice() returning a new
  // reference on every read.
  return useQueueStore(useShallow(s => s.tracks.slice(s.currentIndex + 1)))
}
