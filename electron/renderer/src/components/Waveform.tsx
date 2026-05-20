import { useEffect, useRef, type MouseEvent } from 'react'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'

// Pixels per drawn bar (bar + gap). The precomputed peaks (~1200) are collapsed
// to one bar per slot for the current canvas width.
const BAR_STEP = 3
const BAR_WIDTH = 2

interface Props {
  peaks: number[] | null
  durationSec: number
  loading?: boolean
}

// Static waveform drawn once to a canvas; only the played/remaining split and
// the playhead move. The playhead position is read non-reactively from the
// playback store inside a rAF loop, and redraws are gated to ≥1px movement.
export function Waveform({ peaks, durationSec, loading }: Props) {
  const seek = useQueueStore(s => s.seek)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const barsRef = useRef<number[]>([])
  const sizeRef = useRef({ w: 0, h: 0 })
  const dragFracRef = useRef<number | null>(null)
  const lastDrawnRef = useRef(-1)

  // Collapse the raw peaks into one value per pixel column (max-abs over range).
  const computeBars = (widthPx: number) => {
    const src = peaks ?? []
    const cols = Math.max(1, Math.floor(widthPx / BAR_STEP))
    const out = new Array(cols).fill(0)
    if (src.length === 0) { barsRef.current = out; return }
    for (let c = 0; c < cols; c++) {
      const start = Math.floor((c * src.length) / cols)
      const end = Math.max(start + 1, Math.floor(((c + 1) * src.length) / cols))
      let m = 0
      for (let i = start; i < end; i++) if (src[i] > m) m = src[i]
      out[c] = m
    }
    barsRef.current = out
  }

  const draw = (frac: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return

    const cs = getComputedStyle(canvas)
    const played = cs.getPropertyValue('--wave-played').trim() || '#6cc080'
    const remaining = cs.getPropertyValue('--wave-remaining').trim() || 'rgba(255,255,255,0.16)'
    const playheadColor = cs.getPropertyValue('--wave-playhead').trim() || 'rgba(255,255,255,0.9)'

    ctx.clearRect(0, 0, w, h)
    const bars = barsRef.current
    const midY = h / 2
    const playheadX = frac * w
    for (let c = 0; c < bars.length; c++) {
      const x = c * BAR_STEP
      const barH = Math.max(1, bars[c] * (h - 2))
      ctx.fillStyle = x + BAR_WIDTH / 2 <= playheadX ? played : remaining
      ctx.fillRect(x, midY - barH / 2, BAR_WIDTH, barH)
    }
    // Playhead line.
    ctx.fillStyle = playheadColor
    ctx.fillRect(Math.min(w - 1, Math.max(0, playheadX - 0.5)), 0, 1, h)
    lastDrawnRef.current = frac
  }

  const currentFrac = () => {
    if (dragFracRef.current !== null) return dragFracRef.current
    const pos = usePlaybackStore.getState().positionSec
    return durationSec > 0 ? Math.max(0, Math.min(1, pos / durationSec)) : 0
  }

  // Size to the container with devicePixelRatio backing for crisp bars.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      sizeRef.current = { w, h }
      computeBars(w)
      draw(currentFrac())
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Recompute + redraw when a new track's peaks arrive.
  useEffect(() => {
    computeBars(sizeRef.current.w)
    lastDrawnRef.current = -1
    draw(currentFrac())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks])

  // Animate the playhead; redraw only when it moved ≥1px.
  useEffect(() => {
    let frame = 0
    const tick = () => {
      const frac = currentFrac()
      const w = sizeRef.current.w
      if (Math.abs(frac - lastDrawnRef.current) * w >= 1) draw(frac)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationSec])

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const clamp = (clientX: number) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    dragFracRef.current = clamp(e.clientX)
    draw(dragFracRef.current)
    const onMove = (ev: globalThis.MouseEvent) => {
      dragFracRef.current = clamp(ev.clientX)
      draw(dragFracRef.current)
    }
    const onUp = (ev: globalThis.MouseEvent) => {
      void seek(clamp(ev.clientX) * durationSec)
      dragFracRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className="studio-waveform" ref={wrapRef} onMouseDown={onMouseDown} role="slider" tabIndex={0} aria-label="Seek">
      <canvas ref={canvasRef} className="studio-waveform-canvas" />
      {loading && !peaks && <div className="studio-waveform-loading">Analizando forma de onda…</div>}
    </div>
  )
}
