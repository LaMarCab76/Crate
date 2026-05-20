import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { binsToBands, getLatestFft, subscribeFftDemand } from '@renderer/utils/fft'
import { EQ_BAND_LABELS } from '@shared/constants/equalizer'

// Symmetric EMA weight on the previous value — higher = smoother bars.
const EMA_ALPHA = 0.88
// Suppress writes when the smoothed lit value barely moves (≈ 0.25% of one
// segment), so an idle FFT doesn't churn DOM style writes.
const LIT_EPSILON = 0.03
// Boost applied inside the sqrt display curve so that typical FFT values
// (0.05–0.20) map to a visible bar height rather than near-zero.
const FFT_DISPLAY_GAIN = 2.2
// Peak-hold (full mode only): each band keeps its recent max as a tick that
// falls slowly. Decay is in segment units per frame.
const PEAK_DECAY = 0.05
const PEAK_EPSILON = 0.04

// Mini: a fixed column per EQ frequency, aligned with the EQ labels so the
// sidebar visualizer keeps a familiar 25 Hz → 16 kHz layout.
const MINI_BAND_COUNT = EQ_BAND_LABELS.length
const MINI_SEGMENTS = 12
// Full: a richer spectrum that sizes itself to the available width. More
// vertical "steps" and a dynamic column count fill the fullscreen panel.
const FULL_SEGMENTS = 22
const FULL_MIN_BANDS = 12
const FULL_MAX_BANDS = 48 // ≤ FFT_BINS_OUT (64) emitted by the engine
const FULL_PX_PER_BAND = 26

// The engine downsamples a 1024-bin FFT to 64 log-spaced output bins
// (FFT_BINS_OUT) over output bin i → raw bin floor(1023^(i/63)). Raw bin r maps
// to freq r·sampleRate/2048, so the visible axis runs log from sampleRate/2048
// up to ≈ Nyquist. These constants let us place frequency ticks at the matching
// x position regardless of the dynamic column count.
const FFT_RAW_BINS = 1024
const FREQ_AXIS_DENOM = Math.log(FFT_RAW_BINS - 1)
const FREQ_TICKS_HZ = [30, 60, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const DB_TICKS = ['0', '-6', '-12', '-20', '-40']

function freqTickLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`
}

interface Props {
  // 'mini' — fixed-width sidebar strip with frequency labels.
  // 'full' — fullscreen spectrum with a width-driven dynamic column count,
  //          plus a dB scale and a log frequency axis.
  mode?: 'mini' | 'full'
}

// Pure FFT spectrum. The EQ used to live here as draggable columns, but it now
// lives only in Settings, so this is a read-only visualizer. Each column is a
// stack of LED-style segments plus a separate clip LED above it; both read
// --lit, written once per band per frame on the .spectrum-band element from the
// JS hot loop. The clip LED lights up when the band tops out.
export function SpectrumVisualizer({ mode = 'mini' }: Props) {
  const playbackStatus = usePlaybackStore(s => s.status)
  const sampleRate = usePlaybackStore(s => s.streamInfo?.freq) ?? 44100
  const [windowVisible, setWindowVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  )

  const isFull = mode === 'full'
  const segmentCount = isFull ? FULL_SEGMENTS : MINI_SEGMENTS

  const bandsRef = useRef<HTMLDivElement>(null)
  const [bandCount, setBandCount] = useState(isFull ? FULL_MIN_BANDS : MINI_BAND_COUNT)

  // Keep the latest band count readable from the rAF loop without re-running
  // (and thus re-subscribing) the animation effect on every resize.
  const bandCountRef = useRef(bandCount)
  bandCountRef.current = bandCount

  const bandRefs = useRef<(HTMLDivElement | null)[]>([])
  const smoothedRef = useRef<Float32Array>(new Float32Array(bandCount))
  const bandScratchRef = useRef<Float32Array>(new Float32Array(bandCount))
  const lastLitRef = useRef<Float32Array>(new Float32Array(bandCount))
  const peakRef = useRef<Float32Array>(new Float32Array(bandCount))
  const lastPeakRef = useRef<Float32Array>(new Float32Array(bandCount))

  // Frequency-axis ticks placed at their log position (full mode only). x is a
  // fraction of the bands area, which aligns with the matching column center.
  const freqTicks = useMemo(() => {
    if (!isFull) return []
    const fMin = sampleRate / (2 * FFT_RAW_BINS)
    return FREQ_TICKS_HZ
      .map(hz => ({ hz, x: Math.log(hz / fMin) / FREQ_AXIS_DENOM }))
      .filter(t => t.x >= 0 && t.x <= 1)
  }, [isFull, sampleRate])

  // Full mode: derive the column count from the bands area width.
  useEffect(() => {
    if (!isFull) {
      setBandCount(MINI_BAND_COUNT)
      return
    }
    const el = bandsRef.current
    if (!el || typeof ResizeObserver === 'undefined') return

    const measure = () => {
      const w = el.clientWidth
      if (w <= 0) return
      const n = Math.max(
        FULL_MIN_BANDS,
        Math.min(FULL_MAX_BANDS, Math.round(w / FULL_PX_PER_BAND)),
      )
      setBandCount(prev => (prev === n ? prev : n))
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isFull])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const syncVisible = () => setWindowVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', syncVisible)
    return () => document.removeEventListener('visibilitychange', syncVisible)
  }, [])

  useEffect(() => {
    const shouldAnimate = playbackStatus === 'playing' && windowVisible
    if (!shouldAnimate) {
      smoothedRef.current.fill(0)
      lastLitRef.current.fill(0)
      peakRef.current.fill(0)
      lastPeakRef.current.fill(0)
      for (const el of bandRefs.current) {
        if (el) {
          el.style.setProperty('--lit', '0')
          el.style.setProperty('--peak', '0')
        }
      }
      return
    }

    // Both flavours drive the high-rate ('screen') feed so the segmented bars
    // stay smooth — the lighter 'mini' feed (~11 Hz) is too choppy for these.
    const stopDemand = subscribeFftDemand('full')
    // Force a write on the first frame even if the value didn't change.
    lastLitRef.current.fill(-1)
    lastPeakRef.current.fill(-1)

    let frame = 0
    const tick = () => {
      const n = bandCountRef.current
      // The column count can change between frames (full-mode resize); resize
      // the scratch/state buffers to match before sampling.
      if (smoothedRef.current.length !== n) {
        smoothedRef.current = new Float32Array(n)
        bandScratchRef.current = new Float32Array(n)
        lastLitRef.current = new Float32Array(n).fill(-1)
        peakRef.current = new Float32Array(n)
        lastPeakRef.current = new Float32Array(n).fill(-1)
      }
      const targets = binsToBands(getLatestFft(), n, bandScratchRef.current)
      const smoothed = smoothedRef.current
      const lastLit = lastLitRef.current
      const peak = peakRef.current
      const lastPeak = lastPeakRef.current
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
        // Peak-hold tick (full mode only): rise instantly to a new max, then
        // fall slowly. Writes are suppressed when the value barely moved.
        if (isFull) {
          peak[i] = lit >= peak[i] ? lit : Math.max(lit, peak[i] - PEAK_DECAY)
          if (Math.abs(peak[i] - lastPeak[i]) >= PEAK_EPSILON) {
            lastPeak[i] = peak[i]
            el.style.setProperty('--peak', peak[i].toFixed(2))
          }
        }
      }
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => {
      stopDemand()
      cancelAnimationFrame(frame)
    }
  }, [playbackStatus, windowVisible, isFull, segmentCount])

  return (
    <div
      className={`spectrum-viz ${isFull ? 'full' : 'mini'}`}
      style={{ '--seg': segmentCount } as CSSProperties}
    >
      <div className="spectrum-body">
        <div className="spectrum-plot">
          {isFull && (
            <div className="spectrum-db" aria-hidden="true">
              {DB_TICKS.map(t => <span key={t}>{t}</span>)}
            </div>
          )}
          <div className="spectrum-bands" ref={bandsRef}>
            {Array.from({ length: bandCount }).map((_, i) => {
              // Mini keeps frequency labels but shows only every other one so
              // they don't crowd; full mode uses the dedicated axis below.
              const label = !isFull && i % 2 === 0 ? EQ_BAND_LABELS[i] : null
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
                    {isFull && <div className="spectrum-peak" aria-hidden="true" />}
                  </div>
                  {!isFull && <div className="spectrum-hz">{label ?? ' '}</div>}
                </div>
              )
            })}
          </div>
        </div>
        {isFull && (
          <div className="spectrum-freq-row" aria-hidden="true">
            <div className="spectrum-freq">
              {freqTicks.map(t => (
                <span key={t.hz} style={{ left: `${t.x * 100}%` }}>{freqTickLabel(t.hz)}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
