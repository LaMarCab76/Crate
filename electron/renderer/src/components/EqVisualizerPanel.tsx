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
const SCALE_EPSILON = 0.003
const IDLE_BAR_SCALE = 0.02

interface Props {
  track: Track
}

// Unified columns: bar height tracks the live FFT for each EQ band; the
// fill color tints toward the accent on boost / fades on cut; a thin
// horizontal thumb shows the band's gain. Dragging any column changes its
// gain, double-click resets to 0 dB.
export function EqVisualizerPanel({ track }: Props) {
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

  const fillRefs = useRef<(HTMLDivElement | null)[]>([])
  const smoothedRef = useRef<Float32Array>(new Float32Array(EQ_BAND_COUNT))
  const bandScratchRef = useRef<Float32Array>(new Float32Array(EQ_BAND_COUNT))
  const lastScaleRef = useRef<Float32Array>(new Float32Array(EQ_BAND_COUNT))
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
      lastScaleRef.current.fill(IDLE_BAR_SCALE)
      for (const el of fillRefs.current) {
        if (el) el.style.transform = `scaleY(${IDLE_BAR_SCALE})`
      }
      return
    }

    const stopDemand = subscribeFftDemand('full')
    lastScaleRef.current.fill(-1)

    let frame = 0
    const tick = () => {
      const targets = binsToBands(getLatestFft(), EQ_BAND_COUNT, bandScratchRef.current)
      const smoothed = smoothedRef.current
      const lastScale = lastScaleRef.current
      for (let i = 0; i < EQ_BAND_COUNT; i++) {
        smoothed[i] = smoothed[i] * EMA_ALPHA + targets[i] * (1 - EMA_ALPHA)
        const el = fillRefs.current[i]
        if (el) {
          const scale = Math.max(IDLE_BAR_SCALE, Math.min(1, smoothed[i]))
          if (Math.abs(scale - lastScale[i]) >= SCALE_EPSILON) {
            lastScale[i] = scale
            el.style.transform = `scaleY(${scale})`
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
    <div className="eq-viz" style={{ opacity: enabled ? 1 : 0.55 }}>
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
      <div className="eq-viz-body">
        <div className="eq-bands">
          {EQ_BAND_LABELS.map((label, i) => {
            const gain = displayBands[i] ?? 0
            const norm = gain / EQ_GAIN_MAX
            const bandStyle = { '--gain-norm': norm.toFixed(3) } as CSSProperties
            return (
              <div
                key={label}
                className={`eq-band${dragging === i ? ' dragging' : ''}`}
                style={bandStyle}
                role="slider"
                aria-label={`${label} Hz`}
                aria-valuemin={EQ_GAIN_MIN}
                aria-valuemax={EQ_GAIN_MAX}
                aria-valuenow={gain}
                aria-disabled={!enabled}
                tabIndex={enabled ? 0 : -1}
                onPointerDown={handlePointerDown(i)}
                onPointerMove={handlePointerMove(i)}
                onPointerUp={handlePointerUp(i)}
                onPointerCancel={handlePointerUp(i)}
                onDoubleClick={() => { if (enabled) void commitBandChange(i, 0) }}
                onKeyDown={handleKeyDown(i)}
              >
                <div className="eq-band-track">
                  <div
                    className="eq-band-fill"
                    ref={el => { fillRefs.current[i] = el }}
                  />
                  <div className="eq-band-thumb" />
                </div>
                <div className="hz">{label}</div>
                <div className="gain">
                  {gain > 0 ? `+${gain.toFixed(0)}` : gain.toFixed(0)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

