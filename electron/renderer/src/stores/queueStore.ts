// Plays the role of PlaybackController+Queue from the legacy Swift code:
// owns the upcoming track list, advances on gapless events, and asks the
// main-process audio engine to preload the next file when the current one
// crosses the gapless threshold.

import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Track } from '@shared/types/library'
import { beginPlaybackSession, usePlaybackStore } from './playbackStore'
import { useTweakStore } from './settingsStore'
import type {
  PreloadNextResult,
  PlaybackSource,
  StreamInfoPayload,
  StreamLoadResult,
  StreamLoadSource,
} from '@shared/types/ipc-contract'
import { fadeTrackVolume } from '@renderer/utils/trackTransitionVolume'
import { shouldPreloadUpcomingTrack } from '@renderer/utils/progressivePreload'
import { shouldApplyTransitionFade } from '@renderer/utils/transitionFade'
import { selectQueueNextIndex } from './queuePolicy'

export type RepeatMode = 'off' | 'one' | 'all'

interface QueueState {
  tracks: Track[]
  currentIndex: number
  repeat: RepeatMode
  shuffle: boolean
  history: Track[]
  isTrackTransitioning: boolean
  transitionTarget: Track | null
  queueReorderMode: boolean

  playNow(track: Track, context?: Track[]): Promise<void>
  playShuffled(context: Track[]): Promise<void>
  hydrate(availableTracks: Track[]): Promise<void>
  next(opts?: { auto?: boolean }): Promise<void>
  previous(): Promise<void>
  jumpTo(index: number): Promise<void>
  setQueueReorderMode(enabled: boolean): void
  moveQueueTrack(fromIndex: number, toIndex: number): void
  moveTrackToNext(index: number): void
  moveTrackToEnd(index: number): void
  togglePlay(): Promise<void>
  seek(positionSec: number): Promise<void>
  setVolume(v: number): Promise<void>
  clear(): void
  setRepeat(mode: RepeatMode): void
  toggleShuffle(): void
}

let gaplessPreloadFiredFor: string | null = null
let gaplessPreloadTargetIndex: number | null = null
const gaplessPreloadRetryAtByPath = new Map<string, number>()
let trackTransitionToken = 0
let trackLoadingOverlayTimer: number | null = null
const TRACK_LOADING_OVERLAY_DELAY_MS = 250
const TRACK_TRANSITION_FADE_STEP_MS = 16
const GAPLESS_PRELOAD_RETRY_DELAY_MS = 8_000
const QUEUE_SAVE_DEBOUNCE_MS = 300
let queueHydrated = false
let queueHydrationPromise: Promise<void> | null = null
let queueSaveTimer: number | null = null

function shouldApplyCrossfadeTransition(): boolean {
  const playback = usePlaybackStore.getState()
  return shouldApplyTransitionFade({
    status: playback.status,
    fadeOutMs: getCrossfadeTimingsMs().fadeOutMs,
    isAutomatic: false,
  })
}

function parseCrossfadeSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

function clearGaplessQueuePreloadState(): void {
  gaplessPreloadFiredFor = null
  gaplessPreloadTargetIndex = null
  gaplessPreloadRetryAtByPath.clear()
  void window.api.audio.clearNext()
}

function trackKey(track: Track | undefined): string | null {
  if (!track) return null
  return track.dbId != null ? `db:${track.dbId}` : `ui:${track.id}`
}

function playbackSourceForTrack(track: Track): PlaybackSource | null {
  return track.dbId != null ? { kind: 'library', trackId: track.dbId } : null
}

function selectNextIndex(state: Pick<QueueState, 'tracks' | 'currentIndex' | 'repeat' | 'shuffle' | 'history'>): number | null {
  return selectQueueNextIndex({
    ...state,
    key: track => trackKey(track) ?? '',
  })
}

function scheduleQueueSave(): void {
  if (!queueHydrated || typeof window === 'undefined') return
  if (queueSaveTimer != null) window.clearTimeout(queueSaveTimer)
  queueSaveTimer = window.setTimeout(() => {
    queueSaveTimer = null
    const state = useQueueStore.getState()
    const trackIds = state.tracks.flatMap(track => track.dbId != null ? [track.dbId] : [])
    void window.api.queue.save({
      trackIds,
      currentIndex: Math.max(-1, Math.min(state.currentIndex, trackIds.length - 1)),
      shuffle: state.shuffle,
      repeat: state.repeat,
    }).catch(error => console.warn('[queue] failed to persist snapshot:', error))
  }, QUEUE_SAVE_DEBOUNCE_MS)
}

function clampQueueIndex(index: number, min: number, max: number): number {
  if (!Number.isFinite(index)) return min
  return Math.max(min, Math.min(max, index))
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

// Crossfade-aware track change. The next stream is prepared (loaded) BEFORE any
// audible fade happens: preloadNext loads it into a separate slot while the
// current track keeps playing at full volume (engine.load/preloadNext don't free
// the current stream until the new one is ready). Only once the next track is
// loaded do we perform the dip — fade out → swap → fade in — so the volume effect
// lands tightly around the actual handoff instead of starting before the next
// track has loaded (which would stretch the dip across the whole load and leave
// dead air on a slow source).
//
// `commitNowPlaying` is invoked at the swap — the instant the new track becomes
// audible — so the now-playing UI (title, artwork, queue index) flips together
// with the sound instead of lagging behind until the fade-in finishes. It does
// not run if a newer transition superseded this one before the swap.
async function crossfadeToTrack(
  track: Track,
  token: number,
  commitNowPlaying: (result: StreamLoadResult | null) => void,
  applyFade = true,
): Promise<void> {
  if (!track.path) return
  const source = playbackSourceForTrack(track)
  if (!source) return
  // Automatic advances (the current track ended on its own) pass applyFade=false
  // so the handoff stays seamless — the fade is reserved for user-initiated changes.
  const fade = applyFade && shouldApplyCrossfadeTransition()

  if (!useTweakStore.getState().tweak.gapless) {
    const previousVolume = fade ? await fadeOutCurrentTrack(token) : usePlaybackStore.getState().volume
    if (token !== trackTransitionToken) return
    await window.api.audio.clearNext()
    const result = await window.api.audio.load(source)
    await window.api.audio.play()
    if (token !== trackTransitionToken) return
    clearTrackLoadingOverlay(token)
    commitNowPlaying(result)
    if (fade) await fadeInTrack(token, previousVolume)
    return
  }

  // 1. Prepare the next stream without interrupting the current track.
  const preloaded: PreloadNextResult = await window.api.audio.preloadNext(source)
  if (token !== trackTransitionToken) return

  // 2. Next track is ready — only now perform the fade-out dip. We gate this on
  //    `fade` rather than relying on fadeOutCurrentTrack's self-guard: at the natural
  //    end of a track the renderer's status is still 'playing', so an ungated call
  //    would dip on automatic advances too. When not fading, the pre-transition
  //    volume is just the current playback volume (what fadeOutCurrentTrack returns).
  const previousVolume = fade ? await fadeOutCurrentTrack(token) : usePlaybackStore.getState().volume
  if (token !== trackTransitionToken) return

  // 3. Hand off to the preloaded stream, or fall back to a direct load.
  let result: StreamLoadResult | null = preloaded.streamInfo
    ? await window.api.audio.swapNow()
    : null
  if (!result) {
    await window.api.audio.clearNext()
    result = await window.api.audio.load(source)
    await window.api.audio.play()
  }
  if (token !== trackTransitionToken) return

  // The new track is now audible. Commit the now-playing state and drop the
  // loading overlay BEFORE the fade-in: finishTrackPreparation only runs after the
  // awaited fade-in below, and the swap's setStatus('playing') is a no-op when the
  // engine was already playing, so neither the overlay nor the title/artwork would
  // otherwise update until the fade completes.
  clearTrackLoadingOverlay(token)
  commitNowPlaying(result)

  // 4. Fade the new track back up to the pre-transition volume.
  if (fade) await fadeInTrack(token, previousVolume)
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

// Hide the loading overlay (and cancel its pending timer) without ending the
// transition state — used at the swap point so the spinner clears the instant
// the next track becomes audible, while the crossfade fade-in keeps running.
function clearTrackLoadingOverlay(token: number): void {
  if (token !== trackTransitionToken) return
  clearTrackLoadingOverlayTimer()
  usePlaybackStore.getState().setTrackLoading(false)
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
  const source = playbackSourceForTrack(track)
  if (!source) return
  const result = await window.api.audio.load(source)
  const playback = usePlaybackStore.getState()
  playback.setStreamInfo(result.streamInfo)
  playback.setStreamSource(result.source)
  playback.setStreamSourceState('idle')
  applyBufferProgressFromLoadResult(result)
  playback.setCurrentTrack(track)
  beginPlaybackSession(track.dbId ?? null)
  await window.api.audio.play()
}

function setCurrentTrackWithPromotionReset(track: Track): void {
  const playback = usePlaybackStore.getState()
  playback.setStreamSourceState('idle')
  playback.setCurrentTrack(track)
}

function applyBufferProgressFromLoadResult(result: StreamLoadResult | null): void {
  const playback = usePlaybackStore.getState()
  playback.setBufferProgress({
    bufferedBytes: result?.bufferedBytes ?? null,
    totalBytes: result?.totalBytes ?? null,
    bufferedSec: result?.bufferedSec ?? null,
    bufferComplete: result?.bufferComplete ?? false,
  })
}

function applyStreamLoadResultForTrack(track: Track, result: StreamLoadResult | null): void {
  setCurrentTrackWithPromotionReset(track)
  beginPlaybackSession(track.dbId ?? null)
  const playback = usePlaybackStore.getState()
  playback.setStreamInfo(result?.streamInfo ?? null)
  playback.setStreamSource(result?.source ?? 'none')
  applyBufferProgressFromLoadResult(result)
}

function setStreamSourceFromGapless(streamInfo: StreamInfoPayload | null, source?: StreamLoadSource): void {
  const playback = usePlaybackStore.getState()
  playback.setStreamInfo(streamInfo)
  playback.setStreamSource(source ?? 'none')
  playback.setStreamSourceState('idle')
  playback.setBufferProgress({
    bufferedBytes: null,
    totalBytes: null,
    bufferedSec: null,
    bufferComplete: source === 'memory',
  })
}

async function preloadUpcomingTrack(track: Track): Promise<void> {
  if (!track.path || !useTweakStore.getState().tweak.gapless) return
  const source = playbackSourceForTrack(track)
  if (!source) return
  const token = beginTrackPreparation(track, false, false)
  try {
    const result = await window.api.audio.preloadNext(source)
    if (!result.streamInfo && gaplessPreloadFiredFor === track.path) {
      gaplessPreloadFiredFor = null
      gaplessPreloadRetryAtByPath.set(track.path, Date.now() + GAPLESS_PRELOAD_RETRY_DELAY_MS)
    } else if (result.streamInfo) {
      gaplessPreloadRetryAtByPath.delete(track.path)
    }
  } catch (err) {
    if (gaplessPreloadFiredFor === track.path) gaplessPreloadFiredFor = null
    gaplessPreloadRetryAtByPath.set(track.path, Date.now() + GAPLESS_PRELOAD_RETRY_DELAY_MS)
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
  queueReorderMode: false,

  async playNow(track: Track, context?: Track[]) {
    const tracks = context ?? [track]
    const currentIndex = tracks.findIndex(t => t.id === track.id)
    const fadeTransition = shouldApplyCrossfadeTransition()
    cancelTrackPreparation()
    const token = beginTrackPreparation(track, true, true)
    set({
      tracks,
      currentIndex: Math.max(0, currentIndex),
      history: [],
    })
    gaplessPreloadFiredFor = null
    gaplessPreloadTargetIndex = null
    gaplessPreloadRetryAtByPath.clear()
    try {
      if (fadeTransition) {
        await crossfadeToTrack(track, token, result => {
          applyStreamLoadResultForTrack(track, result)
        })
      } else {
        await window.api.audio.clearNext()
        await loadAndPlay(track)
      }
    } finally {
      finishTrackPreparation(token)
    }
  },

  async playShuffled(context: Track[]) {
    if (context.length === 0) return
    const startIndex = Math.floor(Math.random() * context.length)
    const track = context[startIndex]
    if (!track) return
    set({ shuffle: true })
    await get().playNow(track, context)
    // playNow intentionally preserves the selected playback modes.
    set({ shuffle: true })
  },

  async hydrate(availableTracks: Track[]) {
    if (queueHydrated) {
      const availableById = new Map(
        availableTracks.flatMap(track => track.dbId != null ? [[track.dbId, track] as const] : []),
      )
      set(state => {
        const currentKey = trackKey(state.tracks[state.currentIndex])
        const tracks = state.tracks.flatMap(track => {
          if (track.dbId == null) return [track]
          const fresh = availableById.get(track.dbId)
          return fresh ? [fresh] : []
        })
        const matchedIndex = currentKey == null
          ? state.currentIndex
          : tracks.findIndex(track => trackKey(track) === currentKey)
        return {
          tracks,
          currentIndex: tracks.length === 0 ? -1 : Math.max(0, matchedIndex),
          history: state.history.flatMap(track => {
            if (track.dbId == null) return [track]
            const fresh = availableById.get(track.dbId)
            return fresh ? [fresh] : []
          }),
        }
      })
      return
    }
    if (queueHydrationPromise) return queueHydrationPromise
    queueHydrationPromise = (async () => {
      try {
        const snapshot = await window.api.queue.load()
        const byId = new Map(
          availableTracks.flatMap(track => track.dbId != null ? [[track.dbId, track] as const] : []),
        )
        const tracks = snapshot.trackIds.flatMap(id => {
          const track = byId.get(id)
          return track ? [track] : []
        })
        const currentIndex = tracks.length === 0
          ? -1
          : Math.max(0, Math.min(snapshot.currentIndex, tracks.length - 1))
        set({
          tracks,
          currentIndex,
          history: currentIndex > 0 ? tracks.slice(0, currentIndex).slice(-50) : [],
          shuffle: snapshot.shuffle === true,
          repeat: snapshot.repeat === 'all' || snapshot.repeat === 'one' ? snapshot.repeat : 'off',
        })
      } catch (error) {
        console.warn('[queue] failed to hydrate snapshot:', error)
      } finally {
        queueHydrated = true
        queueHydrationPromise = null
      }
    })()
    return queueHydrationPromise
  },

  async next(opts) {
    const { tracks, currentIndex, history, isTrackTransitioning } = get()
    if (isTrackTransitioning) {
      if (opts?.auto) return
      cancelTrackPreparation()
    }
    if (tracks.length === 0) return
    const nextIndex = gaplessPreloadTargetIndex ?? selectNextIndex(get())
    if (nextIndex == null) {
      await window.api.audio.stop()
      return
    }
    const next = tracks[nextIndex]
    if (!next) return
    if (!next.path) return
    const nextPath = next.path

    const token = beginTrackPreparation(next, true, !opts?.auto)
    try {
      await crossfadeToTrack(next, token, result => {
        set({
          currentIndex: nextIndex,
          history: [...history, tracks[currentIndex]].filter(Boolean).slice(-50),
        })
        applyStreamLoadResultForTrack(next, result)
        gaplessPreloadFiredFor = null
        gaplessPreloadTargetIndex = null
        gaplessPreloadRetryAtByPath.delete(nextPath)
      }, !opts?.auto)
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
    const historyTrack = history.at(-1)
    const historyIndex = historyTrack
      ? tracks.findIndex(track => trackKey(track) === trackKey(historyTrack))
      : -1
    const previousIndex = historyIndex >= 0 ? historyIndex : currentIndex - 1
    if (previousIndex < 0) return
    const prev = tracks[previousIndex]
    if (!prev) return
    const fadeTransition = shouldApplyCrossfadeTransition()
    cancelTrackPreparation()
    const token = beginTrackPreparation(prev, true, true)
    set({
      currentIndex: previousIndex,
      history: history.slice(0, -1),
    })
    gaplessPreloadFiredFor = null
    gaplessPreloadTargetIndex = null
    gaplessPreloadRetryAtByPath.clear()
    try {
      if (fadeTransition) {
        await crossfadeToTrack(prev, token, result => {
          applyStreamLoadResultForTrack(prev, result)
        }, true)
      } else {
        await window.api.audio.clearNext()
        await loadAndPlay(prev)
      }
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
    const token = beginTrackPreparation(target, true, true)
    // Treat any track before the new index as already-played so back/forward
    // navigation stays consistent with the linear queue order.
    set({
      currentIndex: index,
      history: tracks.slice(0, index).slice(-50),
    })
    gaplessPreloadFiredFor = null
    gaplessPreloadTargetIndex = null
    gaplessPreloadRetryAtByPath.clear()
    try {
      if (fadeTransition) {
        await crossfadeToTrack(target, token, result => {
          applyStreamLoadResultForTrack(target, result)
        }, true)
      } else {
        await window.api.audio.clearNext()
        await loadAndPlay(target)
      }
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
    clearGaplessQueuePreloadState()
    usePlaybackStore.setState({ positionSec })
  },

  async setVolume(v: number) {
    await window.api.audio.setVolume(v)
    usePlaybackStore.getState().setVolume(v)
  },

  clear() {
    cancelTrackPreparation()
    set({
      tracks: [],
      currentIndex: -1,
      history: [],
    })
    gaplessPreloadRetryAtByPath.clear()
    void window.api.audio.clearNext()
  },

  setRepeat(mode) {
    set({ repeat: mode })
    clearGaplessQueuePreloadState()
  },
  toggleShuffle() {
    set(s => ({ shuffle: !s.shuffle }))
    clearGaplessQueuePreloadState()
  },

  setQueueReorderMode(enabled) {
    set({ queueReorderMode: enabled })
  },

  moveQueueTrack(fromIndex, toIndex) {
    const { tracks, currentIndex } = get()
    if (tracks.length === 0) return

    const minIndex = 0
    const maxIndex = tracks.length - 1
    const from = clampQueueIndex(fromIndex, minIndex, maxIndex)
    const to = clampQueueIndex(toIndex, minIndex, maxIndex)

    if (from === to || from <= currentIndex || to <= currentIndex) return

    const next = [...tracks]
    const [moved] = next.splice(from, 1)
    if (!moved) return

    next.splice(to, 0, moved)

    set({ tracks: next })
    clearGaplessQueuePreloadState()
  },

  moveTrackToNext(index) {
    const { tracks, currentIndex } = get()
    if (tracks.length === 0) return
    const from = clampQueueIndex(index, 0, tracks.length - 1)
    if (from <= currentIndex) return
    moveQueueTrackWithValidation(from, currentIndex + 1)
  },

  moveTrackToEnd(index) {
    const { tracks, currentIndex } = get()
    if (tracks.length === 0) return
    const from = clampQueueIndex(index, 0, tracks.length - 1)
    if (from <= currentIndex) return
    moveQueueTrackWithValidation(from, tracks.length - 1)
  },
}))

function moveQueueTrackWithValidation(fromIndex: number, toIndex: number): void {
  const state = useQueueStore.getState()
  const to = clampQueueIndex(toIndex, 0, Math.max(0, state.tracks.length - 1))
  state.moveQueueTrack(fromIndex, to)
}

// ---------------- Main-process event wiring ----------------

if (typeof window !== 'undefined' && window.api?.audio) {
  // When the user reaches the gapless threshold, preload the next track.
  const queueListenerCleanups: Array<() => void> = []
  queueListenerCleanups.push(usePlaybackStore.subscribe(state => {
    const queue = useQueueStore.getState()
    const { tracks, isTrackTransitioning } = queue
    if (!useTweakStore.getState().tweak.gapless) return
    const targetIndex = gaplessPreloadTargetIndex ?? selectNextIndex(queue)
    const next = targetIndex == null ? undefined : tracks[targetIndex]
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
      const retryAt = gaplessPreloadRetryAtByPath.get(next.path)
      if (retryAt != null && retryAt > Date.now()) return
      if (retryAt != null) gaplessPreloadRetryAtByPath.delete(next.path)
      gaplessPreloadFiredFor = next.path
      gaplessPreloadTargetIndex = targetIndex
      void preloadUpcomingTrack(next)
    }
  }))

  // Gapless path: end-of-stream callback swapped to the preloaded stream.
  // UI catches this as a precise handoff for seamless transition.
  queueListenerCleanups.push(window.api.audio.onGaplessFired(({ path, streamInfo, source }) => {
    if (!useTweakStore.getState().tweak.gapless) {
      clearGaplessQueuePreloadState()
      return
    }
    const { tracks, currentIndex, history } = useQueueStore.getState()
    const nextIndex = gaplessPreloadTargetIndex ?? selectNextIndex(useQueueStore.getState())
    if (nextIndex == null) return
    const next = tracks[nextIndex]
    if (next && next.path === path) {
      useQueueStore.setState({
        currentIndex: nextIndex,
        history: [...history, tracks[currentIndex]].filter(Boolean).slice(-50),
      })
      setStreamSourceFromGapless(streamInfo, source)
      setCurrentTrackWithPromotionReset(next)
      beginPlaybackSession(next.dbId ?? null)
      // Automatic advance: stay seamless (no fade). The adopted stream already
      // plays at the engine volume; re-assert the store's authoritative volume
      // instantly to guard against any drift from an interrupted manual fade.
      void setEngineVolume(usePlaybackStore.getState().volume)
      gaplessPreloadFiredFor = null
      gaplessPreloadTargetIndex = null
      gaplessPreloadRetryAtByPath.delete(path)
    }
  }))

  // Fallback path: track ended without a usable preloaded next stream.
  // Advancing here keeps autoplay working even when gapless preload is absent.
  queueListenerCleanups.push(window.api.audio.onTrackEnded(() => {
    void useQueueStore.getState().next({ auto: true })
  }))

  queueListenerCleanups.push(useTweakStore.subscribe((state, previous) => {
    if (state.tweak.gapless === previous.tweak.gapless) return
    if (!state.tweak.gapless) clearGaplessQueuePreloadState()
  }))

  queueListenerCleanups.push(useQueueStore.subscribe((state, previous) => {
    if (
      state.tracks !== previous.tracks ||
      state.currentIndex !== previous.currentIndex ||
      state.shuffle !== previous.shuffle ||
      state.repeat !== previous.repeat
    ) {
      scheduleQueueSave()
    }
  }))

  import.meta.hot?.dispose(() => {
    for (const cleanup of queueListenerCleanups) cleanup()
    if (queueSaveTimer != null) window.clearTimeout(queueSaveTimer)
    queueSaveTimer = null
    void window.api.audio.clearNext()
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
export function useQueueReorderMode(): boolean {
  return useQueueStore(s => s.queueReorderMode)
}
export function useQueueUpNext(): Track[] {
  // useShallow compares element-wise so the returned array gets memoized and
  // we don't trigger an infinite render loop from .slice() returning a new
  // reference on every read.
  return useQueueStore(useShallow(s => s.tracks.slice(s.currentIndex + 1)))
}
