import { useEffect, useMemo, useState } from 'react'
import { SpectrumVisualizer } from './SpectrumVisualizer'
import {
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  EQ_GAIN_STEP,
  clampEqGain,
} from '@shared/constants/equalizer'

// One unified EQ surface: the live spectrum sits behind, the current EQ response
// is drawn as a curve over it (always visible — this is the idle "graphical EQ"),
// and the interactive vertical sliders expose only their thumbs until the user
// drags them. The spectrum is forced to exactly `bandCount` columns so each bar
// lines up under its band, and the curve nodes share the slider columns' centers.

// Vertical-range orientation: writing-mode + direction handle Chromium while
// leaving appearance to CSS so the native track can be fully hidden.
const VERTICAL_SLIDER_STYLE = {
  flex: 1,
  minWidth: 0,
  writingMode: 'vertical-lr',
  direction: 'rtl',
} as const

// Map a gain in [EQ_GAIN_MIN, EQ_GAIN_MAX] to a y position in the 0..100 viewBox.
// A native range thumb's center can't reach the track edge — it insets by one
// thumb radius — so the curve's usable half-span must match that inset for the
// nodes to land on the thumbs at every gain (not just at 0 dB, where both sit at
// the center). The geometry is fixed in CSS: the thumb is EQ_THUMB_PX wide
// (globals.css ::-webkit/-moz thumb) and the track is EQ_TRACK_PX tall
// (.eq-unified 200px − .eq-unified-bands top:12 + bottom:22). So the margin is
// (radius / track) ≈ 5.42%: +15 dB → ~5.42, 0 dB → 50, −15 dB → ~94.58.
const EQ_THUMB_PX = 18
const EQ_TRACK_PX = 166
const EQ_EDGE_MARGIN = ((EQ_THUMB_PX / 2) / EQ_TRACK_PX) * 100
const EQ_HALF_SPAN = 50 - EQ_EDGE_MARGIN

function gainToY(gain: number): number {
  return 50 - (clampEqGain(gain) / EQ_GAIN_MAX) * EQ_HALF_SPAN
}

interface EqGraphProps {
  enabled: boolean
  bands: number[]
  bandCount: number
  labels: string[]
  labelStep: number
  playing: boolean
  hasTrack: boolean
  onSetBand: (index: number, gain: number) => void
}

export function EqGraph({
  enabled,
  bands,
  bandCount,
  labels,
  labelStep,
  playing,
  hasTrack,
  onSetBand,
}: EqGraphProps) {
  // Authoritative "the user is editing" flag. A native range drag captures the
  // pointer, so it can leave the box mid-gesture; this keeps the reveal up until
  // the pointer is actually released, regardless of where that happens.
  const [interacting, setInteracting] = useState(false)
  // The band currently being dragged + its live gain, fed straight from the
  // range input's onChange (no need to wait for eqStore.setBand's async IPC
  // round-trip to refresh `bands`). Drives the floating dB readout.
  const [active, setActive] = useState<{ index: number; gain: number } | null>(null)
  useEffect(() => {
    if (!interacting) return
    const end = () => { setInteracting(false); setActive(null) }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [interacting])

  // Defer mounting the spectrum (≈ bandCount × FULL_VIZ_SEGMENTS LED nodes) until
  // one frame after the panel paints, so opening Settings → Equalizer doesn't pay
  // that layout + composite spike on the navigation frame (it was a source of an
  // intermittent freeze on entry). The box keeps its size meanwhile, so nothing
  // shifts when the bars fill in.
  const [spectrumReady, setSpectrumReady] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setSpectrumReady(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const curvePoints = useMemo(
    () =>
      Array.from({ length: bandCount }, (_, i) => {
        const x = ((i + 0.5) / bandCount) * 100
        return `${x.toFixed(2)},${gainToY(bands[i] ?? 0).toFixed(2)}`
      }).join(' '),
    [bands, bandCount],
  )

  return (
    <div
      className={`eq-unified${interacting ? ' interacting' : ''}`}
      data-enabled={enabled}
    >
      <div className="eq-unified-spectrum">
        {spectrumReady && (
          <SpectrumVisualizer mode="full" active columns={bandCount} />
        )}
      </div>

      <svg
        className="eq-unified-curve"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          className="eq-curve-zero"
          x1="0"
          y1="50"
          x2="100"
          y2="50"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          className="eq-curve-line"
          points={curvePoints}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="eq-unified-scrim" aria-hidden="true" />

      {!playing && (
        <div className="eq-unified-hint">
          {hasTrack
            ? 'En pausa — reanudá para ver el espectro'
            : 'Reproducí un tema para ver el visualizador'}
        </div>
      )}

      <div
        className="eq-unified-bands"
        onPointerDown={() => setInteracting(true)}
      >
        {labels.map((label, i) => {
          const gain = bands[i] ?? 0
          return (
            <div key={i} className="eq-band">
              <input
                type="range"
                min={EQ_GAIN_MIN}
                max={EQ_GAIN_MAX}
                step={EQ_GAIN_STEP}
                value={gain}
                disabled={!enabled}
                onChange={e => {
                  const value = parseFloat(e.target.value)
                  setActive({ index: i, gain: value })
                  onSetBand(i, value)
                }}
                title={`${label} Hz: ${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`}
                style={VERTICAL_SLIDER_STYLE}
              />
            </div>
          )
        })}
      </div>

      {active && (
        <div className="eq-unified-readout-layer" aria-hidden="true">
          <div
            className={`eq-unified-readout${gainToY(active.gain) < 22 ? ' below' : ''}`}
            style={{
              left: `${((active.index + 0.5) / bandCount) * 100}%`,
              top: `${gainToY(active.gain)}%`,
            }}
          >
            {active.gain > 0 ? '+' : ''}{active.gain.toFixed(1)} dB
          </div>
        </div>
      )}

      <div className="eq-unified-labels" aria-hidden="true">
        {labels.map((label, i) => (
          <span key={i} className="hz">
            {i % labelStep === 0 ? label : ' '}
          </span>
        ))}
      </div>
    </div>
  )
}
