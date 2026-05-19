import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { EQBars } from './EQBars'
import { LyricsPanel } from './LyricsPanel'
import { fmtTime } from '@renderer/utils/format'
import { toggleTrackFavorite, useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueHistory, useQueueStore, useQueueUpNext } from '@renderer/stores/queueStore'
import { useLyrics, useLyricsStore } from '@renderer/stores/lyricsStore'
import type { AudioOutputDevice } from '@shared/types/ipc-contract'
import type { Track } from '@shared/types/library'

interface PlayerPaneProps {
  expanded: boolean
  onExpand: () => void
  onMini: () => void
}

type PlayerTab = 'player' | 'upnext'

export function PlayerPane({ expanded, onExpand, onMini }: PlayerPaneProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const volume = usePlaybackStore(s => s.volume)
  const queueNext = useQueueUpNext()
  const queueHistory = useQueueHistory()
  const lyricsEntry = useLyrics(track?.dbId)
  const fetchLyrics = useLyricsStore(s => s.fetch)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const seek = useQueueStore(s => s.seek)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)
  const setVolume = useQueueStore(s => s.setVolume)
  const album = useAlbumByUiId(track?.albumId)
  const [activeTab, setActiveTab] = useState<PlayerTab>('player')
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([])
  const [deviceLoading, setDeviceLoading] = useState(false)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const deviceMenuRef = useRef<HTMLDivElement>(null)
  const showLyricsPanel = track?.dbId != null && lyricsEntry.status !== 'idle'

  const totalQueueRemainingSec =
    Math.max(0, durationSec - positionSec) + queueNext.reduce((sum, item) => sum + item.d, 0)
  const totalQueueRemainingText = useMemo(() => {
    const total = Math.max(0, Math.floor(totalQueueRemainingSec))
    const hh = Math.floor(total / 3600)
    const mm = Math.floor((total % 3600) / 60)
    const ss = total % 60
    if (hh > 0) return `${hh}:${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
    return `${mm}:${ss.toString().padStart(2, '0')}`
  }, [totalQueueRemainingSec])

  useEffect(() => {
    if (track?.dbId == null) return
    void fetchLyrics(track.dbId)
  }, [track?.dbId, fetchLyrics])

  useEffect(() => {
    if (!deviceMenuOpen) return

    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !deviceMenuRef.current?.contains(target)) {
        setDeviceMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDeviceMenuOpen(false)
    }

    window.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [deviceMenuOpen])

  if (!track || expanded) return null

  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0

  const onProgressClick = (e: MouseEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    void seek(ratio * durationSec)
  }

  const onVolumeClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    void setVolume(ratio)
  }

  const loadOutputDevices = async () => {
    setDeviceLoading(true)
    setDeviceError(null)
    try {
      setOutputDevices(await window.api.audio.listOutputDevices())
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Could not load audio outputs')
    } finally {
      setDeviceLoading(false)
    }
  }

  const onOutputButtonClick = () => {
    setDeviceMenuOpen(open => {
      const nextOpen = !open
      if (nextOpen) void loadOutputDevices()
      return nextOpen
    })
  }

  const selectOutputDevice = async (device: AudioOutputDevice) => {
    if (device.isCurrent) {
      setDeviceMenuOpen(false)
      return
    }

    setDeviceLoading(true)
    setDeviceError(null)
    try {
      const selected = await window.api.audio.setOutputDevice(device.id)
      setOutputDevices(devices => devices.map(d => ({
        ...d,
        isCurrent: d.id === selected.id,
        isInitialized: d.id === selected.id ? selected.isInitialized : d.isInitialized,
      })))
      setDeviceMenuOpen(false)
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Could not switch audio output')
    } finally {
      setDeviceLoading(false)
    }
  }

  return (
    <div className="player-pane">
      <div className="pp-header">
        <div className="pp-header-nav" role="tablist" aria-label="Player pane">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'player'}
            className={`pp-header-tab ${activeTab === 'player' ? 'active' : ''}`}
            onClick={() => setActiveTab('player')}
          >
            Now Playing
          </button>
          <span className="pp-header-separator" aria-hidden="true">|</span>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'upnext'}
            className={`pp-header-tab ${activeTab === 'upnext' ? 'active' : ''}`}
            onClick={() => setActiveTab('upnext')}
          >
            Up Next
          </button>
        </div>
        <div className="actions">
          <button className="tb-icon-btn" title="Mini player" onClick={onMini}><Icon name="album" size={14} /></button>
          <button className="tb-icon-btn" title="Expand" onClick={onExpand}><Icon name="expand" size={13} /></button>
          <div className="output-device-control" ref={deviceMenuRef}>
            <button
              className={`tb-icon-btn ${deviceMenuOpen ? 'active' : ''}`}
              title="Audio output"
              aria-haspopup="menu"
              aria-expanded={deviceMenuOpen}
              onClick={onOutputButtonClick}
            >
              <Icon name="speaker" size={14} />
            </button>
            {deviceMenuOpen && (
              <div className="output-device-menu" role="menu">
                <div className="output-device-title">Audio Output</div>
                {deviceLoading && <div className="output-device-state">Loading outputs...</div>}
                {deviceError && <div className="output-device-state error">{deviceError}</div>}
                {!deviceLoading && !deviceError && outputDevices.length === 0 && (
                  <div className="output-device-state">No output devices found</div>
                )}
                {!deviceError && outputDevices.map(device => (
                  <button
                    key={device.id}
                    type="button"
                    className={`output-device-item ${device.isCurrent ? 'current' : ''}`}
                    disabled={deviceLoading}
                    role="menuitemradio"
                    aria-checked={device.isCurrent}
                    onClick={() => { void selectOutputDevice(device) }}
                  >
                    <Icon name={device.isCurrent ? 'check' : 'speaker'} size={13} />
                    <span className="output-device-name">{device.name}</span>
                    {device.isDefault && <span className="output-device-badge">Default</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="pp-tab-content">
        {activeTab === 'player' ? (
          <div className="pp-player">
            <div className="pp-player-top">
              <div className="art" onClick={onExpand} role="button" tabIndex={0}>
                <Artwork album={album} radius={8} objectFit="contain" />
              </div>

              <div className="info">
                  <div className="title-row">
                  <div className="t">{track.t}</div>
                  <button
                    className="tb-icon-btn"
                    style={{ marginTop: -2 }}
                    title={track.loved ? 'Remove from favorites' : 'Mark as favorite'}
                    onClick={() => {
                      if (track.dbId == null) return
                      void toggleTrackFavorite(track.dbId, !track.loved)
                    }}
                  >
                    <Icon name={track.loved ? 'heartF' : 'heart'} size={14} />
                  </button>
                </div>
                <div className="a">{track.artist} · {track.albumTitle}</div>
                <div className="pp-quality-chip">
                  <CodecStrip track={track} compact />
                </div>
              </div>
            </div>

            <div className="pp-player-bottom">
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
                <button className="tb-icon-btn" title="AirPlay"><Icon name="airplay" size={14} /></button>
              </div>
              {showLyricsPanel && (
                <div className="pp-player-lyrics player-lyrics">
                  <div className="player-lyrics-head">
                    <span>Lyrics</span>
                  </div>
                  <LyricsPanel track={track} variant="sidebar" />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="pp-queue">
            <div className="queue-head">
              <div className="queue-head-main">
                <h3>Up Next</h3>
                <div className="queue-remaining">
                  {`Ends in ${totalQueueRemainingText} (including now playing)`}
                </div>
              </div>
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
        )}
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
