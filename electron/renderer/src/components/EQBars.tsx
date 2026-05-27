import { useEffect, useRef, type CSSProperties } from 'react'
import { binsToBands, subscribeFft } from '@renderer/utils/fft'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { usePlaybackTableBars } from '@renderer/utils/playbackTableBars'
import { startCappedRafLoop, type CappedRafHandle } from '@renderer/utils/rafLoop'

const BAR_COUNT = 5
const FLOOR = 0.14
const DISPLAY_GAIN = 2.8
const ATTACK = 0.58
const RELEASE = 0.24
// Once the bars have settled this close to their target while paused, there's
// nothing left to animate, so the live loop parks itself until new audio.
const CONVERGE_EPS = 0.002
// Skip a transform write when the scale barely moved (≈0.4% of full height),
// so a near-idle feed doesn't churn DOM style writes every frame.
const SCALE_EPSILON = 0.004

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function toDisplayScale(value: number): number {
  return clampUnit(Math.sqrt(clampUnit(value) * DISPLAY_GAIN))
}

// 5 mini bars that pulse with the actual audio of the playing track. They map
// directly onto low / low-mid / mid / high-mid / high bands from the 64-bin FFT.
export function EQBars({ style, active = true }: { style?: CSSProperties; active?: boolean }) {
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const tableBars = usePlaybackTableBars(active ? currentTrack : null)
  const currentTrackKey = currentTrack?.id ?? null
  const barRefs = useRef<Array<HTMLElement | null>>([])
  const bandBuffer = useRef(new Float32Array(BAR_COUNT))
  const target = useRef<number[]>(new Array(BAR_COUNT).fill(0.3))
  const current = useRef<number[]>(new Array(BAR_COUNT).fill(0.3))
  const lastScaleRef = useRef<number[]>(new Array(BAR_COUNT).fill(-1))
  const positionRef = useRef(positionSec)
  const durationRef = useRef(durationSec)
  const positionUpdatedAtRef = useRef(typeof performance === 'undefined' ? Date.now() : performance.now())

  useEffect(() => {
    positionRef.current = positionSec
    positionUpdatedAtRef.current = typeof performance === 'undefined' ? Date.now() : performance.now()
  }, [positionSec])

  useEffect(() => {
    durationRef.current = durationSec
  }, [durationSec])

  useEffect(() => {
    positionUpdatedAtRef.current = typeof performance === 'undefined' ? Date.now() : performance.now()
  }, [status])

  useEffect(() => {
    positionRef.current = 0
    positionUpdatedAtRef.current = typeof performance === 'undefined' ? Date.now() : performance.now()
  }, [currentTrackKey])

  useEffect(() => {
    if (!active) {
      target.current.fill(FLOOR)
      current.current.fill(FLOOR)
      for (let i = 0; i < BAR_COUNT; i++) {
        const el = barRefs.current[i]
        if (el) el.style.transform = `scaleY(${FLOOR})`
        lastScaleRef.current[i] = FLOOR
      }
      return
    }

    const cached =
      tableBars &&
      tableBars.complete &&
      tableBars.fps === 60 &&
      tableBars.bands >= BAR_COUNT &&
      tableBars.frames > 0 &&
      tableBars.values.length >= tableBars.frames * tableBars.bands
        ? tableBars
        : null

    let running = false
    let handle: CappedRafHandle | null = null

    const stop = () => {
      running = false
      handle?.stop()
      handle = null
    }

    const tick = () => {
      if (cached) {
        const now = typeof performance === 'undefined' ? Date.now() : performance.now()
        const duration = durationRef.current > 0 ? durationRef.current : cached.durationSec
        const elapsed = status === 'playing' ? (now - positionUpdatedAtRef.current) / 1000 : 0
        const position = duration > 0
          ? Math.max(0, Math.min(duration, positionRef.current + elapsed))
          : 0
        const frameFloat = position * cached.fps
        const frameA = Math.max(0, Math.min(cached.frames - 1, Math.floor(frameFloat)))
        const frameB = Math.min(cached.frames - 1, frameA + 1)
        const mix = Math.max(0, Math.min(1, frameFloat - frameA))
        const offsetA = frameA * cached.bands
        const offsetB = frameB * cached.bands
        for (let i = 0; i < BAR_COUNT; i++) {
          const a = cached.values[offsetA + i] ?? 0
          const b = cached.values[offsetB + i] ?? a
          target.current[i] = a + (b - a) * mix
        }
      }

      let maxDiff = 0
      for (let i = 0; i < BAR_COUNT; i++) {
        const diff = target.current[i] - current.current[i]
        const adiff = Math.abs(diff)
        if (adiff > maxDiff) maxDiff = adiff
        const weight = diff > 0 ? ATTACK : RELEASE
        const next = current.current[i] + diff * weight
        current.current[i] = next
        const el = barRefs.current[i]
        if (el) {
          const scale = Math.max(FLOOR, Math.min(1, next))
          if (Math.abs(scale - lastScaleRef.current[i]) >= SCALE_EPSILON) {
            lastScaleRef.current[i] = scale
            el.style.transform = `scaleY(${scale})`
          }
        }
      }

      // Live + paused: the FFT feed has stopped, so once the bars settle there's
      // nothing left to animate. Snap to the target, write it, and park the loop.
      // New audio (subscribeFft callback) or a status change (re-runs this effect)
      // revives it. The cached path is left running so progress scrubbing still
      // moves the bars while paused — the FPS cap + epsilon keep that near-free.
      if (!cached && status !== 'playing' && maxDiff < CONVERGE_EPS) {
        for (let i = 0; i < BAR_COUNT; i++) {
          current.current[i] = target.current[i]
          const el = barRefs.current[i]
          if (el) {
            const scale = Math.max(FLOOR, Math.min(1, target.current[i]))
            lastScaleRef.current[i] = scale
            el.style.transform = `scaleY(${scale})`
          }
        }
        stop()
      }
    }

    const start = () => {
      if (running) return
      running = true
      // Force a write on the first frame even if the value didn't change.
      lastScaleRef.current.fill(-1)
      handle = startCappedRafLoop(tick)
    }

    const stopFft = cached ? null : subscribeFft(bins => {
      const bands = binsToBands(bins, BAR_COUNT, bandBuffer.current)
      for (let i = 0; i < BAR_COUNT; i++) target.current[i] = toDisplayScale(bands[i] ?? 0)
      // New audio arrived — revive the loop if it parked itself while paused.
      if (!running) start()
    }, 'mini')

    start()
    return () => {
      if (stopFft) stopFft()
      stop()
    }
  }, [active, tableBars, status])

  return (
    <span className="eq-bars" style={style}>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <i
          key={i}
          ref={el => {
            barRefs.current[i] = el
          }}
        />
      ))}
    </span>
  )
}
