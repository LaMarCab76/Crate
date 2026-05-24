import { useEffect, useRef, type CSSProperties } from 'react'
import { binsToBands, subscribeFft } from '@renderer/utils/fft'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { usePlaybackTableBars } from '@renderer/utils/playbackTableBars'

const BAR_COUNT = 5
const FLOOR = 0.14
const DISPLAY_GAIN = 2.8
const ATTACK = 0.58
const RELEASE = 0.24

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function toDisplayScale(value: number): number {
  return clampUnit(Math.sqrt(clampUnit(value) * DISPLAY_GAIN))
}

// 5 mini bars that pulse with the actual audio of the playing track. They map
// directly onto low / low-mid / mid / high-mid / high bands from the 64-bin FFT.
export function EQBars({ style }: { style?: CSSProperties }) {
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const tableBars = usePlaybackTableBars(currentTrack)
  const currentTrackKey = currentTrack?.id ?? null
  const barRefs = useRef<Array<HTMLElement | null>>([])
  const bandBuffer = useRef(new Float32Array(BAR_COUNT))
  const target = useRef<number[]>(new Array(BAR_COUNT).fill(0.3))
  const current = useRef<number[]>(new Array(BAR_COUNT).fill(0.3))
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
    const cached =
      tableBars &&
      tableBars.complete &&
      tableBars.fps === 60 &&
      tableBars.bands >= BAR_COUNT &&
      tableBars.frames > 0 &&
      tableBars.values.length >= tableBars.frames * tableBars.bands
        ? tableBars
        : null

    const stopFft = cached ? null : subscribeFft(bins => {
      const bands = binsToBands(bins, BAR_COUNT, bandBuffer.current)
      for (let i = 0; i < BAR_COUNT; i++) target.current[i] = toDisplayScale(bands[i] ?? 0)
    }, 'mini')

    let frame = 0
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

      for (let i = 0; i < BAR_COUNT; i++) {
        const diff = target.current[i] - current.current[i]
        const weight = diff > 0 ? ATTACK : RELEASE
        const next = current.current[i] + diff * weight
        current.current[i] = next
        const el = barRefs.current[i]
        if (el) {
          const scale = Math.max(FLOOR, Math.min(1, next))
          el.style.transform = `scaleY(${scale})`
        }
      }
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => {
      if (stopFft) stopFft()
      cancelAnimationFrame(frame)
    }
  }, [tableBars, status])

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
