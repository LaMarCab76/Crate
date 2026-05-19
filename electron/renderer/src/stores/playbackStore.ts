// Mirror of the main-process audio engine state. The engine is the source of
// truth — this store just caches what the main side told us so React
// components can render without awaiting an IPC roundtrip every frame.

import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { PlaybackStatus, StreamInfoPayload } from '@shared/types/ipc-contract'
import type { Track } from '@shared/types/library'

interface PlaybackState {
  status: PlaybackStatus
  currentTrack: Track | null
  streamInfo: StreamInfoPayload | null
  positionSec: number
  durationSec: number
  volume: number

  setCurrentTrack(t: Track | null): void
  setStatus(s: PlaybackStatus): void
  setProgress(positionSec: number, durationSec: number): void
  setVolume(v: number): void
  setStreamInfo(info: StreamInfoPayload | null): void
}

export const usePlaybackStore = create<PlaybackState>(set => ({
  status: 'stopped',
  currentTrack: null,
  streamInfo: null,
  positionSec: 0,
  durationSec: 0,
  volume: 1,

  setCurrentTrack: t => set({ currentTrack: t }),
  setStatus: s => set({ status: s }),
  setProgress: (positionSec, durationSec) => set({ positionSec, durationSec }),
  setVolume: v => set({ volume: v }),
  setStreamInfo: info =>
    set({
      streamInfo: info,
      durationSec: info?.duration ?? 0,
    }),
}))

// ---------------- Play-count threshold ----------------
//
// A track counts as a play once 30s of audible playback has accumulated
// for it. We track listen seconds locally and fire a single
// `tracks.countPlay(id)` IPC the moment we cross the threshold. The set is
// reset when the track changes, so re-playing the same track starts a new
// accumulation (matches Apple Music's behavior).
const PLAY_COUNT_THRESHOLD_SEC = 30
const listenAccumByTrack = new Map<number, number>()
const countedThisSession = new Set<number>()
let lastTickTrackId: number | null = null
let lastTickPositionSec = 0

function resetForTrack(trackId: number | null): void {
  lastTickTrackId = trackId
  lastTickPositionSec = 0
  if (trackId != null) listenAccumByTrack.delete(trackId)
}

if (typeof window !== 'undefined' && window.api?.audio) {
  window.api.audio.onProgress(({ positionSec, durationSec }) => {
    usePlaybackStore.getState().setProgress(positionSec, durationSec)

    const track = usePlaybackStore.getState().currentTrack
    const trackId = track?.dbId
    if (trackId == null) {
      lastTickTrackId = null
      return
    }

    // Track changes reset the accumulator. A scrub backwards keeps the
    // counter (you've still listened for that time); a scrub forwards
    // bumps the position but the elapsed delta still counts.
    if (trackId !== lastTickTrackId) {
      resetForTrack(trackId)
      // Align last position to the current playhead so the very next tick
      // computes a real per-tick delta instead of crediting the whole new
      // track position as elapsed time.
      lastTickPositionSec = positionSec
    } else {
      const delta = positionSec - lastTickPositionSec
      // Tick only credits "natural forward play", capped at 1s so a wild
      // seek doesn't dump 5 minutes of listen time onto the meter.
      if (delta > 0 && delta < 1.5 && usePlaybackStore.getState().status === 'playing') {
        const accum = (listenAccumByTrack.get(trackId) ?? 0) + delta
        listenAccumByTrack.set(trackId, accum)
        if (accum >= PLAY_COUNT_THRESHOLD_SEC && !countedThisSession.has(trackId)) {
          countedThisSession.add(trackId)
          void window.api.tracks.countPlay(trackId)
        }
      }
      lastTickPositionSec = positionSec
    }
  })
  window.api.audio.onStateChanged(({ status }) => {
    usePlaybackStore.getState().setStatus(status)
  })

  // When the in-store currentTrack changes, reset the play-count window so a
  // fresh listen of the same song can be credited again.
  usePlaybackStore.subscribe((state, prev) => {
    if (state.currentTrack?.dbId !== prev.currentTrack?.dbId) {
      const newId = state.currentTrack?.dbId ?? null
      countedThisSession.delete(prev.currentTrack?.dbId ?? -1)
      resetForTrack(newId)
    }
  })

  // Refresh on boot in case there was a playback session before reload (dev).
  window.api.audio.getStatus().then(s => {
    const store = usePlaybackStore.getState()
    store.setStatus(s.status)
    store.setStreamInfo(s.streamInfo)
    store.setVolume(s.volume)
    if (typeof s.positionSec === 'number') {
      store.setProgress(s.positionSec, s.streamInfo?.duration ?? 0)
    }
  }).catch(() => { /* main not ready yet, ignore */ })
}

// Hooks
export function usePlaybackStatus(): PlaybackStatus {
  return usePlaybackStore(s => s.status)
}
export function usePlayback() {
  return usePlaybackStore()
}
export function useCurrentTrack(): Track | null {
  return usePlaybackStore(s => s.currentTrack)
}
export function usePlaybackProgress(): { positionSec: number; durationSec: number } {
  return usePlaybackStore(
    useShallow(s => ({ positionSec: s.positionSec, durationSec: s.durationSec })),
  )
}
export function usePlaybackVolume(): number {
  return usePlaybackStore(s => s.volume)
}
