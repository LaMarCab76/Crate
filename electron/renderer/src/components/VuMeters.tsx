import { useEffect, useRef } from 'react'
import type { Track } from '@shared/types/library'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { getLatestLevels, subscribeLevelsDemand } from '@renderer/utils/levels'
import { dbFromLinear, fmtDb, fmtLufs } from '@renderer/utils/audioMath'

// Meter scale runs 0 → −40 dBFS, matching the labels on the left rail.
const DB_FLOOR = -40
const SCALE_DB = [0, -6, -12, -20, -40]
// Bar ballistics: instant attack, exponential release; the peak-hold tick falls
// much slower so the recent maximum lingers.
const FILL_RELEASE = 0.90
const HOLD_DECAY = 0.992
// Throttle the numeric readouts to ~10 Hz so text doesn't churn every frame.
const TEXT_EVERY = 6

// Linear amplitude → 0..1 bar height across the −40..0 dB window.
function heightFrac(linear: number): number {
  const db = dbFromLinear(linear, DB_FLOOR)
  return Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR))
}

// Stereo level meters with peak-hold and numeric Peak L/R, RMS, LUFS readouts.
// Reads the latest frame from the levels hub inside a rAF loop and writes CSS
// vars / textContent directly — no React state churn at frame rate.
export function VuMeters({ track }: { track: Track }) {
  const status = usePlaybackStore(s => s.status)
  const barLRef = useRef<HTMLDivElement>(null)
  const barRRef = useRef<HTMLDivElement>(null)
  const peakLRef = useRef<HTMLSpanElement>(null)
  const peakRRef = useRef<HTMLSpanElement>(null)
  const rmsRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const setBar = (el: HTMLDivElement | null, fill: number, peak: number) => {
      if (!el) return
      el.style.setProperty('--fill', fill.toFixed(3))
      el.style.setProperty('--peak', peak.toFixed(3))
    }

    if (status !== 'playing') {
      setBar(barLRef.current, 0, 0)
      setBar(barRRef.current, 0, 0)
      if (peakLRef.current) peakLRef.current.textContent = '-∞'
      if (peakRRef.current) peakRRef.current.textContent = '-∞'
      if (rmsRef.current) rmsRef.current.textContent = '-∞'
      return
    }

    const stop = subscribeLevelsDemand()
    let fillL = 0, fillR = 0, holdL = 0, holdR = 0, frame = 0, n = 0
    const tick = () => {
      const { peakL, peakR, rmsL, rmsR } = getLatestLevels()
      fillL = peakL > fillL ? peakL : fillL * FILL_RELEASE
      fillR = peakR > fillR ? peakR : fillR * FILL_RELEASE
      holdL = Math.max(peakL, holdL * HOLD_DECAY)
      holdR = Math.max(peakR, holdR * HOLD_DECAY)
      setBar(barLRef.current, heightFrac(fillL), heightFrac(holdL))
      setBar(barRRef.current, heightFrac(fillR), heightFrac(holdR))
      if (n++ % TEXT_EVERY === 0) {
        if (peakLRef.current) peakLRef.current.textContent = fmtDb(holdL, DB_FLOOR)
        if (peakRRef.current) peakRRef.current.textContent = fmtDb(holdR, DB_FLOOR)
        const rms = Math.sqrt((rmsL * rmsL + rmsR * rmsR) / 2)
        if (rmsRef.current) rmsRef.current.textContent = fmtDb(rms, DB_FLOOR)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      stop()
      cancelAnimationFrame(frame)
    }
  }, [status])

  return (
    <div className="vu-meters">
      <div className="vu-plot">
        <div className="vu-scale" aria-hidden="true">
          {SCALE_DB.map(db => (
            <span key={db} style={{ bottom: `${((db - DB_FLOOR) / -DB_FLOOR) * 100}%` }}>{db}</span>
          ))}
        </div>
        <div className="vu-bar" ref={barLRef}>
          <div className="vu-fill" />
          <div className="vu-peak-tick" />
        </div>
        <div className="vu-bar" ref={barRRef}>
          <div className="vu-fill" />
          <div className="vu-peak-tick" />
        </div>
      </div>
      <div className="vu-axis" aria-hidden="true">
        <span className="vu-axis-pad" />
        <span className="vu-ch">L</span>
        <span className="vu-ch">R</span>
      </div>

      <div className="vu-readouts">
        <div className="vu-row"><span className="k">Peak L</span><span className="v"><span ref={peakLRef}>-∞</span> dB</span></div>
        <div className="vu-row"><span className="k">Peak R</span><span className="v"><span ref={peakRRef}>-∞</span> dB</span></div>
        <div className="vu-row"><span className="k">RMS</span><span className="v"><span ref={rmsRef}>-∞</span> dB</span></div>
        <div className="vu-row"><span className="k">LUFS</span><span className="v">{fmtLufs(track.loudness)}</span></div>
      </div>
    </div>
  )
}
