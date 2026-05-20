import { useEffect, useRef, type CSSProperties } from 'react'
import { binsToBands, subscribeFft } from '@renderer/utils/fft'

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
  const barRefs = useRef<Array<HTMLElement | null>>([])
  const bandBuffer = useRef(new Float32Array(BAR_COUNT))
  const target = useRef<number[]>(new Array(BAR_COUNT).fill(0.3))
  const current = useRef<number[]>(new Array(BAR_COUNT).fill(0.3))

  useEffect(() => {
    const stopFft = subscribeFft(bins => {
      const bands = binsToBands(bins, BAR_COUNT, bandBuffer.current)
      for (let i = 0; i < BAR_COUNT; i++) {
        target.current[i] = toDisplayScale(bands[i] ?? 0)
      }
    }, 'mini')

    let frame = 0
    const tick = () => {
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
      stopFft()
      cancelAnimationFrame(frame)
    }
  }, [])

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
