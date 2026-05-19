// FFT demand + broadcast hub. The renderer tells the main process how much
// spectrum data is actually needed: foreground bars use the active display
// cadence, visible background windows keep the balanced feed, and hidden or
// no-consumer states turn analysis off.

import type { FftMode } from '@shared/types/ipc-contract'

type FftSubscriptionMode = Exclude<FftMode, 'off' | 'screen'>
type Listener = (bins: number[]) => void
type Subscription = {
  cb?: Listener
  mode: FftSubscriptionMode
}

let latest: number[] = new Array(64).fill(0)
const flatline: number[] = new Array(64).fill(0)
const subscriptions = new Set<Subscription>()
let appliedMode: FftMode = 'off'
let windowFocused = typeof document === 'undefined' ? true : document.hasFocus()

if (typeof window !== 'undefined' && window.api?.audio) {
  window.api.audio.onFft(({ bins }) => {
    latest = bins
    publish(bins)
  })

  window.addEventListener('focus', () => {
    windowFocused = true
    syncFftMode()
  })
  window.addEventListener('blur', () => {
    windowFocused = false
    syncFftMode()
  })

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      windowFocused = document.hasFocus()
      if (document.visibilityState === 'hidden') {
        latest = flatline
        publish(flatline)
      }
      syncFftMode()
    })
  }
}

export function subscribeFft(cb: Listener, mode: FftSubscriptionMode = 'mini'): () => void {
  const sub: Subscription = { cb, mode }
  subscriptions.add(sub)
  syncFftMode()
  return () => {
    subscriptions.delete(sub)
    syncFftMode()
  }
}

export function subscribeFftDemand(mode: FftSubscriptionMode): () => void {
  const sub: Subscription = { mode }
  subscriptions.add(sub)
  syncFftMode()
  return () => {
    subscriptions.delete(sub)
    syncFftMode()
  }
}

export function getLatestFft(): number[] {
  return latest
}

function publish(bins: number[]): void {
  for (const sub of subscriptions) {
    if (!sub.cb) continue
    try { sub.cb(bins) } catch { /* ignore */ }
  }
}

function syncFftMode(): void {
  if (typeof window === 'undefined' || !window.api?.audio) return

  let nextMode: FftMode = 'off'
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
  if (visible && subscriptions.size > 0) {
    if (windowFocused) {
      nextMode = 'screen'
    } else {
      nextMode = 'mini'
    }
    for (const sub of subscriptions) {
      if (windowFocused) break
      if (sub.mode === 'full') {
        nextMode = 'full'
        break
      }
    }
  }

  if (nextMode === appliedMode) return
  appliedMode = nextMode
  void window.api.audio.setFftMode(nextMode).catch(() => { /* main not ready */ })
}

// Collapse the 64 log-spaced bins emitted by the audio engine into N band
// averages. Used by the EQ visualizer to render one column per EQ band
// (default 10: 32 / 64 / 125 / 250 / 500 / 1k / 2k / 4k / 8k / 16k Hz). The
// source bins are already log-spaced over the original 1024 raw FFT bins, so
// slicing them into N contiguous groups gives a roughly log-aligned mapping
// onto the EQ band centers.
export function binsToBands(bins: number[], bandCount = 10, out?: Float32Array): Float32Array {
  const target = out && out.length === bandCount ? out : new Float32Array(bandCount)
  const len = bins.length
  if (len === 0) {
    target.fill(0)
    return target
  }
  for (let b = 0; b < bandCount; b++) {
    const start = Math.floor((b * len) / bandCount)
    const end = Math.max(start + 1, Math.floor(((b + 1) * len) / bandCount))
    let sum = 0
    for (let i = start; i < end; i++) sum += bins[i] ?? 0
    target[b] = sum / (end - start)
  }
  return target
}
