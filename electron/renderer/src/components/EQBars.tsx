import { useEffect, useRef, type CSSProperties } from 'react'
import { subscribeFft } from '@renderer/utils/fft'

// 3 mini bars that pulse with the actual audio of the playing track —
// bass / mid / treble bands from the main-process FFT broadcast. When no
// audio is flowing, the main process emits a flatline frame, so the bars
// settle at the floor automatically.
export function EQBars({ style }: { style?: CSSProperties }) {
  const ref0 = useRef<HTMLElement>(null)
  const ref1 = useRef<HTMLElement>(null)
  const ref2 = useRef<HTMLElement>(null)
  const smoothed = useRef<[number, number, number]>([0.3, 0.3, 0.3])

  useEffect(() => {
    return subscribeFft(bins => {
      // Average over 3 ranges of the 64-bin log-spaced FFT.
      let bass = 0, mid = 0, treble = 0
      for (let i = 0; i < 5; i++) bass += bins[i] ?? 0
      bass /= 5
      let count = 0
      for (let i = 15; i < 30; i++) { mid += bins[i] ?? 0; count++ }
      mid /= Math.max(1, count)
      count = 0
      for (let i = 40; i < 58; i++) { treble += bins[i] ?? 0; count++ }
      treble /= Math.max(1, count)

      const refs = [ref0, ref1, ref2]
      const targets = [bass, mid, treble]
      for (let i = 0; i < 3; i++) {
        const ema = smoothed.current[i] * 0.6 + targets[i] * 0.4
        smoothed.current[i] = ema
        const el = refs[i].current
        if (el) {
          // Override the keyframe-based animation with a direct scale set.
          el.style.animation = 'none'
          const scale = Math.max(0.22, Math.min(1, ema * 1.1))
          el.style.transform = `scaleY(${scale})`
        }
      }
    }, 'mini')
  }, [])

  return (
    <span className="eq-bars" style={style}>
      <i ref={ref0} /><i ref={ref1} /><i ref={ref2} />
    </span>
  )
}
