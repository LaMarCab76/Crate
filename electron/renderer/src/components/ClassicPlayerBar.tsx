import { type CSSProperties, Fragment, type MouseEvent, type PointerEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { TrackLoadingOverlay } from './TrackLoadingOverlay'
import { OutputPathRow } from './OutputPathRow'
import { formatPlaybackTimePair, splitArtist, titleWithFeatured } from '@renderer/utils/format'
import {
  toggleTrackFavorite,
  useAlbumByUiId,
  useArtistByUiId,
} from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import type { AudioOutputDevice, ExclusiveModeState } from '@shared/types/ipc-contract'
import type { Album, Artist, Track } from '@shared/types/library'

export interface ClassicPlayerBarProps {
  viewKey?: unknown
  onOpenTrackMenu: (event: MouseEvent<HTMLElement>, track: Track) => void
  closing?: boolean
  onExpand: () => void
  onShowPanel: () => void
  lyricsSidePaneOpen: boolean
  onToggleLyricsSidePane: () => void
  onOpenAlbum?: (album: Album) => void
  onOpenArtist?: (artist: Artist) => void
}

// Docked transport from the previous design, backed by the current queue and audio engine.
export function ClassicPlayerBar({
  viewKey,
  onOpenTrackMenu,
  closing = false,
  onExpand,
  onShowPanel,
  lyricsSidePaneOpen,
  onToggleLyricsSidePane,
  onOpenAlbum,
  onOpenArtist,
}: ClassicPlayerBarProps) {
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
  const [dragProgress, setDragProgress] = useState<number | null>(null)
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([])
  const [deviceLoading, setDeviceLoading] = useState(false)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [exclusiveState, setExclusiveState] = useState<ExclusiveModeState>({ enabled: false, deviceId: null })
  const [exclusiveBusy, setExclusiveBusy] = useState(false)
  const [exclusiveError, setExclusiveError] = useState<string | null>(null)
  const deviceMenuRef = useRef<HTMLDivElement>(null)
  const deviceButtonRef = useRef<HTMLButtonElement>(null)
  const focusOutputMenuRef = useRef(false)
  const dragTrackRef = useRef<string | null>(null)

  useEffect(() => {
    setDeviceMenuOpen(false)
    setDragProgress(null)
  }, [viewKey, closing, currentTrack?.id])

  useEffect(() => {
    if (currentTrack) setLastTrack(currentTrack)
  }, [currentTrack])

  useEffect(() => {
    if (album) setLastAlbum(album)
  }, [album])

  useEffect(() => {
    let active = true
    void window.api.audio.getExclusiveMode().then(state => {
      if (!active) return
      setExclusiveState(state)
      setExclusiveError(state.reason && !state.enabled ? state.reason : null)
    }).catch(() => { /* main not ready */ })
    const unsubscribe = window.api.audio.onExclusiveModeChanged(state => {
      setExclusiveState(state)
      setExclusiveBusy(false)
      setExclusiveError(state.reason && !state.enabled ? state.reason : null)
    })
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => {
    if (!deviceMenuOpen) return

    const closeOnOutside = (event: globalThis.PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !deviceMenuRef.current?.contains(target)) {
        setDeviceMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setDeviceMenuOpen(false)
      deviceButtonRef.current?.focus({ preventScroll: true })
    }

    window.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [deviceMenuOpen])

  useEffect(() => {
    if (!deviceMenuOpen || deviceLoading || !focusOutputMenuRef.current) return
    const firstItem = deviceMenuRef.current?.querySelector<HTMLButtonElement>('.output-device-menu button:not(:disabled)')
    if (firstItem) {
      firstItem.focus({ preventScroll: true })
      focusOutputMenuRef.current = false
    }
  }, [deviceMenuOpen, deviceLoading, outputDevices])

  if (!track) return null

  const { primary: artistPrimary, featured: artistFeatured } = splitArtist(track.artist)
  const barTitle = titleWithFeatured(track.t, artistFeatured)
  const playing = status === 'playing'
  const progress = durationSec > 0 ? Math.max(0, Math.min(1, positionSec / durationSec)) : 0
  const displayProgress = dragProgress ?? progress
  const displayPositionSec = dragProgress !== null ? dragProgress * durationSec : positionSec
  const displayTimes = formatPlaybackTimePair(displayPositionSec, durationSec)
  const canOpenAlbum = album != null && onOpenAlbum != null && !album.id.startsWith('a-unresolved-')
  const canOpenArtist = artist != null && onOpenArtist != null
  const showFallbackBadge = streamSource === 'file' && streamSourceState === 'promoting'

  const pointerFraction = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return bounds.width > 0 ? Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) : 0
  }

  const onProgressPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || durationSec <= 0 || closing) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragTrackRef.current = track.id
    setDragProgress(pointerFraction(event))
  }

  const onProgressPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!closing && event.currentTarget.hasPointerCapture(event.pointerId)) setDragProgress(pointerFraction(event))
  }

  const onProgressPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (!closing && dragTrackRef.current === usePlaybackStore.getState().currentTrack?.id) {
      void seek(pointerFraction(event) * durationSec)
    }
    setDragProgress(null)
  }

  const onVolumePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || closing) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    void setVolume(pointerFraction(event))
  }

  const onVolumePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!closing && event.currentTarget.hasPointerCapture(event.pointerId)) void setVolume(pointerFraction(event))
  }

  const onVolumePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (!closing) void setVolume(pointerFraction(event))
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

  const onOutputButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    const nextOpen = !deviceMenuOpen
    focusOutputMenuRef.current = nextOpen && event.detail === 0
    setDeviceMenuOpen(nextOpen)
    if (nextOpen) void loadOutputDevices()
  }

  const onOutputMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    if (buttons.length === 0) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    buttons[index]?.focus({ preventScroll: true })
  }

  const selectOutputDevice = async (device: AudioOutputDevice) => {
    if (device.isCurrent) {
      setDeviceMenuOpen(false)
      deviceButtonRef.current?.focus({ preventScroll: true })
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
      deviceButtonRef.current?.focus({ preventScroll: true })
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
    <div className={`player-bottom-shell ${closing ? 'closing' : ''}`}>
      <div className="pane-bg-canvas" aria-hidden="true">
        <div className="np-bg-blob np-bg-blob-a" />
        <div className="np-bg-blob np-bg-blob-b" />
        <div className="np-bg-blob np-bg-blob-c" />
        <div className="np-bg-blob np-bg-blob-d" />
      </div>
      <div className="pane-bg-scrim" aria-hidden="true" />

      <div
        className="pb-top-progress"
        style={{ '--pct': `${displayProgress * 100}%` } as CSSProperties}
      >
        <div
          className="track"
          onPointerDown={onProgressPointerDown}
          onPointerMove={onProgressPointerMove}
          onPointerUp={onProgressPointerUp}
          onPointerCancel={() => setDragProgress(null)}
          onLostPointerCapture={() => setDragProgress(null)}
          onKeyDown={event => {
            if (closing || durationSec <= 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const target = event.key === 'Home' ? 0 : event.key === 'End' ? durationSec : positionSec + (event.key === 'ArrowRight' ? 5 : -5)
            void seek(Math.max(0, Math.min(durationSec, target)))
          }}
          role="slider"
          tabIndex={closing ? -1 : 0}
          aria-label="Posición de reproducción"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, durationSec)}
          aria-valuenow={Math.max(0, Math.min(durationSec, displayPositionSec))}
          aria-disabled={durationSec <= 0 || closing}
          style={{ touchAction: 'none' }}
          aria-valuetext={displayTimes.elapsedText}
        >
          <div className="fill" style={{ width: `${displayProgress * 100}%` }} />
        </div>
        <div className="pb-progress-times" aria-hidden="true">
          <span>{displayTimes.elapsedText}</span>
          <span>-{displayTimes.remainingText}</span>
        </div>
      </div>

      <div className="player-bottom-bar" {...(closing ? { inert: '' as const } : {})}>
        <div className="pb-now" onContextMenu={event => onOpenTrackMenu(event, track)}>
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
                type="button"
                aria-pressed={track.loved}
                disabled={track.dbId == null}
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
              type="button"
              className={`sub ${shuffle ? 'active' : ''}`}
              aria-pressed={shuffle}
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
              type="button"
              className={`sub ${repeat !== 'off' ? 'active' : ''}${repeat === 'one' ? ' repeat-one' : ''}`}
              aria-pressed={repeat !== 'off'}
              title={repeat === 'one' ? 'Repeat One' : repeat === 'all' ? 'Repeat All' : 'Repeat'}
              onClick={cycleRepeat}
            >
              <Icon name="repeat" size={14} />
            </button>
          </div>

        </div>

        <div className="pb-right">
          <button type="button" className="tb-icon-btn" title="Acciones de la canción" aria-label="Acciones de la canción" onClick={event => onOpenTrackMenu(event, track)}>
            <Icon name="ellipsis" size={14} />
          </button>
          <div className="pb-volume">
            <span className="ic"><Icon name={volume === 0 ? 'volumeM' : 'volume'} size={14} /></span>
            <div className="slider-wrap" style={{ '--pct': `${volume * 100}%` } as CSSProperties}>
              <div
                className="track"
                onPointerDown={onVolumePointerDown}
                onPointerMove={onVolumePointerMove}
                onPointerUp={onVolumePointerUp}
                onKeyDown={event => {
                  if (closing || !['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(event.key)) return
                  event.preventDefault()
                  const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 0.05 : -0.05
                  void setVolume(Math.max(0, Math.min(1, volume + direction)))
                }}
                role="slider"
                tabIndex={0}
                aria-label="Volumen"
                style={{ touchAction: 'none' }}
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
              ref={deviceButtonRef}
              type="button"
              className={`tb-icon-btn ${deviceMenuOpen ? 'active' : ''} ${exclusiveState.enabled ? 'exclusive-on' : ''}`}
              title={exclusiveState.enabled ? 'Audio output (Exclusive mode)' : 'Audio output'}
              aria-haspopup="menu"
              aria-expanded={deviceMenuOpen}
              onClick={onOutputButtonClick}
            >
              <Icon name="speaker" size={14} />
            </button>
            {deviceMenuOpen && (
              <div className={`output-device-menu upward ${exclusiveBusy ? 'transitioning' : ''}`} role="menu" onKeyDown={onOutputMenuKeyDown}>
                <div className="output-device-title">Audio Output</div>
                <OutputPathRow />
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
            {!supported
              ? 'Not supported on this device'
              : window.api.meta.platform === 'windows'
                ? 'Bypass the Windows mixer (experimental)'
                : 'Bypass the macOS mixer'}
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
