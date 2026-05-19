import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { useEqStore } from '@renderer/stores/eqStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { binsToBands, getLatestFft, subscribeFftDemand } from '@renderer/utils/fft'
import type { Track } from '@shared/types/library'
import {
  EQ_BAND_COUNT,
  EQ_BAND_LABELS,
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  EQ_GAIN_STEP,
} from '@shared/constants/equalizer'

// Symmetric EMA weight on the previous value — higher = smoother bars.
const EMA_ALPHA = 0.88
// Number of discrete LED-style segments per band. The visualizer renders
// SEGMENT_COUNT divs inside each band track; --lit on the track drives which
// segments light up via CSS, so the JS hot loop only writes one custom
// property per band per frame.
const SEGMENT_COUNT = 12
// Suppress writes when the smoothed lit value barely moves (≈ 0.25% of one
// segment), so an idle FFT doesn't churn DOM style writes.
const LIT_EPSILON = 0.03

interface Props {
  track: Track
  interactive?: boolean
}

// Unified columns: bar height tracks the live FFT for each EQ band; the
// fill color tints toward the accent on boost / fades on cut; a thin
// horizontal thumb shows the band's gain. Dragging any column changes its
// gain, double-click resets to 0 dB. With `interactive=false`, controls and
// the gain thumb/label are hidden — the panel renders as a pure visualizer.
export function EqVisualizerPanel({ track, interactive = true }: Props) {
  const enabled = useEqStore(s => s.enabled)
  const globalBands = useEqStore(s => s.bands)
  const setBand = useEqStore(s => s.setBand)
  const setBands = useEqStore(s => s.setBands)
  const previewBand = useEqStore(s => s.previewBand)
  const setEnabled = useEqStore(s => s.setEnabled)
  const playbackStatus = usePlaybackStore(s => s.status)
  const [windowActive, setWindowActive] = useState(() =>
    typeof document === 'undefined'
      ? true
      : document.visibilityState !== 'hidden' && document.hasFocus(),
  )

  const [draftBands, setDraftBandsState] = useState<number[] | null>(null)
  const displayBands = draftBands ?? globalBands

  const trackRefs = useRef<(HTMLDivElement | null)[]>([])
  const smoothedRef = useRef<Float32Array>(new Float32Array(EQ_BAND_COUNT))
  const bandScratchRef = useRef<Float32Array>(new Float32Array(EQ_BAND_COUNT))
  const lastLitRef = useRef<Float32Array>(new Float32Array(EQ_BAND_COUNT))
  const displayBandsRef = useRef<number[]>(displayBands)
  const draftBandsRef = useRef<number[] | null>(null)
  const pendingPreviewRef = useRef<{ index: number; gain: number } | null>(null)
  const previewFrameRef = useRef<number | null>(null)
  const commitSeqRef = useRef(0)

  displayBandsRef.current = displayBands

  const syncDraftBands = (next: number[] | null) => {
    draftBandsRef.current = next
    setDraftBandsState(next)
  }

  useEffect(() => {
    if (typeof document === 'undefined') return

    const syncActive = () => {
      setWindowActive(document.visibilityState !== 'hidden' && document.hasFocus())
    }
    window.addEventListener('focus', syncActive)
    window.addEventListener('blur', syncActive)
    document.addEventListener('visibilitychange', syncActive)
    return () => {
      window.removeEventListener('focus', syncActive)
      window.removeEventListener('blur', syncActive)
      document.removeEventListener('visibilitychange', syncActive)
    }
  }, [])

  useEffect(() => {
    const shouldAnimate = playbackStatus === 'playing' && windowActive
    if (!shouldAnimate) {
      smoothedRef.current.fill(0)
      lastLitRef.current.fill(0)
      for (const el of trackRefs.current) {
        if (el) el.style.setProperty('--lit', '0')
      }
      return
    }

    const stopDemand = subscribeFftDemand('full')
    // Force a write on the first frame even if the value didn't change.
    lastLitRef.current.fill(-1)

    let frame = 0
    const tick = () => {
      const targets = binsToBands(getLatestFft(), EQ_BAND_COUNT, bandScratchRef.current)
      const smoothed = smoothedRef.current
      const lastLit = lastLitRef.current
      for (let i = 0; i < EQ_BAND_COUNT; i++) {
        smoothed[i] = smoothed[i] * EMA_ALPHA + targets[i] * (1 - EMA_ALPHA)
        const el = trackRefs.current[i]
        if (!el) continue
        const lit = Math.max(0, Math.min(SEGMENT_COUNT, smoothed[i] * SEGMENT_COUNT))
        if (Math.abs(lit - lastLit[i]) >= LIT_EPSILON) {
          lastLit[i] = lit
          el.style.setProperty('--lit', lit.toFixed(2))
        }
      }
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => {
      stopDemand()
      cancelAnimationFrame(frame)
    }
  }, [playbackStatus, windowActive])

  const [dragging, setDragging] = useState<number | null>(null)
  const draggingRef = useRef<number | null>(null)
  const dragStartRef = useRef<{ y: number; gain: number; height: number } | null>(null)

  const clampGain = (g: number) => Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, g))
  const snapGain = (g: number) => Math.round(g / EQ_GAIN_STEP) * EQ_GAIN_STEP

  const setDraggingIndex = (index: number | null) => {
    draggingRef.current = index
    setDragging(index)
  }

  const queuePreview = (index: number, gain: number) => {
    pendingPreviewRef.current = { index, gain }
    if (previewFrameRef.current !== null) return
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null
      const pending = pendingPreviewRef.current
      pendingPreviewRef.current = null
      if (pending) void previewBand(pending.index, pending.gain)
    })
  }

  const updateDraftBand = (index: number, gain: number) => {
    const next = clampGain(gain)
    const base = draftBandsRef.current ?? displayBandsRef.current
    if (next === (base[index] ?? 0)) return
    const updated = [...base]
    updated[index] = next
    syncDraftBands(updated)
    queuePreview(index, next)
  }

  const commitBandChange = (index: number, gain: number) => {
    const next = clampGain(gain)
    return setBand(index, next)
  }

  const handlePointerDown = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (!enabled) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const base = [...displayBandsRef.current]
    syncDraftBands(base)
    dragStartRef.current = { y: e.clientY, gain: base[i] ?? 0, height: rect.height }
    setDraggingIndex(i)
  }

  const handlePointerMove = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current !== i || !dragStartRef.current) return
    const { y, gain, height } = dragStartRef.current
    if (height <= 0) return
    const pxPerDb = height / (EQ_GAIN_MAX - EQ_GAIN_MIN)
    const deltaDb = (y - e.clientY) / pxPerDb
    const next = snapGain(clampGain(gain + deltaDb))
    updateDraftBand(i, next)
  }

  const handlePointerUp = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current !== i) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    const finalBands = draftBandsRef.current
    const finalGain = finalBands?.[i] ?? displayBandsRef.current[i] ?? 0
    const commitSeq = ++commitSeqRef.current
    dragStartRef.current = null
    setDraggingIndex(null)
    draggingRef.current = null
    if (!finalBands) return
    void commitBandChange(i, finalGain)
      .catch(() => { /* keep UI responsive; store sync will recover */ })
      .finally(() => {
        if (commitSeqRef.current === commitSeq) syncDraftBands(null)
      })
  }

  const handleKeyDown = (i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (!enabled) return
    const step = e.shiftKey ? 2 : EQ_GAIN_STEP
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      void commitBandChange(i, (displayBandsRef.current[i] ?? 0) + step)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      void commitBandChange(i, (displayBandsRef.current[i] ?? 0) - step)
    } else if (e.key === 'Home' || e.key === '0') {
      e.preventDefault()
      void commitBandChange(i, 0)
    }
  }

  useEffect(() => {
    return () => {
      if (previewFrameRef.current !== null) cancelAnimationFrame(previewFrameRef.current)
    }
  }, [])

  useEffect(() => {
    dragStartRef.current = null
    setDraggingIndex(null)
    draggingRef.current = null
    syncDraftBands(null)
  }, [track.dbId])

  const handleReset = () => {
    const flat = new Array(EQ_BAND_COUNT).fill(0)
    syncDraftBands(null)
    void setBands(flat)
  }

  return (
    <div className={`eq-viz${interactive ? '' : ' readonly'}`} style={{ opacity: enabled ? 1 : 0.55 }}>
      {interactive && (
        <div className="eq-viz-head">
          <div
            className={`toggle ${enabled ? 'on' : ''}`}
            onClick={() => { void setEnabled(!enabled) }}
            role="switch"
            aria-checked={enabled}
            tabIndex={0}
            title={enabled ? 'EQ on' : 'EQ off'}
          />
          <span className="switch-label">EQ</span>
          <div style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={handleReset}>Reset</button>
        </div>
      )}
      <div className="eq-viz-body">
        <div className="eq-bands">
          <div className="eq-db-scale" aria-hidden="true">
            <div className="eq-db-track">
              <span>0</span>
              <span>-6</span>
              <span>-12</span>
              <span>-20</span>
              <span>-40</span>
            </div>
            <div className="eq-db-spacer">&nbsp;</div>
            {interactive && <div className="eq-db-spacer">&nbsp;</div>}
          </div>
          {EQ_BAND_LABELS.map((label, i) => {
            const gain = displayBands[i] ?? 0
            const norm = gain / EQ_GAIN_MAX
            const bandStyle = { '--gain-norm': norm.toFixed(3) } as CSSProperties
            return (
              <div
                key={label}
                className={`eq-band${interactive && dragging === i ? ' dragging' : ''}`}
                style={bandStyle}
                role={interactive ? 'slider' : undefined}
                aria-label={interactive ? `${label} Hz` : undefined}
                aria-valuemin={interactive ? EQ_GAIN_MIN : undefined}
                aria-valuemax={interactive ? EQ_GAIN_MAX : undefined}
                aria-valuenow={interactive ? gain : undefined}
                aria-disabled={interactive ? !enabled : undefined}
                tabIndex={interactive ? (enabled ? 0 : -1) : undefined}
                onPointerDown={interactive ? handlePointerDown(i) : undefined}
                onPointerMove={interactive ? handlePointerMove(i) : undefined}
                onPointerUp={interactive ? handlePointerUp(i) : undefined}
                onPointerCancel={interactive ? handlePointerUp(i) : undefined}
                onDoubleClick={interactive ? () => { if (enabled) void commitBandChange(i, 0) } : undefined}
                onKeyDown={interactive ? handleKeyDown(i) : undefined}
              >
                <div
                  className="eq-band-track"
                  ref={el => { trackRefs.current[i] = el }}
                >
                  {Array.from({ length: SEGMENT_COUNT }).map((_, segIdx) => (
                    <div
                      key={segIdx}
                      className="eq-band-segment"
                      style={{ '--idx': SEGMENT_COUNT - 1 - segIdx } as CSSProperties}
                    />
                  ))}
                  {interactive && <div className="eq-band-thumb" />}
                </div>
                <div className="hz">{label}</div>
                {interactive && (
                  <div className="gain">
                    {gain > 0 ? `+${gain.toFixed(0)}` : gain.toFixed(0)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

