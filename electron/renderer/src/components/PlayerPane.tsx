import { useRef, useState, type PointerEvent } from 'react'
import type { Track } from '@shared/types/library'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { EQBars } from './EQBars'
import { fmtTime } from '@renderer/utils/format'
import { mockLibrary } from '@renderer/data/mockLibrary'

interface PlayerPaneProps {
  track: Track
  progress: number
  volume: number
  playing: boolean
  expanded: boolean
  onPlayPause: () => void
  onExpand: () => void
  onMini: () => void
}

export function PlayerPane({ track, progress, volume, playing, expanded, onPlayPause, onExpand, onMini }: PlayerPaneProps) {
  if (!track || expanded) return null

  const album = mockLibrary.albums.find(a => a.id === track.albumId)
  const np = mockLibrary.nowPlaying

  const containerRef = useRef<HTMLDivElement>(null)
  const [playerH, setPlayerH] = useState(450)
  const [dragging, setDragging] = useState(false)

  const onSplitterDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(true)
    const startY = e.clientY
    const startH = playerH

    const move = (ev: globalThis.PointerEvent) => {
      const next = startH + (ev.clientY - startY)
      const containerH = containerRef.current?.clientHeight || 800
      const min = 300
      const max = Math.max(min + 80, containerH - 140)
      setPlayerH(Math.max(min, Math.min(max, next)))
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="player-pane" ref={containerRef}>
      <div className="pp-header">
        <div className="label">Now Playing</div>
        <div className="actions">
          <button className="tb-icon-btn" title="Mini player" onClick={onMini}><Icon name="album" size={14} /></button>
          <button className="tb-icon-btn" title="Expand" onClick={onExpand}><Icon name="expand" size={13} /></button>
          <button className="tb-icon-btn" title="More"><Icon name="ellipsis" size={14} /></button>
        </div>
      </div>

      <div className="pp-top" style={{ height: playerH, flexBasis: playerH }}>
        <div className="art" onClick={onExpand} role="button" tabIndex={0}>
          <Artwork album={album} radius={8} />
        </div>

        <div className="info">
          <div className="title-row">
            <div className="t">{track.t}</div>
            <button className="tb-icon-btn" style={{ marginTop: -2 }} title="Love">
              <Icon name={track.loved ? 'heartF' : 'heart'} size={14} />
            </button>
          </div>
          <div className="a">{track.artist} · {track.albumTitle}</div>
          <CodecStrip track={track} />
        </div>

        <div className="pp-progress">
          <div className="track"><div className="fill" style={{ width: `${progress * 100}%` }} /></div>
          <div className="times">
            <span>{fmtTime(track.d * progress)}</span>
            <span>-{fmtTime(track.d * (1 - progress))}</span>
          </div>
        </div>

        <div className="pp-controls">
          <button className="sub" title="Shuffle"><Icon name="shuffle" size={15} /></button>
          <button title="Previous"><Icon name="prev" size={20} /></button>
          <button className="play" onClick={onPlayPause} title={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={16} />
          </button>
          <button title="Next"><Icon name="next" size={20} /></button>
          <button className="sub active" title="Repeat"><Icon name="repeat" size={15} /></button>
        </div>

        <div className="pp-volume">
          <span className="ic"><Icon name={volume === 0 ? 'volumeM' : 'volume'} size={14} /></span>
          <div className="track"><div className="fill" style={{ width: `${volume * 100}%` }} /></div>
          <button className="tb-icon-btn" title="Lyrics" onClick={onExpand}><Icon name="lyric" size={14} /></button>
          <button className="tb-icon-btn" title="AirPlay"><Icon name="airplay" size={14} /></button>
        </div>
      </div>

      <div
        className={`pp-splitter ${dragging ? 'dragging' : ''}`}
        onPointerDown={onSplitterDown}
        role="separator"
        aria-orientation="horizontal"
      >
        <i className="pp-handle" />
      </div>

      <div className="pp-queue">
        <div className="queue-head">
          <h3>Up Next</h3>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn ghost sm">Clear</button>
          </div>
        </div>

        <div className="queue-list">
          <div className="queue-section-label">Playing from · {album?.title}</div>
          <div className="queue-item now">
            <div className="art"><Artwork album={album} /></div>
            <div>
              <div className="t">{track.t}</div>
              <div className="a">{track.artist}</div>
            </div>
            <EQBars style={{ color: 'var(--text-primary)' }} />
          </div>
          {np.queue.map(t => (
            <div key={t.id} className="queue-item">
              <div className="art"><Artwork album={mockLibrary.albums.find(a => a.id === t.albumId)} /></div>
              <div>
                <div className="t">{t.t}</div>
                <div className="a">{t.artist}</div>
              </div>
              <span className="dur">{fmtTime(t.d)}</span>
            </div>
          ))}

          <div className="queue-section-label">History</div>
          {np.history.map(t => (
            <div key={t.id} className="queue-item" style={{ opacity: 0.55 }}>
              <div className="art"><Artwork album={mockLibrary.albums.find(a => a.id === t.albumId)} /></div>
              <div>
                <div className="t">{t.t}</div>
                <div className="a">{t.artist}</div>
              </div>
              <span className="dur">{fmtTime(t.d)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
