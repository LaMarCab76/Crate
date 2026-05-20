import { type MouseEvent, useState } from 'react'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { fmtTime } from '@renderer/utils/format'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import type { Album, Track } from '@shared/types/library'

interface Props {
  track: Track
  album: Album | undefined
  onToggleMode: () => void
}

// "Ambient" fullscreen layout: full-bleed artwork with a minimal bottom overlay.
// The quality readout reuses the mini-player's <CodecStrip compact /> verbatim,
// placed directly below the artist · album line (replacing the mockup's
// top-right badge) per the requested design.
export function AmbientView({ track, album, onToggleMode }: Props) {
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)
  const seek = useQueueStore(s => s.seek)

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

  return (
    <div className="ambient-view">
      <div className="ambient-art"><Artwork album={album} radius={0} objectFit="cover" /></div>
      <div className="ambient-scrim" aria-hidden="true" />

      <button className="mode-pill ambient-mode" onClick={onToggleMode} title="Cambiar a vista Studio">
        <Icon name="album" size={12} /> AMBIENT
      </button>

      <div className="ambient-overlay">
        <div className="ambient-meta">
          <h2>{track.t}</h2>
          <p>{track.artist} · {track.albumTitle}</p>
          <div className="pp-quality-chip">
            <CodecStrip track={track} compact />
          </div>
        </div>

        <div className="ambient-progress np-progress">
          <span className="time">{fmtTime(displayPositionSec)}</span>
          <div className="np-bar-track" onMouseDown={onProgressMouseDown} role="slider" tabIndex={0}>
            <div className="np-bar-fill" style={{ width: `${displayProgress * 100}%` }} />
          </div>
          <span className="time">-{fmtTime(Math.max(0, durationSec - displayPositionSec))}</span>
        </div>

        <div className="ambient-buttons np-buttons">
          <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={22} /></button>
          <button className="play" style={{ width: 52, height: 52 }} onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={20} />
          </button>
          <button title="Next" onClick={() => { void next() }}><Icon name="next" size={22} /></button>
        </div>
      </div>
    </div>
  )
}
