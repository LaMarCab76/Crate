// Mirror of the main-process audio engine state. The engine is the source of
// truth — this store just caches what the main side told us so React
// components can render without awaiting an IPC roundtrip every frame.

import { create } from 'zustand'
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

// Subscribe once on module load to keep the store in sync with main-process
// push events. Safe to do at import time — preload exposes window.api before
// the renderer JS bundle runs.
if (typeof window !== 'undefined' && window.api?.audio) {
  window.api.audio.onProgress(({ positionSec, durationSec }) => {
    usePlaybackStore.getState().setProgress(positionSec, durationSec)
  })
  window.api.audio.onStateChanged(({ status }) => {
    usePlaybackStore.getState().setStatus(status)
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
  return usePlaybackStore(s => ({ positionSec: s.positionSec, durationSec: s.durationSec }))
}
export function usePlaybackVolume(): number {
  return usePlaybackStore(s => s.volume)
}
