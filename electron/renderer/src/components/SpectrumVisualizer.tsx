import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { binsToBands, getLatestFft, subscribeFftDemand } from '@renderer/utils/fft'
import { startCappedRafLoop } from '@renderer/utils/rafLoop'
import { FULL_VIZ_SEGMENTS } from '@renderer/constants/visualizer'
import { EQ_BAND_LABELS } from '@shared/constants/equalizer'

// Symmetric EMA weight on the previous value — higher = smoother bars.
const EMA_ALPHA = 0.88
// Suppress writes when the smoothed lit value barely moves (≈ 0.25% of one
// segment), so an idle FFT doesn't churn DOM style writes.
const LIT_EPSILON = 0.03
// Boost applied inside the sqrt display curve so that typical FFT values
// (0.05–0.20) map to a visible bar height rather than near-zero.
const FFT_DISPLAY_GAIN = 2.2
// Mini/bar: fixed columns per EQ frequency, aligned with the EQ labels so the
// sidebar and collapsed-player visualizers keep a familiar 25 Hz → 16 kHz layout.
const MINI_BAND_COUNT = EQ_BAND_LABELS.length
const MINI_SEGMENTS = 12
const BAR_SEGMENTS = 5
// Full: a richer spectrum that sizes itself to the available width. Compact
// uses the same live FFT feed but fewer steps/columns for the lyrics combo view.
const FULL_SEGMENTS = FULL_VIZ_SEGMENTS
const COMPACT_SEGMENTS = 12
const FULL_MIN_BANDS = 12
const FULL_MAX_BANDS = 48 // ≤ FFT_BINS_OUT (64) emitted by the engine
const FULL_PX_PER_BAND = 26
const COMPACT_MIN_BANDS = 10
const COMPACT_MAX_BANDS = 32
const COMPACT_PX_PER_BAND = 24

// The engine downsamples a 1024-bin FFT to 64 log-spaced output bins
// (FFT_BINS_OUT) over output bin i → raw bin floor(1023^(i/63)). Raw bin r maps
// to freq r·sampleRate/2048, so the visible axis runs log from sampleRate/2048
// up to ≈ Nyquist. These constants let us place frequency ticks at the matching
// x position regardless of the dynamic column count.
const FFT_RAW_BINS = 1024
const FREQ_AXIS_DENOM = Math.log(FFT_RAW_BINS - 1)
const FREQ_TICKS_HZ = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
  630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
  10000, 12500, 16000, 20000,
]
const COMPACT_FREQ_TICKS_HZ = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

// Rough dB ticks for the left axis. The display curve is sqrt(amp·gain), so
// these are approximations rather than calibrated levels — they're meant to
// give the eye a feel for relative loudness, not a meter-grade reading.
const DB_TICKS = [
  { label: '0', y: 6 },
  { label: '-6', y: 28 },
  { label: '-12', y: 52 },
  { label: '-24', y: 80 },
] as const

function freqTickLabel(hz: number): string {
  if (hz >= 1000) {
    return `${Number.parseFloat((hz / 1000).toFixed(2))}kHz`
  }
  return `${hz}Hz`
}

function freqX(hz: number, sampleRate: number): number {
  const fMin = sampleRate / (2 * FFT_RAW_BINS)
  return Math.log(hz / fMin) / FREQ_AXIS_DENOM
}

interface Props {
  // 'mini' — fixed-width sidebar strip with frequency labels.
  // 'bar'  — horizontal collapsed-player strip with five LED steps.
  // 'full' — fullscreen spectrum with a width-driven dynamic column count
  //          and a dense log frequency axis.
  // 'compact' — shorter fullscreen spectrum shown under side lyrics.
  mode?: 'mini' | 'bar' | 'full' | 'compact'
  // Active means the owning surface is intentionally visible. The component
  // also verifies viewport intersection before demanding FFT frames.
  active?: boolean
}

// Pure FFT spectrum. The EQ used to live here as draggable columns, but it now
// lives only in Settings, so this is a read-only visualizer. Each column is a
// stack of LED-style segments plus a separate clip LED above it; both read
// --lit, written once per band per frame on the .spectrum-band element from the
// JS hot loop. The clip LED lights up when the band tops out.
export function SpectrumVisualizer({ mode = 'mini', active = true }: Props) {
  const playbackStatus = usePlaybackStore(s => s.status)
  const sampleRate = usePlaybackStore(s => s.streamInfo?.freq) ?? 44100
  const [windowVisible, setWindowVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  )
  const [elementVisible, setElementVisible] = useState(() =>
    typeof IntersectionObserver === 'undefined',
  )

  const isFull = mode === 'full'
  const isCompact = mode === 'compact'
  const isFullscreenSpectrum = isFull || isCompact
  const isBar = mode === 'bar'
  const segmentCount = isFull ? FULL_SEGMENTS : isCompact ? COMPACT_SEGMENTS : isBar ? BAR_SEGMENTS : MINI_SEGMENTS

  const bandsRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [bandCount, setBandCount] = useState(isFull ? FULL_MIN_BANDS : isCompact ? COMPACT_MIN_BANDS : MINI_BAND_COUNT)

  // Keep the latest band count readable from the rAF loop without re-running
  // (and thus re-subscribing) the animation effect on every resize.
  const bandCountRef = useRef(bandCount)
  bandCountRef.current = bandCount

  const bandRefs = useRef<(HTMLDivElement | null)[]>([])
  const smoothedRef = useRef<Float32Array>(new Float32Array(bandCount))
  const bandScratchRef = useRef<Float32Array>(new Float32Array(bandCount))
  const lastLitRef = useRef<Float32Array>(new Float32Array(bandCount))

  const isElementRectVisible = () => {
    const el = rootRef.current
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return (
      rect.width > 0
      && rect.height > 0
      && rect.bottom > 0
      && rect.top < (window.innerHeight || 0)
      && rect.right > 0
      && rect.left < (window.innerWidth || 0)
    )
  }

  // Frequency-axis ticks placed at their log position. x is a fraction of the
  // bands area, which aligns with the matching column center.
  const freqTicks = useMemo(() => {
    if (!isFullscreenSpectrum) return []
    const ticks = isCompact ? COMPACT_FREQ_TICKS_HZ : FREQ_TICKS_HZ
    return ticks
      .map(hz => ({ hz, x: freqX(hz, sampleRate) }))
      .filter(t => t.x >= 0 && t.x <= 1)
  }, [isCompact, isFullscreenSpectrum, sampleRate])

  // Fullscreen modes derive the column count from the bands area width.
  useEffect(() => {
    if (!isFullscreenSpectrum) {
      setBandCount(MINI_BAND_COUNT)
      return
    }
    const el = bandsRef.current
    if (!el || typeof ResizeObserver === 'undefined') return

    const measure = () => {
      const w = el.clientWidth
      if (w <= 0) return
      const minBands = isCompact ? COMPACT_MIN_BANDS : FULL_MIN_BANDS
      const maxBands = isCompact ? COMPACT_MAX_BANDS : FULL_MAX_BANDS
      const pxPerBand = isCompact ? COMPACT_PX_PER_BAND : FULL_PX_PER_BAND
      const n = Math.max(
        minBands,
        Math.min(maxBands, Math.round(w / pxPerBand)),
      )
      setBandCount(prev => (prev === n ? prev : n))
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isCompact, isFullscreenSpectrum])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const syncVisible = () => setWindowVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', syncVisible)
    return () => document.removeEventListener('visibilitychange', syncVisible)
  }, [])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setElementVisible(true)
      return
    }

    const el = rootRef.current
    if (!el) return
    if (isElementRectVisible()) setElementVisible(true)

    const observer = new IntersectionObserver(entries => {
      const entry = entries[0]
      setElementVisible(Boolean(entry?.isIntersecting && entry.intersectionRatio > 0))
    })
    observer.observe(el)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!active || playbackStatus !== 'playing' || elementVisible) return

    let frame = 0
    let attempts = 0
    const maxAttempts = 8

    const checkRect = () => {
      if (isElementRectVisible()) {
        setElementVisible(true)
        return
      }

      attempts += 1
      if (attempts >= maxAttempts || !active || playbackStatus !== 'playing') return
      frame = window.requestAnimationFrame(checkRect)
    }

    frame = window.requestAnimationFrame(checkRect)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [active, elementVisible, playbackStatus])

  useEffect(() => {
    const shouldAnimate = active && playbackStatus === 'playing' && windowVisible && elementVisible
    if (!shouldAnimate) {
      smoothedRef.current.fill(0)
      lastLitRef.current.fill(0)
      for (const el of bandRefs.current) {
        if (el) {
          el.style.setProperty('--lit', '0')
        }
      }
      return
    }

    // Visible visualizers always use the live high-rate FFT feed. Cached
    // analysis is reserved for compact table indicators.
    const stopDemand = subscribeFftDemand('full')
    // Force a write on the first frame even if the value didn't change.
    lastLitRef.current.fill(-1)

    const tick = () => {
      const n = bandCountRef.current
      // The column count can change between frames (full-mode resize); resize
      // the scratch/state buffers to match before sampling.
      if (smoothedRef.current.length !== n) {
        smoothedRef.current = new Float32Array(n)
        bandScratchRef.current = new Float32Array(n)
        lastLitRef.current = new Float32Array(n).fill(-1)
      }
      const targets = binsToBands(getLatestFft(), n, bandScratchRef.current)
      const smoothed = smoothedRef.current
      const lastLit = lastLitRef.current
      for (let i = 0; i < n; i++) {
        smoothed[i] = smoothed[i] * EMA_ALPHA + targets[i] * (1 - EMA_ALPHA)
        const el = bandRefs.current[i]
        if (!el) continue
        const lit = Math.max(
          0,
          Math.min(segmentCount, Math.sqrt(smoothed[i] * FFT_DISPLAY_GAIN) * segmentCount),
        )
        if (Math.abs(lit - lastLit[i]) >= LIT_EPSILON) {
          lastLit[i] = lit
          el.style.setProperty('--lit', lit.toFixed(2))
        }
      }
    }

    // Cap at 60 FPS: the engine never emits FFT faster than that, so a higher
    // refresh rate (ProMotion) would just repeat work for no visible gain.
    const handle = startCappedRafLoop(tick)
    return () => {
      stopDemand()
      handle.stop()
    }
  }, [active, playbackStatus, windowVisible, elementVisible, isFullscreenSpectrum, segmentCount])

  return (
    <div
      ref={rootRef}
      className={`spectrum-viz ${isFull ? 'full' : isCompact ? 'compact' : isBar ? 'bar' : 'mini'}`}
      style={{ '--seg': segmentCount } as CSSProperties}
    >
      <div className="spectrum-body">
        <div className="spectrum-plot">
          {isFullscreenSpectrum && (
            <div className="spectrum-db-axis" aria-hidden="true">
              {DB_TICKS.map(t => (
                <span key={t.label} style={{ top: `${t.y}%` }}>{t.label}</span>
              ))}
            </div>
          )}
          <div className="spectrum-bands" ref={bandsRef}>
            {Array.from({ length: bandCount }).map((_, i) => {
              // Mini keeps frequency labels but shows only every other one so
              // they don't crowd; full mode uses the dedicated axis below.
              const label = !isFullscreenSpectrum && !isBar && i % 2 === 0 ? EQ_BAND_LABELS[i] : null
              return (
                <div
                  className="spectrum-band"
                  key={i}
                  ref={el => { bandRefs.current[i] = el }}
                >
                  <div className="spectrum-clip" aria-hidden="true" />
                  <div className="spectrum-band-track">
                    {Array.from({ length: segmentCount }).map((_, segIdx) => (
                      <div
                        key={segIdx}
                        className="spectrum-segment"
                        style={{ '--idx': segmentCount - 1 - segIdx } as CSSProperties}
                      />
                    ))}
                  </div>
                  {!isFullscreenSpectrum && <div className="spectrum-hz">{label ?? ' '}</div>}
                </div>
              )
            })}
          </div>
        </div>
        {isFullscreenSpectrum && (
          <div className="spectrum-freq-row" aria-hidden="true">
            <div className="spectrum-freq">
              {freqTicks.map((t, i) => (
                <span
                  key={t.hz}
                  style={{
                    left: `${t.x * 100}%`,
                    '--tick-row': isCompact ? 0 : i % 2,
                  } as CSSProperties}
                >
                  {freqTickLabel(t.hz)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
