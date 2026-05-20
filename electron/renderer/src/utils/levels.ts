// Level-meter (VU) demand hub. Mirrors utils/fft.ts: the renderer tells the
// main process to run real-time L/R metering only while a meter is mounted and
// the window is visible. Consumers read the latest frame from a rAF loop rather
// than subscribing per-frame, so there are no 60 Hz React re-renders.

import type { LevelsEvent } from '@shared/types/ipc-contract'

type Listener = (levels: LevelsEvent) => void
type Subscription = { cb?: Listener }

const FLAT: LevelsEvent = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 }
let latest: LevelsEvent = FLAT
const subscriptions = new Set<Subscription>()
let applied = false

if (typeof window !== 'undefined' && window.api?.audio) {
  window.api.audio.onLevels(levels => {
    latest = levels
    for (const sub of subscriptions) {
      if (!sub.cb) continue
      try { sub.cb(levels) } catch { /* ignore */ }
    }
  })

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') latest = FLAT
      syncMeter()
    })
  }
}

// Declare demand for metering without a per-frame callback. The VU component
// reads getLatestLevels() in its own animation loop.
export function subscribeLevelsDemand(cb?: Listener): () => void {
  const sub: Subscription = { cb }
  subscriptions.add(sub)
  syncMeter()
  return () => {
    subscriptions.delete(sub)
    syncMeter()
  }
}

export function getLatestLevels(): LevelsEvent {
  return latest
}

function syncMeter(): void {
  if (typeof window === 'undefined' || !window.api?.audio) return
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
  const want = visible && subscriptions.size > 0
  if (want === applied) return
  applied = want
  void window.api.audio.setMeterEnabled(want).catch(() => { /* main not ready */ })
}
