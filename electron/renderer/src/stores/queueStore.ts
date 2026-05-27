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
  isTrackTransitioning: boolean
  transitionTarget: Track | null
  showTrackLoadingOverlay: boolean

  playNow(track: Track, context?: Track[]): Promise<void>
  next(opts?: { auto?: boolean }): Promise<void>
  previous(): Promise<void>
  jumpTo(index: number): Promise<void>
  togglePlay(): Promise<void>
  seek(positionSec: number): Promise<void>
  setVolume(v: number): Promise<void>
  clear(): void
  setRepeat(mode: RepeatMode): void
  toggleShuffle(): void
}

let gaplessPreloadFiredFor: string | null = null
let trackTransitionToken = 0
let trackLoadingOverlayTimer: number | null = null
const TRACK_LOADING_OVERLAY_DELAY_MS = 250

function clearTrackLoadingOverlayTimer(): void {
  if (trackLoadingOverlayTimer == null || typeof window === 'undefined') return
  window.clearTimeout(trackLoadingOverlayTimer)
  trackLoadingOverlayTimer = null
}

function beginTrackPreparation(target: Track, transitioning: boolean, silent = false): number {
  const token = ++trackTransitionToken
  clearTrackLoadingOverlayTimer()
  useQueueStore.setState({
    isTrackTransitioning: transitioning,
    transitionTarget: target,
    showTrackLoadingOverlay: false,
  })
  // Silent paths (gapless preload, auto-advance after a track ends) keep the
  // overlay hidden so the user only sees the spinner when *they* asked for a
  // change — clicking next/prev/jumpTo or picking a different track.
  if (!silent && typeof window !== 'undefined') {
    trackLoadingOverlayTimer = window.setTimeout(() => {
      if (trackTransitionToken === token) {
        useQueueStore.setState({ showTrackLoadingOverlay: true })
      }
      trackLoadingOverlayTimer = null
    }, TRACK_LOADING_OVERLAY_DELAY_MS)
  }
  return token
}

function finishTrackPreparation(token: number): void {
  if (token !== trackTransitionToken) return
  clearTrackLoadingOverlayTimer()
  useQueueStore.setState({
    isTrackTransitioning: false,
    transitionTarget: null,
    showTrackLoadingOverlay: false,
  })
}

function cancelTrackPreparation(): void {
  trackTransitionToken += 1
  clearTrackLoadingOverlayTimer()
  useQueueStore.setState({
    isTrackTransitioning: false,
    transitionTarget: null,
    showTrackLoadingOverlay: false,
  })
}

async function loadAndPlay(track: Track): Promise<void> {
  if (!track.path) return
  const info = await window.api.audio.load(track.path, track.dbId ?? null)
  usePlaybackStore.getState().setStreamInfo(info)
  usePlaybackStore.getState().setCurrentTrack(track)
  await window.api.audio.play()
}

async function preloadUpcomingTrack(track: Track): Promise<void> {
  if (!track.path) return
  // Preloads run silently in the background — no overlay should appear just
  // because the player is fetching the next track for a seamless handoff.
  const token = beginTrackPreparation(track, false, true)
  try {
    await window.api.audio.preloadNext(track.path, track.dbId ?? null)
  } catch (err) {
    if (gaplessPreloadFiredFor === track.path) gaplessPreloadFiredFor = null
    console.warn('[queue] failed to preload next track:', err)
  } finally {
    finishTrackPreparation(token)
  }
}

export const useQueueStore = create<QueueState>((set, get) => ({
  tracks: [],
  currentIndex: -1,
  repeat: 'off',
  shuffle: false,
  history: [],
  isTrackTransitioning: false,
  transitionTarget: null,
  showTrackLoadingOverlay: false,

  async playNow(track: Track, context?: Track[]) {
    const tracks = context ?? [track]
    const currentIndex = tracks.findIndex(t => t.id === track.id)
    cancelTrackPreparation()
    await window.api.audio.clearNext()
    set({ tracks, currentIndex: Math.max(0, currentIndex), history: [] })
    gaplessPreloadFiredFor = null
    await loadAndPlay(track)
  },

  async next(opts) {
    const { tracks, currentIndex, repeat, history, isTrackTransitioning } = get()
    if (isTrackTransitioning) return
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
    if (!next.path) return

    const token = beginTrackPreparation(next, true, opts?.auto === true)
    try {
      const preloaded = await window.api.audio.preloadNext(next.path, next.dbId ?? null)
      let info = preloaded ? await window.api.audio.swapNow(next.path) : null
      if (!info) {
        await window.api.audio.clearNext()
        info = await window.api.audio.load(next.path, next.dbId ?? null)
        await window.api.audio.play()
      }

      if (token !== trackTransitionToken) return

      set({
        currentIndex: nextIndex,
        history: [...history, tracks[currentIndex]].filter(Boolean).slice(-50),
      })
      usePlaybackStore.getState().setStreamInfo(info)
      usePlaybackStore.getState().setCurrentTrack(next)
      gaplessPreloadFiredFor = null
    } finally {
      finishTrackPreparation(token)
    }
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
    cancelTrackPreparation()
    await window.api.audio.clearNext()
    set({
      currentIndex: currentIndex - 1,
      history: history.slice(0, -1),
    })
    gaplessPreloadFiredFor = null
    await loadAndPlay(prev)
  },

  async jumpTo(index: number) {
    const { tracks, currentIndex } = get()
    if (tracks.length === 0) return
    if (index < 0 || index >= tracks.length) return
    if (index === currentIndex) {
      await window.api.audio.seek(0)
      return
    }
    const target = tracks[index]
    if (!target?.path) return
    cancelTrackPreparation()
    await window.api.audio.clearNext()
    // Treat any track before the new index as already-played so back/forward
    // navigation stays consistent with the linear queue order.
    set({
      currentIndex: index,
      history: tracks.slice(0, index).slice(-50),
    })
    gaplessPreloadFiredFor = null
    await loadAndPlay(target)
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
    cancelTrackPreparation()
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
    if (state.positionSec >= state.durationSec / 2) {
      const { tracks, currentIndex, isTrackTransitioning } = useQueueStore.getState()
      if (isTrackTransitioning) return
      const next = tracks[currentIndex + 1]
      if (next?.path && gaplessPreloadFiredFor !== next.path) {
        gaplessPreloadFiredFor = next.path
        void preloadUpcomingTrack(next)
      }
    }
  })

  // Gapless path: end-of-stream callback swapped to the preloaded stream.
  // UI catches this as a precise handoff for seamless transition.
  window.api.audio.onGaplessFired(({ path, streamInfo }) => {
    const { tracks, currentIndex, history } = useQueueStore.getState()
    const nextIndex = currentIndex + 1
    const next = tracks[nextIndex]
    if (next && next.path === path) {
      useQueueStore.setState({
        currentIndex: nextIndex,
        history: [...history, tracks[currentIndex]].filter(Boolean).slice(-50),
      })
      usePlaybackStore.getState().setStreamInfo(streamInfo)
      usePlaybackStore.getState().setCurrentTrack(next)
      gaplessPreloadFiredFor = null
    }
  })

  // Fallback path: track ended without a usable preloaded next stream.
  // Advancing here keeps autoplay working even when gapless preload is absent.
  // Mark as auto so the loading spinner stays hidden — the user didn't ask
  // for a track change, the player just rolled over to the next song.
  window.api.audio.onTrackEnded(() => {
    void useQueueStore.getState().next({ auto: true })
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
