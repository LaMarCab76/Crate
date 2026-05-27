import { type CSSProperties, type MouseEvent, useState } from 'react'
import { Icon } from './Icon'
import { fmtTime } from '@renderer/utils/format'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'

// Bottom overlay for the fullscreen stage: full-width seek bar, centered
// transport, and volume pinned to the lower-right corner. Drag-to-seek and
// drag-volume reuse the mini-player handlers.
export function PlayerStage() {
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const volume = usePlaybackStore(s => s.volume)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)
  const seek = useQueueStore(s => s.seek)
  const setVolume = useQueueStore(s => s.setVolume)
  const isTrackTransitioning = useQueueStore(s => s.isTrackTransitioning)
  const shuffle = useQueueStore(s => s.shuffle)
  const repeat = useQueueStore(s => s.repeat)
  const toggleShuffle = useQueueStore(s => s.toggleShuffle)
  const setRepeat = useQueueStore(s => s.setRepeat)

  const [dragProgress, setDragProgress] = useState<number | null>(null)

  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0
  const displayProgress = dragProgress ?? progress
  const displayPositionSec = dragProgress !== null ? dragProgress * durationSec : positionSec
  const cycleRepeat = () => {
    setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')
  }

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
      <div className="np-stage-controls">
        <div className="np-buttons">
          <button
            className={`sub ${shuffle ? 'active' : ''}`}
            title="Shuffle"
            aria-pressed={shuffle}
            onClick={() => toggleShuffle()}
          >
            <Icon name="shuffle" size={16} />
          </button>
          <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={20} /></button>
          <button className="play" onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={20} />
          </button>
          <button title="Next" disabled={isTrackTransitioning} onClick={() => { void next() }}><Icon name="next" size={20} /></button>
          <button
            className={`sub ${repeat !== 'off' ? 'active' : ''}`}
            title={repeat === 'one' ? 'Repeat One' : repeat === 'all' ? 'Repeat All' : 'Repeat'}
            aria-pressed={repeat !== 'off'}
            onClick={cycleRepeat}
          >
            <Icon name="repeat" size={16} />
          </button>
        </div>
      </div>

      <div className="np-progress">
        <span className="time">{fmtTime(displayPositionSec)}</span>
        <div className="np-bar-track" onMouseDown={onProgressMouseDown} role="slider" tabIndex={0}>
          <div className="np-bar-fill" style={{ width: `${displayProgress * 100}%` }} />
        </div>
        <span className="time">-{fmtTime(Math.max(0, durationSec - displayPositionSec))}</span>
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
  )
}
