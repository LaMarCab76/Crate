import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { useEqStore } from '@renderer/stores/eqStore'
import { binsToBands, subscribeFft } from '@renderer/utils/fft'
import type { Track } from '@shared/types/library'

const EQ_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'] as const
const BAND_COUNT = 10
const GAIN_MIN = -15
const GAIN_MAX = 15
const GAIN_STEP = 0.5
// Symmetric EMA weight on the previous value — higher = smoother bars.
const EMA_ALPHA = 0.78

interface Props {
  track: Track
}

// 10 unified columns: bar height tracks the live FFT for each EQ band; the
// fill color tints toward the accent on boost / fades on cut; a thin
// horizontal thumb shows the band's gain. Dragging any column changes its
// gain, double-click resets to 0 dB.
export function EqVisualizerPanel({ track }: Props) {
  const enabled = useEqStore(s => s.enabled)
  const globalBands = useEqStore(s => s.bands)
  const overrideBands = useEqStore(s => s.overrideBands)
  const setBand = useEqStore(s => s.setBand)
  const setEnabled = useEqStore(s => s.setEnabled)
  const setTrackOverride = useEqStore(s => s.setTrackOverride)

  const overrideActive = overrideBands !== null
  const bands = overrideActive ? overrideBands! : globalBands

  const fillRefs = useRef<(HTMLDivElement | null)[]>([])
  const smoothedRef = useRef<Float32Array>(new Float32Array(BAND_COUNT))
  const bandScratchRef = useRef<Float32Array>(new Float32Array(BAND_COUNT))

  useEffect(() => {
    return subscribeFft(bins => {
      const targets = binsToBands(bins, BAND_COUNT, bandScratchRef.current)
      const smoothed = smoothedRef.current
      for (let i = 0; i < BAND_COUNT; i++) {
        smoothed[i] = smoothed[i] * EMA_ALPHA + targets[i] * (1 - EMA_ALPHA)
        const el = fillRefs.current[i]
        if (el) {
          const h = Math.max(2, Math.min(100, smoothed[i] * 100))
          el.style.height = `${h}%`
        }
      }
    })
  }, [])

  const [dragging, setDragging] = useState<number | null>(null)
  const dragStartRef = useRef<{ y: number; gain: number; height: number } | null>(null)

  const clampGain = (g: number) => Math.max(GAIN_MIN, Math.min(GAIN_MAX, g))
  const snapGain = (g: number) => Math.round(g / GAIN_STEP) * GAIN_STEP

  const handleBandChange = (index: number, gain: number) => {
    const next = clampGain(gain)
    if (overrideActive && track.dbId != null) {
      const updated = [...bands]
      updated[index] = next
      void setTrackOverride(track.dbId, { enabled: true, bands: updated })
    } else {
      void setBand(index, next)
    }
  }

  const handlePointerDown = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (!enabled) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    dragStartRef.current = { y: e.clientY, gain: bands[i], height: rect.height }
    setDragging(i)
  }

  const handlePointerMove = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (dragging !== i || !dragStartRef.current) return
    const { y, gain, height } = dragStartRef.current
    if (height <= 0) return
    const pxPerDb = height / (GAIN_MAX - GAIN_MIN)
    const deltaDb = (y - e.clientY) / pxPerDb
    const next = snapGain(clampGain(gain + deltaDb))
    if (next !== bands[i]) handleBandChange(i, next)
  }

  const handlePointerUp = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (dragging !== i) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    dragStartRef.current = null
    setDragging(null)
  }

  const handleKeyDown = (i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (!enabled) return
    const step = e.shiftKey ? 2 : GAIN_STEP
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      handleBandChange(i, bands[i] + step)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      handleBandChange(i, bands[i] - step)
    } else if (e.key === 'Home' || e.key === '0') {
      e.preventDefault()
      handleBandChange(i, 0)
    }
  }

  const handleToggleOverride = () => {
    if (track.dbId == null) return
    if (overrideActive) {
      void setTrackOverride(track.dbId, null)
    } else {
      // Snapshot the current global bands so the slider doesn't jump to 0 on
      // first activation.
      void setTrackOverride(track.dbId, { enabled: true, bands: [...globalBands] })
    }
  }

  const handleReset = () => {
    const flat = new Array(BAND_COUNT).fill(0)
    if (overrideActive && track.dbId != null) {
      void setTrackOverride(track.dbId, { enabled: true, bands: flat })
    } else {
      for (let i = 0; i < BAND_COUNT; i++) void setBand(i, 0)
    }
  }

  return (
    <div className={`eq-viz${overrideActive ? ' override-active' : ''}`} style={{ opacity: enabled ? 1 : 0.55 }}>
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
        <div style={{ width: 12 }} />
        <div
          className={`toggle ${overrideActive ? 'on' : ''}`}
          onClick={handleToggleOverride}
          role="switch"
          aria-checked={overrideActive}
          tabIndex={0}
          title="Custom EQ for this song only"
        />
        <span className="switch-label">Custom for this track</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={handleReset}>Reset</button>
      </div>
      <div className="eq-viz-body">
        <div className="eq-bands">
          {EQ_LABELS.map((label, i) => {
            const gain = bands[i] ?? 0
            const norm = gain / GAIN_MAX
            const bandStyle = { '--gain-norm': norm.toFixed(3) } as CSSProperties
            return (
              <div
                key={label}
                className={`eq-band${dragging === i ? ' dragging' : ''}`}
                style={bandStyle}
                role="slider"
                aria-label={`${label} Hz`}
                aria-valuemin={GAIN_MIN}
                aria-valuemax={GAIN_MAX}
                aria-valuenow={gain}
                aria-disabled={!enabled}
                tabIndex={enabled ? 0 : -1}
                onPointerDown={handlePointerDown(i)}
                onPointerMove={handlePointerMove(i)}
                onPointerUp={handlePointerUp(i)}
                onPointerCancel={handlePointerUp(i)}
                onDoubleClick={() => { if (enabled) handleBandChange(i, 0) }}
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
