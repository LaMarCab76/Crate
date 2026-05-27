// Shared requestAnimationFrame loop with an FPS cap. Both audio visualizers
// (SpectrumVisualizer, EQBars) drive their animation from here so they don't do
// redundant work on high-refresh displays: the FFT feed never exceeds 60 Hz, so
// running the per-frame math + DOM writes faster than that (e.g. 120 Hz on a
// ProMotion panel) buys nothing visible while doubling the cost.
//
// The loop always reschedules rAF every frame to stay in sync with the
// compositor's repaint, but only invokes `tick` once the frame interval has
// elapsed. It advances a time accumulator (last += interval) instead of
// last = now so the cadence doesn't drift below the target rate.

export interface CappedRafHandle {
  stop: () => void
  // Force `tick` to run on the very next frame (resets the accumulator). Handy
  // when a value the loop renders changed and we want it reflected immediately.
  bump: () => void
}

const hasRaf = typeof requestAnimationFrame !== 'undefined'
const clock = () => (typeof performance === 'undefined' ? Date.now() : performance.now())

export function startCappedRafLoop(tick: (now: number) => void, fps = 60): CappedRafHandle {
  if (!hasRaf) return { stop: () => {}, bump: () => {} }

  const interval = 1000 / fps
  // Start one interval in the past so the first frame does work immediately.
  let last = clock() - interval
  let frame = 0

  const loop = (t: number) => {
    frame = requestAnimationFrame(loop)
    const elapsed = t - last
    // 1ms tolerance so sub-frame jitter doesn't drop us to half rate.
    if (elapsed < interval - 1) return
    // Advance by one interval normally; on a large gap (tab returned from the
    // background) snap to now instead of firing a burst of catch-up frames.
    last = elapsed > interval * 2 ? t : last + interval
    tick(t)
  }

  frame = requestAnimationFrame(loop)

  return {
    stop: () => cancelAnimationFrame(frame),
    bump: () => { last = clock() - interval },
  }
}
