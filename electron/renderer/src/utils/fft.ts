// FFT broadcast hub. The main process emits ~30 spectrum frames per second.
// Components that visualize the spectrum (EQBars in track rows, the
// fullscreen EqVisualizerPanel) subscribe here and update the DOM via refs —
// pushing every frame through React state would re-render the entire view
// 30 times a second.
//
// `getLatest()` is for read-on-demand consumers; `subscribe()` is for the
// per-frame consumers.

type Listener = (bins: number[]) => void

let latest: number[] = new Array(64).fill(0)
const listeners = new Set<Listener>()

if (typeof window !== 'undefined' && window.api?.audio) {
  window.api.audio.onFft(({ bins }) => {
    latest = bins
    for (const l of listeners) {
      try { l(bins) } catch { /* ignore */ }
    }
  })
}

export function subscribeFft(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getLatestFft(): number[] {
  return latest
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
