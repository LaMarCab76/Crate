import { type CSSProperties, Fragment, type DragEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Artwork } from './Artwork'
import { CrossfadeArtwork } from './CrossfadeArtwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { LyricsPanel } from './LyricsPanel'
import { EQBars } from './EQBars'
import { SpectrumVisualizer } from './SpectrumVisualizer'
import { UpNextToast } from './UpNextToast'
import { TrackLoadingOverlay } from './TrackLoadingOverlay'
import { ContextMenu } from './ContextMenu'
import { fmtTime, formatFeatured, formatPlaybackTimePair, splitArtist } from '@renderer/utils/format'
import {
  TRACK_DELETE_ROW_EASE,
  TRACK_DELETE_ROW_MS,
  toggleTrackFavorite,
  useAlbumByUiId,
  useArtistByUiId,
  useDeletingTrackIds,
} from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueHistory, useQueueIndex, useQueueReorderMode, useQueueStore, useQueueTracks, useQueueUpNext } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { useLevelerStore } from '@renderer/stores/levelerStore'
import {
  LEVELER_TARGET_MIN,
  LEVELER_TARGET_MAX,
  LEVELER_TARGET_STEP,
  formatLevelerGain,
} from '@shared/constants/leveler'
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
  const queueTracks = useQueueTracks()
  const queueHistory = useQueueHistory()
  const currentQueueIndex = useQueueIndex()
  const jumpTo = useQueueStore(s => s.jumpTo)
  const moveQueueTrack = useQueueStore(s => s.moveQueueTrack)
  const moveTrackToNext = useQueueStore(s => s.moveTrackToNext)
  const moveTrackToEnd = useQueueStore(s => s.moveTrackToEnd)
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
  const showVisualizer = useTweakStore(s => s.tweak.showPlayerVisualizer)
  const showLyrics = useTweakStore(s => s.tweak.showPlayerLyrics)
  const setTweak = useTweakStore(s => s.setTweak)
  const [visualizerVisible, setVisualizerVisible] = useState(() => showVisualizer)
  const [visualizerClosing, setVisualizerClosing] = useState(false)
  const [dragProgress, setDragProgress] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<PlayerTab>('nowPlaying')
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([])
  const [deviceLoading, setDeviceLoading] = useState(false)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [exclusiveState, setExclusiveState] = useState<ExclusiveModeState>({ enabled: false, deviceId: null })
  const [exclusiveBusy, setExclusiveBusy] = useState(false)
  const [exclusiveError, setExclusiveError] = useState<string | null>(null)
  const [queueMenuOpen, setQueueMenuOpen] = useState(false)
  const [queueContextMenu, setQueueContextMenu] = useState<{ x: number; y: number; index: number } | null>(null)
  const [draggingQueueIndex, setDraggingQueueIndex] = useState<number | null>(null)
  const [dragOverQueueIndex, setDragOverQueueIndex] = useState<number | null>(null)
  const deviceMenuRef = useRef<HTMLDivElement>(null)
  const queueMenuRef = useRef<HTMLDivElement>(null)
  const queueReorderMode = useQueueReorderMode()
  const setQueueReorderMode = useQueueStore(s => s.setQueueReorderMode)
  const queueLength = queueTracks.length
  const queueMinMoveIndex = Math.max(currentQueueIndex + 1, 0)

  useEffect(() => {
    if (currentTrack) setLastTrack(currentTrack)
  }, [currentTrack])

  useEffect(() => {
    if (album) setLastAlbum(album)
  }, [album])

  useEffect(() => {
    setQueueMenuOpen(false)
    setQueueContextMenu(null)
  }, [track?.dbId])

  useEffect(() => {
    if (!queueReorderMode) {
      setDraggingQueueIndex(null)
      setDragOverQueueIndex(null)
    }
  }, [queueReorderMode])

  useEffect(() => {
    if (!queueReorderMode || draggingQueueIndex == null) return

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearQueueDragState()
    }
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('keydown', onEscape)
    }
  }, [queueReorderMode, draggingQueueIndex])

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
  const queueDeleteStyle = {
    '--track-delete-row-duration': `${TRACK_DELETE_ROW_MS}ms`,
    '--track-delete-row-ease': TRACK_DELETE_ROW_EASE,
  } as CSSProperties

  const confirmQueueReorder = (action: () => void) => {
    action()
  }

  const queueMoveToNext = (index: number) => {
    confirmQueueReorder(() => {
      moveTrackToNext(index)
    })
    setQueueContextMenu(null)
  }

  const queueMoveToEnd = (index: number) => {
    confirmQueueReorder(() => {
      moveTrackToEnd(index)
    })
    setQueueContextMenu(null)
  }

  const clampQueueDropIndex = (value: number): number => {
    const maxIndex = Math.max(0, queueLength)
    return Number.isFinite(value)
      ? Math.max(queueMinMoveIndex, Math.min(maxIndex, value))
      : queueMinMoveIndex
  }

  const normalizedDropIndex = (fromIndex: number, targetIndex: number): number => {
    return targetIndex > fromIndex ? targetIndex - 1 : targetIndex
  }

  const clearQueueDragState = () => {
    setDraggingQueueIndex(null)
    setDragOverQueueIndex(null)
  }

  const queueShouldPushDown = (index: number): boolean => {
    if (draggingQueueIndex == null || dragOverQueueIndex == null) return false

    const normalizedTarget = normalizedDropIndex(draggingQueueIndex, dragOverQueueIndex)
    if (normalizedTarget === draggingQueueIndex) return false

    if (draggingQueueIndex < normalizedTarget) {
      return index > draggingQueueIndex && index <= normalizedTarget
    }

    return index >= normalizedTarget && index < draggingQueueIndex
  }

  const commitQueueMove = (fromIndex: number, overIndex: number | null) => {
    const clampedTarget = clampQueueDropIndex(overIndex ?? fromIndex)
    const normalized = normalizedDropIndex(fromIndex, clampedTarget)

    if (normalized === fromIndex || normalized < queueMinMoveIndex || normalized >= queueLength) {
      clearQueueDragState()
      return
    }

    moveQueueTrack(fromIndex, normalized)
    clearQueueDragState()
  }

  const handleQueueDragStart = (event: DragEvent<HTMLButtonElement>, index: number) => {
    if (!queueReorderMode) return
    if (index <= currentQueueIndex) return

    setDraggingQueueIndex(index)
    setDragOverQueueIndex(clampQueueDropIndex(index))
    event.dataTransfer.setData('text/queue-item', String(index))
    event.dataTransfer.effectAllowed = 'move'
  }

  const handleQueueDragOver = (event: DragEvent<HTMLDivElement>, index: number) => {
    if (!queueReorderMode || draggingQueueIndex == null) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const isAfter = event.clientY > rect.top + (rect.height / 2)
    setDragOverQueueIndex(clampQueueDropIndex(index + (isAfter ? 1 : 0)))
  }

  const handleQueueDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    if (draggingQueueIndex == null) return
    commitQueueMove(draggingQueueIndex, dragOverQueueIndex ?? index)
  }

  const handleQueueDragEnd = () => {
    clearQueueDragState()
  }

  const handleQueueListDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!queueReorderMode || draggingQueueIndex == null) return
    event.preventDefault()
    if (event.currentTarget === event.target) {
      setDragOverQueueIndex(queueLength)
    }
  }

  const handleQueueListDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target) return
    if (!queueReorderMode || draggingQueueIndex == null) return
    clearQueueDragState()
  }

  const handleQueueListDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (draggingQueueIndex == null) return
    commitQueueMove(draggingQueueIndex, dragOverQueueIndex ?? queueLength)
  }

  const openQueueContextMenu = (event: MouseEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    setQueueContextMenu({ x: event.clientX, y: event.clientY, index })
  }

  const toggleQueueShuffle = () => {
    toggleShuffle()
    setQueueMenuOpen(false)
  }

  const cycleRepeat = () => {
    setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')
  }

  useEffect(() => {
    if (!isOpen) {
      setDeviceMenuOpen(false)
      setQueueMenuOpen(false)
      setActiveTab('nowPlaying')
    }
  }, [isOpen])

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

  useEffect(() => {
    if (!queueMenuOpen) return

    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !queueMenuRef.current?.contains(target)) {
        setQueueMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setQueueMenuOpen(false)
      }
    }

    window.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [queueMenuOpen])

  if (!track) return null

  const { primary: artistPrimary, featured: artistFeatured } = splitArtist(track.artist)
  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0
  const displayProgress = dragProgress ?? progress
  const displayPositionSec = dragProgress !== null ? dragProgress * durationSec : positionSec
  const displayTimes = formatPlaybackTimePair(displayPositionSec, durationSec)

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
                  <div className="art" onClick={onExpand} onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    onExpand()
                  }} role="button" tabIndex={0}>
                    <CrossfadeArtwork album={displayAlbum} radius={8} objectFit="contain" />
                    <TrackLoadingOverlay />
                  </div>

                  <div className="info" key={track.id}>
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
                    {artistFeatured.length > 0 && (
                      <div className="pp-feat">{formatFeatured(artistFeatured)}</div>
                    )}
                    <div className="pp-quality-chip">
                      <CodecStrip track={track} compact />
                    </div>
                  </div>
                </div>

                <div className="pp-player-bottom">
                  <div className="pp-progress">
                    <div className="slider-wrap" style={{ '--pct': `${displayProgress * 100}%` } as CSSProperties}>
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
                      <div className="dot" aria-hidden="true" />
                    </div>
                    <div className="times">
                      <span>{displayTimes.elapsedText}</span>
                      <span>-{displayTimes.remainingText}</span>
                    </div>
                  </div>

                  <div className="pp-controls">
                    <button
                      className={`sub ${shuffle ? 'active' : ''}`}
                      title="Shuffle"
                      aria-pressed={shuffle}
                      onClick={toggleShuffle}
                    ><Icon name="shuffle" size={15} /></button>
                    <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={20} /></button>
                    <button className="play" onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
                      <Icon name={playing ? 'pause' : 'play'} size={16} />
                    </button>
                    <button title="Next" disabled={isTrackTransitioning} onClick={() => { void next() }}><Icon name="next" size={20} /></button>
                    <button
                      className={`sub ${repeat !== 'off' ? 'active' : ''}`}
                      title={repeat === 'one' ? 'Repeat One' : repeat === 'all' ? 'Repeat All' : 'Repeat'}
                      aria-pressed={repeat !== 'off'}
                      onClick={cycleRepeat}
                    ><Icon name="repeat" size={15} /></button>
                  </div>

                  <div className="pp-volume">
                    <span className="ic"><Icon name={volume === 0 ? 'volumeM' : 'volume'} size={14} /></span>
                    <div className="slider-wrap" style={{ '--pct': `${volume * 100}%` } as CSSProperties}>
                      <div
                        className="track"
                        onMouseDown={onVolumeMouseDown}
                        onKeyDown={event => {
                          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowDown' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp') return
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
                          {!deviceError && <LevelerMenuSection />}
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
                  {track && (
                    <>
                      <div className="queue-options" ref={queueMenuRef}>
                        <button
                          type="button"
                          className={`queue-options-trigger${queueMenuOpen ? ' active' : ''}`}
                          title="Opciones de Up Next"
                          aria-label="Opciones de Up Next"
                          aria-expanded={queueMenuOpen}
                          onClick={() => setQueueMenuOpen(open => !open)}
                        >
                          <Icon name="ellipsis" size={14} />
                        </button>
                        {queueMenuOpen && (
                          <div className="queue-options-menu" role="menu" aria-label="Opciones de Up Next">
                            <button
                              type="button"
                              className={`queue-options-item${queueReorderMode ? ' active' : ''}`}
                              role="menuitem"
                              aria-pressed={queueReorderMode}
                              onClick={() => {
                                setQueueReorderMode(!queueReorderMode)
                                setQueueMenuOpen(false)
                              }}
                            >
                              <Icon name="sortAZ" size={14} />
                              <span>Reordenar cola</span>
                            </button>
                            <button
                              type="button"
                              className={`queue-options-item${shuffle ? ' active' : ''}`}
                              role="menuitem"
                              aria-pressed={shuffle}
                              onClick={toggleQueueShuffle}
                            >
                              <Icon name="shuffle" size={14} />
                              <span>Aleatorio</span>
                            </button>
                          </div>
                        )}
                      </div>
                      {queueContextMenu && (
                        <ContextMenu
                          x={queueContextMenu.x}
                          y={queueContextMenu.y}
                          items={[
                            {
                              id: 'move-next',
                              label: 'Mover como siguiente',
                              icon: 'chevD',
                              onSelect: () => queueMoveToNext(queueContextMenu.index),
                            },
                            {
                              id: 'move-end',
                              label: 'Mover al final',
                              icon: 'chevR',
                              onSelect: () => queueMoveToEnd(queueContextMenu.index),
                            },
                          ]}
                          onClose={() => setQueueContextMenu(null)}
                        />
                      )}
                    </>
                  )}
                </div>
                <div
                  className={`queue-list${queueReorderMode ? ' reorder-mode' : ''}`}
                  style={queueDeleteStyle}
                  onDragOver={handleQueueListDragOver}
                  onDrop={handleQueueListDrop}
                  onDragEnd={handleQueueDragEnd}
                  onDragLeave={handleQueueListDragLeave}
                >
                  <div className="queue-section-label">Playing from · {displayAlbum?.title ?? '—'}</div>
                  <div className="queue-item now">
                    <div className="art"><Artwork album={displayAlbum} /></div>
                    <div>
                      <div className="t">{track.t}</div>
                      <div className="a">{artistPrimary}</div>
                      {artistFeatured.length > 0 && (
                        <div className="pp-feat">{formatFeatured(artistFeatured)}</div>
                      )}
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
                  {queueNext.map((t, offset) => {
                    const queueIndex = currentQueueIndex + 1 + offset
                    return (
                      <QueueItem
                        key={t.id}
                        track={t}
                        reorderMode={queueReorderMode}
                        dragging={queueIndex === draggingQueueIndex}
                        pushDown={queueShouldPushDown(queueIndex)}
                        onDoubleClick={() => { void jumpTo(queueIndex) }}
                        onContextMenu={event => openQueueContextMenu(event, queueIndex)}
                        onDragStart={event => handleQueueDragStart(event, queueIndex)}
                        onDragOver={event => handleQueueDragOver(event, queueIndex)}
                        onDrop={event => handleQueueDrop(event, queueIndex)}
                        onDragEnd={handleQueueDragEnd}
                      />
                    )
                  })}
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

function QueueItem({
  track,
  dim,
  reorderMode,
  dragging,
  pushDown,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  track: Track
  dim?: boolean
  reorderMode?: boolean
  dragging?: boolean
  pushDown?: boolean
  onDoubleClick?: () => void
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void
  onDrop?: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd?: () => void
}) {
  const album = useAlbumByUiId(track.albumId)
  const deletingIds = useDeletingTrackIds()
  const isDeleting = track.dbId != null && deletingIds.has(track.dbId)
  const { primary: artistPrimary, featured: artistFeatured } = splitArtist(track.artist)
  return (
    <div
      className={`queue-item${isDeleting ? ' deleting' : ''}${reorderMode ? ' reorder-mode' : ''}${dragging ? ' queue-item-dragging' : ''}${pushDown ? ' queue-item-push-down' : ''}`}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={dim && !isDeleting ? { opacity: 0.55 } : undefined}
    >
      {reorderMode && (
        <button
          type="button"
          className="queue-drag-handle"
          title="Reordenar"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onMouseDown={event => {
            event.stopPropagation()
          }}
        >
          <Icon name="list" size={12} />
        </button>
      )}
      <div className="art"><Artwork album={album} /></div>
      <div>
        <div className="t">{track.t}</div>
        <div className="a">{artistPrimary}</div>
        {artistFeatured.length > 0 && (
          <div className="pp-feat">{formatFeatured(artistFeatured)}</div>
        )}
      </div>
      <span className="dur">{fmtTime(track.d)}</span>
    </div>
  )
}

// Volume leveler (Sound Check) controls inside the Audio Output popover. Shares
// the levelerStore with the Preferences panel, so toggling here updates both.
function LevelerMenuSection() {
  const enabled = useLevelerStore(s => s.enabled)
  const targetLufs = useLevelerStore(s => s.targetLufs)
  const preventClipping = useLevelerStore(s => s.preventClipping)
  const currentGainDb = useLevelerStore(s => s.currentGainDb)
  const setEnabled = useLevelerStore(s => s.setEnabled)
  const setTargetLufs = useLevelerStore(s => s.setTargetLufs)
  const setPreventClipping = useLevelerStore(s => s.setPreventClipping)

  return (
    <div className="leveler-menu-section">
      <div className="leveler-menu-title">Nivelador de volumen</div>
      <button
        type="button"
        className={`exclusive-toggle ${enabled ? 'on' : ''}`}
        aria-pressed={enabled}
        onClick={() => { void setEnabled(!enabled) }}
      >
        <div className="exclusive-toggle-text">
          <div className="exclusive-toggle-title">Sound Check</div>
          <div className="exclusive-toggle-sub">
            {enabled ? `Ganancia: ${formatLevelerGain(currentGainDb)}` : 'Volumen constante entre canciones'}
          </div>
        </div>
        <span className={`exclusive-toggle-switch ${enabled ? 'on' : ''}`} aria-hidden="true">
          <span className="exclusive-toggle-knob" />
        </span>
      </button>
      {enabled && (
        <>
          <label className="leveler-menu-target">
            <span className="leveler-menu-target-label">Nivel objetivo</span>
            <input
              type="range"
              min={LEVELER_TARGET_MIN}
              max={LEVELER_TARGET_MAX}
              step={LEVELER_TARGET_STEP}
              value={targetLufs}
              onChange={e => { void setTargetLufs(Number(e.target.value)) }}
              aria-label="Nivel objetivo de normalización en LUFS"
            />
            <span className="leveler-menu-target-value">{targetLufs} LUFS</span>
          </label>
          <button
            type="button"
            className={`leveler-menu-clip ${preventClipping ? 'on' : ''}`}
            aria-pressed={preventClipping}
            onClick={() => { void setPreventClipping(!preventClipping) }}
          >
            <Icon name={preventClipping ? 'check' : 'speaker'} size={12} />
            <span>Evitar saturación</span>
          </button>
        </>
      )}
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
