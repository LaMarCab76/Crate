import { useRef, useState, type PointerEvent } from 'react'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { EQBars } from './EQBars'
import { fmtTime } from '@renderer/utils/format'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueHistory, useQueueStore, useQueueUpNext } from '@renderer/stores/queueStore'
import type { Track } from '@shared/types/library'

interface PlayerPaneProps {
  expanded: boolean
  onExpand: () => void
  onMini: () => void
}

export function PlayerPane({ expanded, onExpand, onMini }: PlayerPaneProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const volume = usePlaybackStore(s => s.volume)
  const queueNext = useQueueUpNext()
  const queueHistory = useQueueHistory()
  const togglePlay = useQueueStore(s => s.togglePlay)
  const seek = useQueueStore(s => s.seek)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)
  const setVolume = useQueueStore(s => s.setVolume)
  const album = useAlbumByUiId(track?.albumId)

  const containerRef = useRef<HTMLDivElement>(null)
  const [playerH, setPlayerH] = useState(450)
  const [dragging, setDragging] = useState(false)

  if (!track || expanded) return null

  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0

  const onSplitterDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(true)
    const startY = e.clientY
    const startH = playerH

    const move = (ev: globalThis.PointerEvent) => {
      const nextHeight = startH + (ev.clientY - startY)
      const containerH = containerRef.current?.clientHeight || 800
      const min = 300
      const max = Math.max(min + 80, containerH - 140)
      setPlayerH(Math.max(min, Math.min(max, nextHeight)))
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    void seek(ratio * durationSec)
  }

  const onVolumeClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    void setVolume(ratio)
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
          <div className="track" onClick={onProgressClick} role="slider" tabIndex={0}>
            <div className="fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="times">
            <span>{fmtTime(positionSec)}</span>
            <span>-{fmtTime(Math.max(0, durationSec - positionSec))}</span>
          </div>
        </div>

        <div className="pp-controls">
          <button className="sub" title="Shuffle"><Icon name="shuffle" size={15} /></button>
          <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={20} /></button>
          <button className="play" onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={16} />
          </button>
          <button title="Next" onClick={() => { void next() }}><Icon name="next" size={20} /></button>
          <button className="sub active" title="Repeat"><Icon name="repeat" size={15} /></button>
        </div>

        <div className="pp-volume">
          <span className="ic"><Icon name={volume === 0 ? 'volumeM' : 'volume'} size={14} /></span>
          <div className="track" onClick={onVolumeClick} role="slider" tabIndex={0}>
            <div className="fill" style={{ width: `${volume * 100}%` }} />
          </div>
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
            <button className="btn ghost sm" onClick={() => useQueueStore.getState().clear()}>Clear</button>
          </div>
        </div>

        <div className="queue-list">
          <div className="queue-section-label">Playing from · {album?.title ?? '—'}</div>
          <div className="queue-item now">
            <div className="art"><Artwork album={album} /></div>
            <div>
              <div className="t">{track.t}</div>
              <div className="a">{track.artist}</div>
            </div>
            <EQBars style={{ color: 'var(--text-primary)' }} />
          </div>
          {queueNext.length === 0 && queueHistory.length === 0 && (
            <div className="queue-section-label" style={{ color: 'var(--text-tertiary)' }}>
              Queue is empty
            </div>
          )}
          {queueNext.map(t => <QueueItem key={t.id} track={t} />)}
          {queueHistory.length > 0 && <div className="queue-section-label">History</div>}
          {queueHistory.slice().reverse().map(t => <QueueItem key={`h-${t.id}`} track={t} dim />)}
        </div>
      </div>
    </div>
  )
}

function QueueItem({ track, dim }: { track: Track; dim?: boolean }) {
  const album = useAlbumByUiId(track.albumId)
  return (
    <div className="queue-item" style={dim ? { opacity: 0.55 } : undefined}>
      <div className="art"><Artwork album={album} /></div>
      <div>
        <div className="t">{track.t}</div>
        <div className="a">{track.artist}</div>
      </div>
      <span className="dur">{fmtTime(track.d)}</span>
    </div>
  )
}
