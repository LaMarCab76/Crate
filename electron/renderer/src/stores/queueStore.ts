// Plays the role of PlaybackController+Queue from the legacy Swift code:
// owns the upcoming track list, advances on gapless events, and asks the
// main-process audio engine to preload the next file when the current one
// crosses the gapless threshold.

import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Track } from '@shared/types/library'
import { usePlaybackStore } from './playbackStore'
import { useTweakStore } from './settingsStore'
import type {
  PreloadNextResult,
  StreamInfoPayload,
  StreamLoadResult,
  StreamLoadSource,
} from '@shared/types/ipc-contract'
import { fadeTrackVolume } from '@renderer/utils/trackTransitionVolume'
import { shouldPreloadUpcomingTrack } from '@renderer/utils/progressivePreload'

export type RepeatMode = 'off' | 'one' | 'all'

interface QueueState {
  tracks: Track[]
  currentIndex: number
  repeat: RepeatMode
  shuffle: boolean
  history: Track[]
  isTrackTransitioning: boolean
  transitionTarget: Track | null

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
const TRACK_TRANSITION_FADE_STEP_MS = 16

function shouldApplyCrossfadeTransition(): boolean {
  const playback = usePlaybackStore.getState()
  return playback.status === 'playing' && getCrossfadeTimingsMs().fadeOutMs > 0
}

function parseCrossfadeSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function getCrossfadeTimingsMs(): { fadeOutMs: number; fadeInMs: number } {
  const crossfadeSeconds = parseCrossfadeSeconds(useTweakStore.getState().tweak.crossfade)
  const totalMs = crossfadeSeconds * 1000
  if (totalMs <= 0) return { fadeOutMs: 0, fadeInMs: 0 }
  // Semantics: `crossfade` is the total transition window. We split it
  // evenly into fade-out and fade-in segments.
  const fadeOutMs = totalMs / 2
  return { fadeOutMs, fadeInMs: totalMs - fadeOutMs }
}

function setEngineVolume(volume: number): Promise<void> {
  return window.api.audio.setVolume(volume)
}

async function fadeOutCurrentTrack(token: number): Promise<number> {
  const { fadeOutMs } = getCrossfadeTimingsMs()
  const playback = usePlaybackStore.getState()
  const volume = playback.volume
  if (playback.status !== 'playing' || fadeOutMs <= 0) return volume

  await fadeTrackVolume({
    fromVolume: volume,
    targetVolume: 0,
    durationMs: fadeOutMs,
    stepMs: TRACK_TRANSITION_FADE_STEP_MS,
    token,
    setVolume: setEngineVolume,
    restoreVolume: volume,
    isTokenValid: current => current === trackTransitionToken,
  })

  return volume
}

async function fadeInTrack(token: number, targetVolume: number): Promise<void> {
  const { fadeInMs } = getCrossfadeTimingsMs()
  if (targetVolume < 0 || targetVolume > 1) targetVolume = Math.max(0, Math.min(1, targetVolume))
  if (fadeInMs <= 0 || targetVolume <= 0) {
    await setEngineVolume(targetVolume)
    return
  }

  await fadeTrackVolume({
    fromVolume: 0,
    targetVolume,
    durationMs: fadeInMs,
    stepMs: TRACK_TRANSITION_FADE_STEP_MS,
    token,
    setVolume: setEngineVolume,
    restoreVolume: targetVolume,
    isTokenValid: current => current === trackTransitionToken,
  })
}

function clearTrackLoadingOverlayTimer(): void {
  if (trackLoadingOverlayTimer == null || typeof window === 'undefined') return
  window.clearTimeout(trackLoadingOverlayTimer)
  trackLoadingOverlayTimer = null
}

function beginTrackPreparation(target: Track, transitioning: boolean, showOverlay: boolean): number {
  const token = ++trackTransitionToken
  clearTrackLoadingOverlayTimer()
  useQueueStore.setState({
    isTrackTransitioning: transitioning,
    transitionTarget: target,
  })
  if (showOverlay && typeof window !== 'undefined') {
    trackLoadingOverlayTimer = window.setTimeout(() => {
      if (trackTransitionToken === token) {
        usePlaybackStore.getState().setTrackLoading(true)
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
  })
  usePlaybackStore.getState().setTrackLoading(false)
}

function cancelTrackPreparation(): void {
  trackTransitionToken += 1
  clearTrackLoadingOverlayTimer()
  useQueueStore.setState({
    isTrackTransitioning: false,
    transitionTarget: null,
  })
  usePlaybackStore.getState().setTrackLoading(false)
}

async function loadAndPlay(track: Track): Promise<void> {
  if (!track.path) return
  const result = await window.api.audio.load(track.path, track.dbId ?? null)
  const playback = usePlaybackStore.getState()
  playback.setStreamInfo(result.streamInfo)
  playback.setStreamSource(result.source)
  playback.setStreamSourceState('idle')
  playback.setCurrentTrack(track)
  await window.api.audio.play()
}

function setCurrentTrackWithPromotionReset(track: Track): void {
  const playback = usePlaybackStore.getState()
  playback.setStreamSourceState('idle')
  playback.setCurrentTrack(track)
}

function applyStreamLoadResultForTrack(track: Track, result: StreamLoadResult | null): void {
  setCurrentTrackWithPromotionReset(track)
  const playback = usePlaybackStore.getState()
  playback.setStreamInfo(result?.streamInfo ?? null)
  playback.setStreamSource(result?.source ?? 'none')
}

function setStreamSourceFromGapless(streamInfo: StreamInfoPayload | null, source?: StreamLoadSource): void {
  const playback = usePlaybackStore.getState()
  playback.setStreamInfo(streamInfo)
  playback.setStreamSource(source ?? 'none')
  playback.setStreamSourceState('idle')
}

async function preloadUpcomingTrack(track: Track): Promise<void> {
  if (!track.path) return
  const token = beginTrackPreparation(track, false, false)
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

  async playNow(track: Track, context?: Track[]) {
    const tracks = context ?? [track]
    const currentIndex = tracks.findIndex(t => t.id === track.id)
    const fadeTransition = shouldApplyCrossfadeTransition()
    cancelTrackPreparation()
    const token = beginTrackPreparation(track, true, true)
    const previousVolume = await fadeOutCurrentTrack(token)
    if (token !== trackTransitionToken) return
    await window.api.audio.clearNext()
    set({ tracks, currentIndex: Math.max(0, currentIndex), history: [] })
    gaplessPreloadFiredFor = null
    try {
      await loadAndPlay(track)
      if (fadeTransition && token === trackTransitionToken) await fadeInTrack(token, previousVolume)
    } finally {
      finishTrackPreparation(token)
    }
  },

  async next(opts) {
    const { tracks, currentIndex, repeat, history, isTrackTransitioning } = get()
    if (isTrackTransitioning) {
      if (opts?.auto) return
      cancelTrackPreparation()
    }
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

    const fadeTransition = shouldApplyCrossfadeTransition()
    const token = beginTrackPreparation(next, true, !opts?.auto)
    const previousVolume = await fadeOutCurrentTrack(token)
    if (token !== trackTransitionToken) return
    try {
      const preloaded: PreloadNextResult = await window.api.audio.preloadNext(next.path, next.dbId ?? null)
      let result: StreamLoadResult | null = preloaded.streamInfo ? await window.api.audio.swapNow(next.path) : null
      if (!result) {
        await window.api.audio.clearNext()
        result = await window.api.audio.load(next.path, next.dbId ?? null)
        await window.api.audio.play()
      }

      if (token !== trackTransitionToken) return

      set({
        currentIndex: nextIndex,
        history: [...history, tracks[currentIndex]].filter(Boolean).slice(-50),
      })
      applyStreamLoadResultForTrack(next, result)
      gaplessPreloadFiredFor = null
      if (fadeTransition && token === trackTransitionToken) await fadeInTrack(token, previousVolume)
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
    if (!prev) return
    cancelTrackPreparation()
    const fadeTransition = shouldApplyCrossfadeTransition()
    await window.api.audio.clearNext()
    const token = beginTrackPreparation(prev, true, true)
    const previousVolume = await fadeOutCurrentTrack(token)
    if (token !== trackTransitionToken) return
    set({
      currentIndex: currentIndex - 1,
      history: history.slice(0, -1),
    })
    gaplessPreloadFiredFor = null
    try {
      await loadAndPlay(prev)
      if (fadeTransition && token === trackTransitionToken) await fadeInTrack(token, previousVolume)
    } finally {
      finishTrackPreparation(token)
    }
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
    const fadeTransition = shouldApplyCrossfadeTransition()
    cancelTrackPreparation()
    await window.api.audio.clearNext()
    const token = beginTrackPreparation(target, true, true)
    const previousVolume = await fadeOutCurrentTrack(token)
    if (token !== trackTransitionToken) return
    // Treat any track before the new index as already-played so back/forward
    // navigation stays consistent with the linear queue order.
    set({
      currentIndex: index,
      history: tracks.slice(0, index).slice(-50),
    })
    gaplessPreloadFiredFor = null
    try {
      await loadAndPlay(target)
      if (fadeTransition && token === trackTransitionToken) await fadeInTrack(token, previousVolume)
    } finally {
      finishTrackPreparation(token)
    }
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
    const { tracks, currentIndex, isTrackTransitioning } = useQueueStore.getState()
    const next = tracks[currentIndex + 1]
    const nextPath = next?.path ?? null
    if (shouldPreloadUpcomingTrack({
      status: state.status,
      durationSec: state.durationSec,
      positionSec: state.positionSec,
      streamSource: state.streamSource,
      bufferComplete: state.bufferComplete,
      isTrackTransitioning,
      nextPath,
      alreadyPreloadedPath: gaplessPreloadFiredFor,
    }) && next?.path) {
      gaplessPreloadFiredFor = next.path
      void preloadUpcomingTrack(next)
    }
  })

  // Gapless path: end-of-stream callback swapped to the preloaded stream.
  // UI catches this as a precise handoff for seamless transition.
  window.api.audio.onGaplessFired(({ path, streamInfo, source }) => {
    const { tracks, currentIndex, history } = useQueueStore.getState()
    const nextIndex = currentIndex + 1
    const next = tracks[nextIndex]
    if (next && next.path === path) {
      useQueueStore.setState({
        currentIndex: nextIndex,
        history: [...history, tracks[currentIndex]].filter(Boolean).slice(-50),
      })
      setStreamSourceFromGapless(streamInfo, source)
      setCurrentTrackWithPromotionReset(next)
      void fadeInTrack(trackTransitionToken, usePlaybackStore.getState().volume)
      gaplessPreloadFiredFor = null
    }
  })

  // Fallback path: track ended without a usable preloaded next stream.
  // Advancing here keeps autoplay working even when gapless preload is absent.
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
