import { type CSSProperties, Fragment, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { LyricsPanel } from './LyricsPanel'
import { EQBars } from './EQBars'
import { SpectrumVisualizer } from './SpectrumVisualizer'
import { UpNextToast } from './UpNextToast'
import { TrackLoadingOverlay } from './TrackLoadingOverlay'
import { fmtTime } from '@renderer/utils/format'
import {
  toggleTrackFavorite,
  useAlbumByUiId,
  useArtistByUiId,
} from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueHistory, useQueueStore, useQueueUpNext } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { extractDominantColor } from '@renderer/utils/colorExtract'
import type { AudioOutputDevice, ExclusiveModeState } from '@shared/types/ipc-contract'
import type { Album, Artist, Track } from '@shared/types/library'

interface PlayerPaneProps {
  isOpen: boolean
  onExpand: () => void
  onCollapse: () => void
  lyricsSidePaneOpen: boolean
  onToggleLyricsSidePane: () => void
  onOpenAlbum?: (album: Album) => void
  onOpenArtist?: (artist: Artist) => void
}

type PlayerTab = 'nowPlaying' | 'upNext'
type InertPanelProps = { inert?: '' }

const PLAYER_VISUALIZER_EXIT_MS = 260

const getInertPanelProps = (inactive: boolean): InertPanelProps =>
  inactive ? { inert: '' } : {}

export function PlayerPane({
  isOpen,
  onExpand,
  onCollapse,
  lyricsSidePaneOpen,
  onToggleLyricsSidePane,
  onOpenAlbum,
  onOpenArtist,
}: PlayerPaneProps) {
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const [lastTrack, setLastTrack] = useState<Track | null>(() => currentTrack)
  const track = currentTrack ?? lastTrack
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
  const isTrackTransitioning = useQueueStore(s => s.isTrackTransitioning)
  const album = useAlbumByUiId(track?.albumId)
  const artist = useArtistByUiId(track?.artistId)
  const [lastAlbum, setLastAlbum] = useState<Album | null>(null)
  const displayAlbum = album ?? (track?.albumId === lastAlbum?.id ? lastAlbum : undefined)
  const playerTintSource = useTweakStore(s => s.tweak.playerTintSource)
  const playerTintColor = useTweakStore(s => s.tweak.playerTintColor)
  const showVisualizer = useTweakStore(s => s.tweak.showPlayerVisualizer)
  const showLyrics = useTweakStore(s => s.tweak.showPlayerLyrics)
  const setTweak = useTweakStore(s => s.setTweak)
  const [visualizerVisible, setVisualizerVisible] = useState(() => showVisualizer)
  const [visualizerClosing, setVisualizerClosing] = useState(false)
  const artworkPath = track?.artworkPath ?? displayAlbum?.artworkPath ?? null
  const [artworkTint, setArtworkTint] = useState<string | null>(null)
  const [dragProgress, setDragProgress] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<PlayerTab>('nowPlaying')
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([])
  const [deviceLoading, setDeviceLoading] = useState(false)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [exclusiveState, setExclusiveState] = useState<ExclusiveModeState>({ enabled: false, deviceId: null })
  const [exclusiveBusy, setExclusiveBusy] = useState(false)
  const [exclusiveError, setExclusiveError] = useState<string | null>(null)
  const deviceMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (currentTrack) setLastTrack(currentTrack)
  }, [currentTrack])

  useEffect(() => {
    if (album) setLastAlbum(album)
  }, [album])

  useEffect(() => {
    if (showVisualizer) {
      setVisualizerVisible(true)
      setVisualizerClosing(false)
      return
    }

    if (!visualizerVisible) return

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setVisualizerVisible(false)
      setVisualizerClosing(false)
      return
    }

    setVisualizerClosing(true)
    const timeout = window.setTimeout(() => {
      setVisualizerVisible(false)
      setVisualizerClosing(false)
    }, PLAYER_VISUALIZER_EXIT_MS)

    return () => window.clearTimeout(timeout)
  }, [showVisualizer, visualizerVisible])

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
    if (!isOpen) {
      setDeviceMenuOpen(false)
      setActiveTab('nowPlaying')
    }
  }, [isOpen])

  useEffect(() => {
    if (playerTintSource !== 'artwork' || !artworkPath) {
      setArtworkTint(null)
      return
    }
    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(artworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled) setArtworkTint(hex)
    })
    return () => { cancelled = true }
  }, [playerTintSource, artworkPath])

  const tint =
    playerTintSource === 'artwork' ? artworkTint
    : playerTintSource === 'preset' || playerTintSource === 'custom' ? playerTintColor
    : null

  useEffect(() => {
    void window.api.audio.getExclusiveMode().then(setExclusiveState).catch(() => { /* main not ready */ })
    return window.api.audio.onExclusiveModeChanged(state => {
      setExclusiveState(state)
      setExclusiveBusy(false)
      setExclusiveError(state.reason && !state.enabled ? state.reason : null)
    })
  }, [])

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

  if (!track) return null

  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0
  const displayProgress = dragProgress ?? progress
  const displayPositionSec = dragProgress !== null ? dragProgress * durationSec : positionSec

  const onProgressMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (durationSec <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()

    const clamp = (clientX: number) =>
      Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))

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

    const clamp = (clientX: number) =>
      Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))

    void setVolume(clamp(e.clientX))

    const onMove = (ev: globalThis.MouseEvent) => void setVolume(clamp(ev.clientX))

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
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

  const canOpenAlbum = album != null && onOpenAlbum != null && !album.id.startsWith('a-unresolved-')
  const canOpenArtist = artist != null && onOpenArtist != null

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
        supportsExclusive: d.id === selected.id ? selected.supportsExclusive : d.supportsExclusive,
      })))
      setDeviceMenuOpen(false)
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Could not switch audio output')
    } finally {
      setDeviceLoading(false)
    }
  }

  const toggleExclusiveMode = async () => {
    if (exclusiveBusy) return
    setExclusiveBusy(true)
    setExclusiveError(null)
    try {
      const result = await window.api.audio.setExclusiveMode(!exclusiveState.enabled)
      setExclusiveState(result)
      if (!result.enabled && result.reason) setExclusiveError(result.reason)
    } catch (err) {
      setExclusiveError(err instanceof Error ? err.message : 'Could not toggle exclusive mode')
    } finally {
      setExclusiveBusy(false)
    }
  }

  return (
    <div
      className={`player-pane ${isOpen ? 'player-pane-open' : 'player-pane-collapsed'}`}
      aria-hidden={!isOpen}
      style={{ '--np-tint': tint ?? 'transparent' } as CSSProperties}
    >
      <div className="pp-header">
        <div className="pp-header-nav" role="tablist" aria-label="Player panel">
          <button
            type="button"
            className={`pp-header-tab ${activeTab === 'nowPlaying' ? 'active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'nowPlaying'}
            onClick={() => setActiveTab('nowPlaying')}
          >
            Now Playing
          </button>
          <span className="pp-header-separator" aria-hidden="true">|</span>
          <button
            type="button"
            className={`pp-header-tab ${activeTab === 'upNext' ? 'active' : ''}`}
            role="tab"
            aria-selected={activeTab === 'upNext'}
            onClick={() => setActiveTab('upNext')}
          >
            Up Next
          </button>
        </div>
        <div className="actions">
          <button className="tb-icon-btn pp-collapse-arrow" title="Collapse to bottom player" aria-label="Collapse to bottom player" onClick={onCollapse}>
            <Icon name="chevD" size={13} />
          </button>
          <button className="tb-icon-btn" title="Expand" onClick={onExpand}><Icon name="expand" size={13} /></button>
        </div>
      </div>

      <UpNextToast variant="side" enabled={isOpen && activeTab === 'nowPlaying'} />

      <div className="pp-tab-content">
        <div className="pp-tab-viewport">
          <div className={`pp-tab-slider ${activeTab === 'upNext' ? 'show-up-next' : 'show-now-playing'}`}>
            <div
              className={`pp-tab-panel ${activeTab === 'nowPlaying' ? 'active' : 'inactive'}`}
              role="tabpanel"
              aria-label="Now Playing"
              aria-hidden={activeTab !== 'nowPlaying'}
              {...getInertPanelProps(activeTab !== 'nowPlaying')}
            >
              <div className="pp-player">
                <div className="pp-player-top">
                  <div className="art" onClick={onExpand} role="button" tabIndex={0}>
                    <Artwork album={displayAlbum} radius={8} objectFit="contain" />
                    <TrackLoadingOverlay />
                  </div>

                  <div className="info">
                    <div className="title-row">
                      {canOpenAlbum ? (
                        <button
                          type="button"
                          className="t pp-link-title"
                          onClick={e => {
                            e.stopPropagation()
                            onOpenAlbum?.(album)
                          }}
                          title="Abrir álbum"
                        >
                          {track.t}
                        </button>
                      ) : (
                        <div className="t">{track.t}</div>
                      )}
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
                    <div className="a">
                      {canOpenArtist ? (
                        <button
                          type="button"
                          className="pp-link-meta a"
                          onClick={e => {
                            e.stopPropagation()
                            onOpenArtist?.(artist)
                          }}
                          title="Abrir artista"
                        >
                          {track.artist}
                        </button>
                      ) : (
                        track.artist
                      )}
                      {' · '}
                      {canOpenAlbum ? (
                        <button
                          type="button"
                          className="pp-link-meta a"
                          onClick={e => {
                            e.stopPropagation()
                            onOpenAlbum?.(album)
                          }}
                          title="Abrir álbum"
                        >
                          {track.albumTitle}
                        </button>
                      ) : (
                        track.albumTitle
                      )}
                    </div>
                    <div className="pp-quality-chip">
                      <CodecStrip track={track} compact />
                    </div>
                  </div>
                </div>

                <div className="pp-player-bottom">
                  <div className="pp-progress">
                    <div className="slider-wrap" style={{ '--pct': `${displayProgress * 100}%` } as CSSProperties}>
                      <div className="track" onMouseDown={onProgressMouseDown} role="slider" tabIndex={0}>
                        <div className="fill" style={{ width: `${displayProgress * 100}%` }} />
                      </div>
                      <div className="dot" aria-hidden="true" />
                    </div>
                    <div className="times">
                      <span>{fmtTime(displayPositionSec)}</span>
                      <span>-{fmtTime(Math.max(0, durationSec - displayPositionSec))}</span>
                    </div>
                  </div>

                  <div className="pp-controls">
                    <button className="sub" title="Shuffle"><Icon name="shuffle" size={15} /></button>
                    <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={20} /></button>
                    <button className="play" onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
                      <Icon name={playing ? 'pause' : 'play'} size={16} />
                    </button>
                    <button title="Next" disabled={isTrackTransitioning} onClick={() => { void next() }}><Icon name="next" size={20} /></button>
                    <button className="sub active" title="Repeat"><Icon name="repeat" size={15} /></button>
                  </div>

                  <div className="pp-volume">
                    <span className="ic"><Icon name={volume === 0 ? 'volumeM' : 'volume'} size={14} /></span>
                    <div className="slider-wrap" style={{ '--pct': `${volume * 100}%` } as CSSProperties}>
                      <div className="track" onMouseDown={onVolumeMouseDown} role="slider" tabIndex={0}>
                        <div className="fill" style={{ width: `${volume * 100}%` }} />
                      </div>
                      <div className="dot" aria-hidden="true" />
                    </div>
                    <div className="output-device-control" ref={deviceMenuRef}>
                      <button
                        className={`tb-icon-btn ${deviceMenuOpen ? 'active' : ''} ${exclusiveState.enabled ? 'exclusive-on' : ''}`}
                        title={exclusiveState.enabled ? 'Audio output (Exclusive mode)' : 'Audio output'}
                        aria-haspopup="menu"
                        aria-expanded={deviceMenuOpen}
                        onClick={onOutputButtonClick}
                      >
                        <Icon name="speaker" size={14} />
                      </button>
                      {deviceMenuOpen && (
                        <div className={`output-device-menu upward ${exclusiveBusy ? 'transitioning' : ''}`} role="menu">
                          <div className="output-device-title">Audio Output</div>
                          {deviceLoading && <div className="output-device-state">Loading outputs...</div>}
                          {deviceError && <div className="output-device-state error">{deviceError}</div>}
                          {!deviceLoading && !deviceError && outputDevices.length === 0 && (
                            <div className="output-device-state">No output devices found</div>
                          )}
                          {!deviceError && outputDevices.map(device => (
                            <Fragment key={device.id}>
                              <button
                                type="button"
                                className={`output-device-item ${device.isCurrent ? 'current' : ''}`}
                                disabled={deviceLoading || exclusiveBusy}
                                role="menuitemradio"
                                aria-checked={device.isCurrent}
                                onClick={() => { void selectOutputDevice(device) }}
                              >
                                <Icon name={device.isCurrent ? 'check' : 'speaker'} size={13} />
                                <span className="output-device-name">{device.name}</span>
                                {device.isCurrent && exclusiveState.enabled && (
                                  <span className="output-device-badge exclusive">Exclusive</span>
                                )}
                                {device.isDefault && !(device.isCurrent && exclusiveState.enabled) && (
                                  <span className="output-device-badge">Default</span>
                                )}
                              </button>
                              {device.isCurrent && (
                                <ExclusiveToggleRow
                                  enabled={exclusiveState.enabled}
                                  supported={device.supportsExclusive}
                                  busy={exclusiveBusy}
                                  error={exclusiveError}
                                  onToggle={toggleExclusiveMode}
                                />
                              )}
                            </Fragment>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className={`pp-player-viz${showVisualizer ? '' : ' collapsed'}${visualizerClosing ? ' closing' : ''}`}>
                    <button
                      type="button"
                      className="pp-player-viz-head"
                      onClick={() => setTweak('showPlayerVisualizer', !showVisualizer)}
                      aria-expanded={showVisualizer}
                      title={showVisualizer ? 'Hide visualizer' : 'Show visualizer'}
                    >
                      <span>Visualizer</span>
                      <Icon name={showVisualizer ? 'chevD' : 'chevR'} size={12} />
                    </button>
                    {visualizerVisible && (
                      <div className="pp-player-viz-body" aria-hidden={!showVisualizer}>
                        <div className="pp-player-viz-clip">
                          <SpectrumVisualizer
                            mode="mini"
                            active={isOpen && activeTab === 'nowPlaying' && showVisualizer}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className={`pp-player-lyrics${showLyrics ? '' : ' collapsed'}${lyricsSidePaneOpen ? ' side-open' : ''}`}>
                    <div className="pp-player-lyrics-head">
                      <button
                        type="button"
                        className="pp-player-lyrics-toggle"
                        onClick={() => setTweak('showPlayerLyrics', !showLyrics)}
                        aria-expanded={showLyrics}
                        title={showLyrics ? 'Hide lyrics' : 'Show lyrics'}
                      >
                        <span>Lyrics</span>
                        <Icon name={showLyrics ? 'chevD' : 'chevR'} size={12} />
                      </button>
                    </div>
                    {showLyrics && (
                      <button
                        type="button"
                        className="tb-icon-btn pp-lyrics-side-toggle"
                        title="Open lyrics sidebar"
                        aria-label="Open lyrics sidebar"
                        aria-pressed={lyricsSidePaneOpen}
                        onClick={onToggleLyricsSidePane}
                      >
                        <Icon name="sidebarRight" size={13} />
                      </button>
                    )}
                    {showLyrics && (
                      <div className="pp-lyrics-preview">
                        <LyricsPanel
                          variant="inline"
                          showActions={false}
                          showInlineHeader={false}
                          sidePaneOpen={lyricsSidePaneOpen}
                          onToggleSidePane={onToggleLyricsSidePane}
                          active={isOpen && activeTab === 'nowPlaying' && showLyrics && !lyricsSidePaneOpen}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div
              className={`pp-tab-panel ${activeTab === 'upNext' ? 'active' : 'inactive'}`}
              role="tabpanel"
              aria-label="Up Next"
              aria-hidden={activeTab !== 'upNext'}
              {...getInertPanelProps(activeTab !== 'upNext')}
            >
              <div className="pp-queue">
                <div className="queue-head">
                  <div className="queue-head-main">
                    <h3>Up Next</h3>
                    <div className="queue-remaining">{totalQueueRemainingText} remaining</div>
                  </div>
                </div>
                <div className="queue-list">
                  <div className="queue-section-label">Playing from · {displayAlbum?.title ?? '—'}</div>
                  <div className="queue-item now">
                    <div className="art"><Artwork album={displayAlbum} /></div>
                    <div>
                      <div className="t">{track.t}</div>
                      <div className="a">{track.artist}</div>
                    </div>
                    <EQBars
                      active={isOpen && activeTab === 'upNext'}
                      style={{ color: 'var(--text-primary)' }}
                    />
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
          </div>
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

interface ExclusiveToggleRowProps {
  enabled: boolean
  supported: boolean
  busy: boolean
  error: string | null
  onToggle: () => void
}

function ExclusiveToggleRow({ enabled, supported, busy, error, onToggle }: ExclusiveToggleRowProps) {
  const disabled = !supported || busy
  return (
    <div className="exclusive-toggle-row">
      <button
        type="button"
        className={`exclusive-toggle ${enabled ? 'on' : ''}`}
        disabled={disabled}
        aria-pressed={enabled}
        onClick={() => { if (!disabled) onToggle() }}
      >
        <div className="exclusive-toggle-text">
          <div className="exclusive-toggle-title">
            Exclusive Mode
            {busy && <span className="exclusive-toggle-spinner" aria-hidden="true" />}
          </div>
          <div className="exclusive-toggle-sub">
            {supported ? 'Bypass the macOS mixer' : 'Not supported on this device'}
          </div>
        </div>
        <span className={`exclusive-toggle-switch ${enabled ? 'on' : ''}`} aria-hidden="true">
          <span className="exclusive-toggle-knob" />
        </span>
      </button>
      {error && <div className="exclusive-toggle-error">{error}</div>}
    </div>
  )
}
