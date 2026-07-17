import { type CSSProperties, Fragment, type MouseEvent, useEffect, useRef, useState } from 'react'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { TrackLoadingOverlay } from './TrackLoadingOverlay'
import { formatPlaybackTimePair, splitArtist, titleWithFeatured } from '@renderer/utils/format'
import {
  toggleTrackFavorite,
  useAlbumByUiId,
  useArtistByUiId,
} from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { extractDominantColor } from '@renderer/utils/colorExtract'
import { vivify } from '@renderer/utils/colorAdjust'
import type { AudioOutputDevice, ExclusiveModeState } from '@shared/types/ipc-contract'
import type { Album, Artist, Track } from '@shared/types/library'

interface PlayerBottomBarProps {
  closing?: boolean
  onExpand: () => void
  onShowPanel: () => void
  lyricsSidePaneOpen: boolean
  onToggleLyricsSidePane: () => void
  onOpenAlbum?: (album: Album) => void
  onOpenArtist?: (artist: Artist) => void
}

export function PlayerBottomBar({
  closing = false,
  onExpand,
  onShowPanel,
  lyricsSidePaneOpen,
  onToggleLyricsSidePane,
  onOpenAlbum,
  onOpenArtist,
}: PlayerBottomBarProps) {
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const [lastTrack, setLastTrack] = useState<Track | null>(() => currentTrack)
  const track = currentTrack ?? lastTrack
  const status = usePlaybackStore(s => s.status)
  const streamSource = usePlaybackStore(s => s.streamSource)
  const streamSourceState = usePlaybackStore(s => s.streamSourceState)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const volume = usePlaybackStore(s => s.volume)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const seek = useQueueStore(s => s.seek)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)
  const setVolume = useQueueStore(s => s.setVolume)
  const isTrackTransitioning = useQueueStore(s => s.isTrackTransitioning)
  const shuffle = useQueueStore(s => s.shuffle)
  const repeat = useQueueStore(s => s.repeat)
  const toggleShuffle = useQueueStore(s => s.toggleShuffle)
  const setRepeat = useQueueStore(s => s.setRepeat)
  const album = useAlbumByUiId(track?.albumId)
  const artist = useArtistByUiId(track?.artistId)
  const [lastAlbum, setLastAlbum] = useState<Album | null>(null)
  const displayAlbum = album ?? (track?.albumId === lastAlbum?.id ? lastAlbum : undefined)
  const playerTintSource = useTweakStore(s => s.tweak.playerTintSource)
  const playerTintColor = useTweakStore(s => s.tweak.playerTintColor)
  const artworkPath = track?.artworkPath ?? displayAlbum?.artworkPath ?? null
  const [artworkTint, setArtworkTint] = useState<string | null>(null)
  const [dragProgress, setDragProgress] = useState<number | null>(null)
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
    if (playerTintSource !== 'artwork' || !artworkPath) {
      setArtworkTint(null)
      return
    }
    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(artworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled) setArtworkTint(vivify(hex))
    })
    return () => { cancelled = true }
  }, [playerTintSource, artworkPath])

  useEffect(() => {
    void window.api.audio.getExclusiveMode().then(state => {
      setExclusiveState(state)
      setExclusiveError(state.reason && !state.enabled ? state.reason : null)
    }).catch(() => { /* main not ready */ })
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

  const { primary: artistPrimary, featured: artistFeatured } = splitArtist(track.artist)
  const barTitle = titleWithFeatured(track.t, artistFeatured)
  const tint =
    playerTintSource === 'artwork' ? artworkTint
    : playerTintSource === 'preset' || playerTintSource === 'custom' ? playerTintColor
    : null
  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0
  const displayProgress = dragProgress ?? progress
  const displayPositionSec = dragProgress !== null ? dragProgress * durationSec : positionSec
  const displayTimes = formatPlaybackTimePair(displayPositionSec, durationSec)
  const canOpenAlbum = album != null && onOpenAlbum != null && !album.id.startsWith('a-unresolved-')
  const canOpenArtist = artist != null && onOpenArtist != null
  const showFallbackBadge = streamSource === 'file' && streamSourceState === 'promoting'

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

  const cycleRepeat = () => {
    setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')
  }

  return (
    <div
      className={`player-bottom-shell ${closing ? 'closing' : ''}`}
      style={{ '--np-tint': tint ?? 'transparent' } as CSSProperties}
    >
      <div
        className="pb-top-progress"
        style={{ '--pct': `${displayProgress * 100}%` } as CSSProperties}
      >
        <div
          className="track"
          onMouseDown={onProgressMouseDown}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            void seek(Math.max(0, Math.min(durationSec, positionSec + (event.key === 'ArrowRight' ? 5 : -5))))
          }}
          role="slider"
          tabIndex={0}
          aria-label="Posición de reproducción"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, durationSec)}
          aria-valuenow={Math.max(0, displayPositionSec)}
          aria-valuetext={displayTimes.elapsedText}
        >
          <div className="fill" style={{ width: `${displayProgress * 100}%` }} />
        </div>
        <div className="pb-progress-times" aria-hidden="true">
          <span>{displayTimes.elapsedText}</span>
          <span>-{displayTimes.remainingText}</span>
        </div>
      </div>

      <div className="player-bottom-bar">
        <div className="pb-now">
          <button type="button" className="pb-art" onClick={onExpand} title="Expand player">
            <Artwork album={displayAlbum} radius={7} objectFit="cover" />
            <TrackLoadingOverlay />
          </button>
          <div className="pb-meta">
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
                {barTitle}
              </button>
            ) : (
              <div className="t">{barTitle}</div>
            )}
            <div className="pb-meta-line">
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
                    {artistPrimary}
                  </button>
                ) : (
                  artistPrimary
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
              <button
                className="pb-like-btn"
                title={track.loved ? 'Remove from favorites' : 'Mark as favorite'}
                onClick={() => {
                  if (track.dbId == null) return
                  void toggleTrackFavorite(track.dbId, !track.loved)
                }}
              >
                <Icon name={track.loved ? 'heartF' : 'heart'} size={18} />
              </button>
            </div>
            <div className="pp-quality-chip">
              <CodecStrip track={track} compact />
            </div>
            {showFallbackBadge && (
              <div className="stream-source-badge is-file" title="Streaming progresivo fallido; usando archivo">
                Reanudando por archivo
              </div>
            )}
          </div>
        </div>

        <div className="pb-center">
          <div className="pb-controls">
            <button
              className={`sub ${shuffle ? 'active' : ''}`}
              title="Shuffle"
              onClick={() => toggleShuffle()}
            >
              <Icon name="shuffle" size={14} />
            </button>
            <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={18} /></button>
            <button className="play" onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
              <Icon name={playing ? 'pause' : 'play'} size={15} />
            </button>
            <button title="Next" disabled={isTrackTransitioning} onClick={() => { void next() }}><Icon name="next" size={18} /></button>
            <button
              className={`sub ${repeat !== 'off' ? 'active' : ''}`}
              title={repeat === 'one' ? 'Repeat One' : repeat === 'all' ? 'Repeat All' : 'Repeat'}
              onClick={cycleRepeat}
            >
              <Icon name="repeat" size={14} />
            </button>
          </div>

        </div>

        <div className="pb-right">
          <div className="pb-volume">
            <span className="ic"><Icon name={volume === 0 ? 'volumeM' : 'volume'} size={14} /></span>
            <div className="slider-wrap" style={{ '--pct': `${volume * 100}%` } as CSSProperties}>
              <div
                className="track"
                onMouseDown={onVolumeMouseDown}
                onKeyDown={event => {
                  if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(event.key)) return
                  event.preventDefault()
                  const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 0.05 : -0.05
                  void setVolume(Math.max(0, Math.min(1, volume + direction)))
                }}
                role="slider"
                tabIndex={0}
                aria-label="Volumen"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(volume * 100)}
                aria-valuetext={`${Math.round(volume * 100)}%`}
              >
                <div className="fill" style={{ width: `${volume * 100}%` }} />
              </div>
              <div className="dot" aria-hidden="true" />
            </div>
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
          <button
            className={`tb-icon-btn pb-lyrics-side-btn ${lyricsSidePaneOpen ? 'active' : ''}`}
            title={lyricsSidePaneOpen ? 'Close lyrics sidebar' : 'Open lyrics sidebar'}
            aria-label={lyricsSidePaneOpen ? 'Close lyrics sidebar' : 'Open lyrics sidebar'}
            aria-pressed={lyricsSidePaneOpen}
            onClick={onToggleLyricsSidePane}
          >
            <Icon name="sidebarRight" size={13} />
          </button>
          <button className="tb-icon-btn" title="Expand" onClick={onExpand}>
            <Icon name="expand" size={13} />
          </button>
          <button className="tb-icon-btn pb-lift-btn" title="Show Player Panel" aria-label="Show Player Panel" onClick={onShowPanel}>
            <Icon name="chevU" size={15} />
          </button>
        </div>
      </div>
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
