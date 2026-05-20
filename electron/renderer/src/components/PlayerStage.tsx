import { type CSSProperties, type MouseEvent, useState } from 'react'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { fmtTime } from '@renderer/utils/format'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import type { Track } from '@shared/types/library'

interface Props {
  track: Track
  // The title block lives here only in the artwork (viz-off) layout; in the
  // visualizer layout the title is shown centered with the artwork instead.
  showTitle: boolean
}

// Bottom overlay for the fullscreen "stage": title block (lower-left), a
// full-width seek bar, then a controls row with the transport centered and the
// volume pinned to the lower-right corner. Drag-to-seek and drag-volume reuse
// the same handlers the mini-player and the former Ambient/Studio views used.
export function PlayerStage({ track, showTitle }: Props) {
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const volume = usePlaybackStore(s => s.volume)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)
  const seek = useQueueStore(s => s.seek)
  const setVolume = useQueueStore(s => s.setVolume)

  const [dragProgress, setDragProgress] = useState<number | null>(null)

  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0
  const displayProgress = dragProgress ?? progress
  const displayPositionSec = dragProgress !== null ? dragProgress * durationSec : positionSec

  const onProgressMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const clamp = (clientX: number) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    setDragProgress(clamp(e.clientX))
    const onMove = (ev: globalThis.MouseEvent) => setDragProgress(clamp(ev.clientX))
    const onUp = (ev: globalThis.MouseEvent) => {
      void seek(clamp(ev.clientX) * durationSec)
      setDragProgress(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onVolumeMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const clamp = (clientX: number) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    void setVolume(clamp(e.clientX))
    const onMove = (ev: globalThis.MouseEvent) => void setVolume(clamp(ev.clientX))
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className="np-stage-overlay">
      {showTitle && (
        <div className="np-stage-meta">
          <h2>{track.t}</h2>
          <p>{track.artist} · {track.albumTitle}</p>
          <div className="pp-quality-chip">
            <CodecStrip track={track} compact />
          </div>
        </div>
      )}

      <div className="np-progress">
        <span className="time">{fmtTime(displayPositionSec)}</span>
        <div className="np-bar-track" onMouseDown={onProgressMouseDown} role="slider" tabIndex={0}>
          <div className="np-bar-fill" style={{ width: `${displayProgress * 100}%` }} />
        </div>
        <span className="time">-{fmtTime(Math.max(0, durationSec - displayPositionSec))}</span>
      </div>

      <div className="np-stage-controls">
        <div className="np-buttons">
          <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={22} /></button>
          <button className="play" style={{ width: 52, height: 52 }} onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={20} />
          </button>
          <button title="Next" onClick={() => { void next() }}><Icon name="next" size={22} /></button>
        </div>
        <div className="np-stage-volume pp-volume">
          <span className="ic"><Icon name={volume === 0 ? 'volumeM' : 'volume'} size={15} /></span>
          <div className="slider-wrap" style={{ '--pct': `${volume * 100}%` } as CSSProperties}>
            <div className="track" onMouseDown={onVolumeMouseDown} role="slider" tabIndex={0}>
              <div className="fill" style={{ width: `${volume * 100}%` }} />
            </div>
            <div className="dot" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  )
}
