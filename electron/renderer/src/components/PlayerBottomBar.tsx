import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Artwork } from './Artwork'
import { CrossfadeArtwork } from './CrossfadeArtwork'
import { CodecStrip } from './CodecStrip'
import { ContextMenu } from './ContextMenu'
import { Icon } from './Icon'
import { trackMenuHeader } from './MediaActions'
import { SpectrumVisualizer } from './SpectrumVisualizer'
import { TrackLoadingOverlay } from './TrackLoadingOverlay'
import { fmtTime, formatPlaybackTimePair, splitArtist, titleWithFeatured } from '@renderer/utils/format'
import {
  toggleTrackFavorite,
  useAlbumByUiId,
  useArtistByUiId,
} from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueIndex, useQueueStore, useQueueUpNext } from '@renderer/stores/queueStore'
import { OutputPathRow } from '@renderer/components/OutputPathRow'
import type { AudioOutputDevice, ExclusiveModeState } from '@shared/types/ipc-contract'
import type { Album, Artist, Track } from '@shared/types/library'

interface PlayerBottomBarProps {
  closing?: boolean
  // Changes whenever the app navigates. The sheet folds back on every view
  // change, so a view opened from elsewhere (track menu, activity center,
  // shortcuts) never lands under the sheet and its scrim.
  viewKey?: unknown
  onExpand: () => void
  onShowPanel: () => void
  // The track menu and its dialogs are hosted by App, not by the island:
  // editing, moving or trashing the playing track stops playback, which
  // unmounts this dock while the dialog is still saving.
  onOpenTrackMenu: (event: MouseEvent<HTMLElement>, track: Track) => void
  lyricsSidePaneOpen: boolean
  onToggleLyricsSidePane: () => void
  onOpenAlbum?: (album: Album) => void
  onOpenArtist?: (artist: Artist) => void
}

type SheetTab = 'now' | 'next'
type InertProps = { inert?: '' }

// The sheet's Up Next list is a quick glance; the player panel keeps the full
// queue (reorder, history), so very long queues are capped here.
const SHEET_QUEUE_LIMIT = 100
// Thin bars in the sheet's visualizer well, closer to the design than the
// width-derived compact count.
const SHEET_VISUALIZER_COLUMNS = 24
// Covers the island's 560ms width/height spring (.pb-island.morphing in
// globals.css) and the sheet layer's 280ms fade-out.
const SHEET_MORPH_MS = 600

const SHEET_FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const getInertProps = (inactive: boolean): InertProps =>
  inactive ? { inert: '' } : {}

// While the sheet is open the rest of the shell goes inert (as behind a
// ModalShell): walking up from the dock to #root, every sibling branch is
// taken out of the tab order, pointer hit-testing and the accessibility tree.
// Clicks on surfaces stacked above the scrim (activity center) fall through to
// the scrim and fold the sheet. Menus and dialogs portaled to <body> stay live.
function isolateShellBackground(dock: HTMLElement): () => void {
  const restored: Array<{ element: HTMLElement; inert: string | null; ariaHidden: string | null }> = []
  let branch: HTMLElement = dock
  while (branch.id !== 'root') {
    const parent = branch.parentElement
    if (!parent || parent === document.body) break
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue
      restored.push({
        element: sibling,
        inert: sibling.getAttribute('inert'),
        ariaHidden: sibling.getAttribute('aria-hidden'),
      })
      sibling.setAttribute('inert', '')
      sibling.setAttribute('aria-hidden', 'true')
    }
    branch = parent
  }
  return () => {
    for (const item of restored) {
      if (item.inert == null) item.element.removeAttribute('inert')
      else item.element.setAttribute('inert', item.inert)
      if (item.ariaHidden == null) item.element.removeAttribute('aria-hidden')
      else item.element.setAttribute('aria-hidden', item.ariaHidden)
    }
  }
}

// Now Playing island: a floating glass capsule over the content that morphs
// into the larger Now Playing sheet (artwork + visualizer, transport, Up Next).
// App owns the enter/exit (the .player-dock state classes); the island owns the
// sheet, its scrim and everything that used to live in the docked bottom bar.
export function PlayerBottomBar({
  closing = false,
  viewKey,
  onExpand,
  onShowPanel,
  onOpenTrackMenu,
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
  const jumpTo = useQueueStore(s => s.jumpTo)
  const moveTrackToNext = useQueueStore(s => s.moveTrackToNext)
  const moveTrackToEnd = useQueueStore(s => s.moveTrackToEnd)
  const queueNext = useQueueUpNext()
  const currentQueueIndex = useQueueIndex()
  const album = useAlbumByUiId(track?.albumId)
  const artist = useArtistByUiId(track?.artistId)
  const [lastAlbum, setLastAlbum] = useState<Album | null>(null)
  const displayAlbum = album ?? (track?.albumId === lastAlbum?.id ? lastAlbum : undefined)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetTab, setSheetTab] = useState<SheetTab>('now')
  const [queueContextMenu, setQueueContextMenu] = useState<{ x: number; y: number; index: number } | null>(null)
  const [dragProgress, setDragProgress] = useState<number | null>(null)
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([])
  const [deviceLoading, setDeviceLoading] = useState(false)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [exclusiveState, setExclusiveState] = useState<ExclusiveModeState>({ enabled: false, deviceId: null })
  const [exclusiveBusy, setExclusiveBusy] = useState(false)
  const [exclusiveError, setExclusiveError] = useState<string | null>(null)
  const deviceMenuRef = useRef<HTMLDivElement>(null)
  const islandRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const sheetFocusRef = useRef<HTMLButtonElement>(null)
  const compactToggleRef = useRef<HTMLButtonElement>(null)
  const sheetWasVisibleRef = useRef(false)
  // The sheet folds back into the island while the dock exits (player panel
  // shown, fullscreen opened), so the scrim never outlives the island.
  const sheetVisible = sheetOpen && !closing
  // The island only animates width/height/radius while it morphs between the
  // capsule and the sheet (.morphing). Dock and window resizes apply at once
  // instead of chasing the pointer with the spring. Set during render so the
  // class lands in the same frame as .sheet-open.
  const [morphTarget, setMorphTarget] = useState(sheetVisible)
  const [morphing, setMorphing] = useState(false)
  if (morphTarget !== sheetVisible) {
    setMorphTarget(sheetVisible)
    setMorphing(true)
  }
  // Sheet content is only rendered while the sheet shows (or is still folding
  // away): the collapsed island re-renders on every position tick and must not
  // drag the hidden sheet, its queue rows and visualizer along with it.
  const sheetLive = sheetVisible || morphing

  const playQueueIndex = useCallback((index: number) => {
    void jumpTo(index)
  }, [jumpTo])

  const openQueueContextMenu = useCallback((event: MouseEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    event.stopPropagation()
    setQueueContextMenu({ x: event.clientX, y: event.clientY, index })
  }, [])

  useEffect(() => {
    if (!morphing) return
    const timeout = window.setTimeout(() => setMorphing(false), SHEET_MORPH_MS)
    return () => window.clearTimeout(timeout)
  }, [morphing, sheetVisible])

  // Any navigation folds the sheet, wherever it came from (the track menu's
  // metadata fix, an activity action, the sheet's own album/artist links).
  useEffect(() => {
    setSheetOpen(false)
  }, [viewKey])

  useEffect(() => {
    if (currentTrack) setLastTrack(currentTrack)
  }, [currentTrack])

  useEffect(() => {
    if (album) setLastAlbum(album)
  }, [album])

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
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setDeviceMenuOpen(false)
    }

    window.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [deviceMenuOpen])

  // Escape folds the sheet back into the island. Inner layers (audio output
  // popover, context menus, dialogs) take the key first.
  useEffect(() => {
    if (!sheetVisible) return

    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (deviceMenuOpen) return
      if (document.querySelector('.context-menu, .modal-backdrop')) return
      setSheetOpen(false)
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [sheetVisible, deviceMenuOpen])

  // The audio output button lives in the sheet; don't leave its popover open
  // behind a collapsed island.
  useEffect(() => {
    if (!sheetVisible) {
      setDeviceMenuOpen(false)
      setQueueContextMenu(null)
    }
  }, [sheetVisible])

  // Keep keyboard focus on a live layer: the layer being hidden goes inert.
  // The open sheet is modal, so it always takes focus; on close, focus only
  // returns to the capsule if it was still in the island.
  useEffect(() => {
    if (sheetVisible === sheetWasVisibleRef.current) return
    sheetWasVisibleRef.current = sheetVisible
    if (sheetVisible) {
      sheetFocusRef.current?.focus({ preventScroll: true })
      return
    }
    const active = document.activeElement
    const focusWasHere = active === document.body || (active != null && islandRef.current?.contains(active))
    if (focusWasHere && !closing) compactToggleRef.current?.focus({ preventScroll: true })
  }, [sheetVisible, closing])

  // The open sheet is a modal layer: the rest of the shell goes inert until it
  // folds back (see isolateShellBackground).
  useEffect(() => {
    if (!sheetVisible) return
    const dock = islandRef.current?.closest<HTMLElement>('.player-dock')
    return dock ? isolateShellBackground(dock) : undefined
  }, [sheetVisible])

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

  if (!track) return null

  const { primary: artistPrimary, featured: artistFeatured } = splitArtist(track.artist)
  const barTitle = titleWithFeatured(track.t, artistFeatured)
  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0
  const displayProgress = dragProgress ?? progress
  const displayPositionSec = dragProgress !== null ? dragProgress * durationSec : positionSec
  const displayTimes = formatPlaybackTimePair(displayPositionSec, durationSec)
  const progressPct = `${displayProgress * 100}%`
  const canOpenAlbum = album != null && onOpenAlbum != null && !album.id.startsWith('a-unresolved-')
  const canOpenArtist = artist != null && onOpenArtist != null
  const showFallbackBadge = streamSource === 'file' && streamSourceState === 'promoting'
  const lyricsToggleLabel = lyricsSidePaneOpen ? 'Close lyrics sidebar' : 'Open lyrics sidebar'

  const openSheet = () => setSheetOpen(true)
  const closeSheet = () => setSheetOpen(false)

  const openAlbum = () => {
    if (!canOpenAlbum) return
    closeSheet()
    onOpenAlbum?.(album)
  }

  const openArtist = () => {
    if (!canOpenArtist) return
    closeSheet()
    onOpenArtist?.(artist)
  }

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

  const onProgressKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    void seek(Math.max(0, Math.min(durationSec, positionSec + (event.key === 'ArrowRight' ? 5 : -5))))
  }

  const progressSliderProps = {
    role: 'slider',
    tabIndex: 0,
    'aria-label': 'Posición de reproducción',
    'aria-valuemin': 0,
    'aria-valuemax': Math.max(0, durationSec),
    'aria-valuenow': Math.max(0, displayPositionSec),
    'aria-valuetext': displayTimes.elapsedText,
    onMouseDown: onProgressMouseDown,
    onKeyDown: onProgressKeyDown,
  } as const

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

  const toggleLyricsSidePane = () => {
    // The lyrics card slides in beside the content; fold the sheet so the
    // scrim doesn't cover it.
    if (!lyricsSidePaneOpen) closeSheet()
    onToggleLyricsSidePane()
  }

  // Track under the open queue menu (identity row of the menu).
  const queueMenuTrack = queueContextMenu ? queueNext[queueContextMenu.index - currentQueueIndex - 1] : undefined

  const sheetQueue = sheetLive && sheetTab === 'next' ? queueNext.slice(0, SHEET_QUEUE_LIMIT) : []
  const hiddenQueueCount = Math.max(0, queueNext.length - SHEET_QUEUE_LIMIT)
  const repeatTitle = repeat === 'one' ? 'Repeat One' : repeat === 'all' ? 'Repeat All' : 'Repeat'

  // Modal sheet: Tab / Shift+Tab wrap inside it instead of walking out of the
  // island (the rest of the shell is inert while it is open).
  const keepTabInSheet = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!sheetVisible || event.key !== 'Tab' || event.defaultPrevented) return
    const sheet = sheetRef.current
    if (!sheet) return
    const focusables = Array.from(sheet.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE))
      .filter(element => element.getClientRects().length > 0)
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    const outside = active == null || !sheet.contains(active)
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <>
      <div
        className={`pb-island-scrim${sheetVisible ? ' show' : ''}`}
        aria-hidden="true"
        onClick={closeSheet}
      />

      <div className="pb-island-frame">
        <div
          ref={islandRef}
          className={`pb-island${sheetVisible ? ' sheet-open' : ''}${morphing ? ' morphing' : ''}${dragProgress !== null ? ' seeking' : ''}${closing ? ' closing' : ''}`}
          role={sheetVisible ? 'dialog' : 'region'}
          aria-modal={sheetVisible || undefined}
          aria-label="Now Playing"
          onKeyDown={keepTabInSheet}
          onContextMenu={event => {
            if (event.target instanceof Element && event.target.closest('.output-device-menu')) return
            onOpenTrackMenu(event, track)
          }}
        >
          <div
            className="pb-island-compact"
            aria-hidden={sheetVisible}
            {...getInertProps(sheetVisible)}
          >
            <div
              className="pb-island-now"
              role="button"
              tabIndex={0}
              title="Now Playing"
              aria-label={`Now Playing: ${barTitle}`}
              aria-expanded={sheetVisible}
              onClick={openSheet}
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                openSheet()
              }}
            >
              <div className="pb-island-art">
                <Artwork album={displayAlbum} radius={0} objectFit="cover" />
                <TrackLoadingOverlay />
              </div>
              <div className="pb-island-meta">
                <div className="pb-island-title-row">
                  <span className="pb-island-title">{barTitle}</span>
                  {showFallbackBadge && (
                    <span className="stream-source-badge is-file" title="Streaming progresivo fallido; usando archivo">
                      Reanudando por archivo
                    </span>
                  )}
                </div>
                <div className="pb-island-sub">{artistPrimary} · {track.albumTitle}</div>
              </div>
            </div>

            <div className="pb-island-controls">
              <button type="button" className="pb-island-btn pb-island-prev" title="Previous" onClick={() => { void previous() }}>
                <Icon name="prev" size={18} />
              </button>
              <button
                type="button"
                className="pb-island-play"
                title={playing ? 'Pause' : 'Play'}
                onClick={() => { void togglePlay() }}
              >
                <Icon name={playing ? 'pause' : 'play'} size={16} style={playing ? undefined : { marginLeft: 2 }} />
              </button>
              <button
                type="button"
                className="pb-island-btn pb-island-next"
                title="Next"
                disabled={isTrackTransitioning}
                onClick={() => { void next() }}
              >
                <Icon name="next" size={18} />
              </button>
              <span className="pb-island-divider" aria-hidden="true" />
              <button
                type="button"
                className="pb-island-btn dim pb-island-panel-btn"
                title="Show Player Panel"
                aria-label="Show Player Panel"
                onClick={onShowPanel}
              >
                <Icon name="sidebarRight" size={15} />
              </button>
              <button
                ref={compactToggleRef}
                type="button"
                className="pb-island-btn dim"
                title="Now Playing"
                aria-label="Now Playing"
                aria-expanded={sheetVisible}
                onClick={openSheet}
              >
                <Icon name="chevU" size={14} />
              </button>
            </div>

            <div className="pb-island-progress" {...progressSliderProps}>
              <div className="line">
                <div className="fill" style={{ width: progressPct }} />
              </div>
            </div>
          </div>

          <div
            ref={sheetRef}
            className="pb-sheet"
            aria-hidden={!sheetVisible}
            {...getInertProps(!sheetVisible)}
          >
            {sheetLive && (
              <>
                <div className="pb-sheet-left">
                  <button type="button" className="pb-sheet-art" onClick={onExpand} title="Expand player" aria-label="Expand player">
                    <CrossfadeArtwork album={displayAlbum} radius={0} objectFit="cover" />
                    <TrackLoadingOverlay />
                  </button>
                  <div className="pb-sheet-viz">
                    <SpectrumVisualizer
                      mode="compact"
                      columns={SHEET_VISUALIZER_COLUMNS}
                      active={sheetVisible && sheetTab === 'now'}
                    />
                  </div>
                </div>

                <div className="pb-sheet-main">
                  <div className="pb-sheet-head">
                    <div className={`pb-sheet-tabs${sheetTab === 'next' ? ' on-next' : ''}`} role="tablist" aria-label="Now Playing">
                      <span className="pb-sheet-tabs-thumb" aria-hidden="true" />
                      <button
                        ref={sheetTab === 'now' ? sheetFocusRef : undefined}
                        type="button"
                        className={`pb-sheet-tab${sheetTab === 'now' ? ' active' : ''}`}
                        role="tab"
                        aria-selected={sheetTab === 'now'}
                        onClick={() => setSheetTab('now')}
                      >
                        Now Playing
                      </button>
                      <button
                        ref={sheetTab === 'next' ? sheetFocusRef : undefined}
                        type="button"
                        className={`pb-sheet-tab${sheetTab === 'next' ? ' active' : ''}`}
                        role="tab"
                        aria-selected={sheetTab === 'next'}
                        onClick={() => setSheetTab('next')}
                      >
                        Up Next
                      </button>
                    </div>
                    <div className="pb-sheet-actions">
                      <button
                        type="button"
                        className={`pb-sheet-btn${lyricsSidePaneOpen ? ' active' : ''}`}
                        title={lyricsToggleLabel}
                        aria-label={lyricsToggleLabel}
                        aria-pressed={lyricsSidePaneOpen}
                        onClick={toggleLyricsSidePane}
                      >
                        <Icon name="lyrics" size={14} />
                      </button>
                      <button type="button" className="pb-sheet-btn" title="Expand" aria-label="Expand" onClick={onExpand}>
                        <Icon name="expand" size={13} />
                      </button>
                      <button type="button" className="pb-sheet-btn" title="Collapse" aria-label="Collapse" onClick={closeSheet}>
                        <Icon name="chevD" size={14} />
                      </button>
                    </div>
                  </div>

                  {sheetTab === 'now' ? (
                    <div className="pb-sheet-now" role="tabpanel" aria-label="Now Playing">
                      <div className="pb-sheet-title-row">
                        {canOpenAlbum ? (
                          <button type="button" className="pb-sheet-title pb-link" onClick={openAlbum} title="Abrir álbum">
                            {barTitle}
                          </button>
                        ) : (
                          <div className="pb-sheet-title">{barTitle}</div>
                        )}
                        <div className="pb-sheet-title-actions">
                          <button
                            type="button"
                            className={`pb-sheet-icon-btn${track.loved ? ' loved' : ''}`}
                            title={track.loved ? 'Remove from favorites' : 'Mark as favorite'}
                            aria-pressed={Boolean(track.loved)}
                            onClick={() => {
                              if (track.dbId == null) return
                              void toggleTrackFavorite(track.dbId, !track.loved)
                            }}
                          >
                            <Icon name={track.loved ? 'heartF' : 'heart'} size={16} />
                          </button>
                          <button
                            type="button"
                            className="pb-sheet-icon-btn"
                            title="Más acciones"
                            aria-label="Más acciones"
                            aria-haspopup="menu"
                            onClick={event => onOpenTrackMenu(event, track)}
                          >
                            <Icon name="ellipsis" size={15} />
                          </button>
                        </div>
                      </div>
                      <div className="pb-sheet-sub">
                        {canOpenArtist ? (
                          <button type="button" className="pb-link" onClick={openArtist} title="Abrir artista">
                            {artistPrimary}
                          </button>
                        ) : (
                          artistPrimary
                        )}
                        {' · '}
                        {canOpenAlbum ? (
                          <button type="button" className="pb-link" onClick={openAlbum} title="Abrir álbum">
                            {track.albumTitle}
                          </button>
                        ) : (
                          track.albumTitle
                        )}
                      </div>
                      <div className="pb-sheet-chips">
                        <div className="pb-sheet-codec">
                          <CodecStrip track={track} compact />
                        </div>
                        {showFallbackBadge && (
                          <div className="stream-source-badge is-file" title="Streaming progresivo fallido; usando archivo">
                            Reanudando por archivo
                          </div>
                        )}
                      </div>

                      <div className="pb-sheet-progress">
                        <div className="pb-sheet-seek" {...progressSliderProps}>
                          <div className="track">
                            <div className="fill" style={{ width: progressPct }} />
                          </div>
                        </div>
                        <div className="pb-sheet-times" aria-hidden="true">
                          <span>{displayTimes.elapsedText}</span>
                          <span>-{displayTimes.remainingText}</span>
                        </div>
                      </div>

                      <div className="pb-sheet-transport">
                        <button
                          type="button"
                          className={`sub${shuffle ? ' active' : ''}`}
                          title="Shuffle"
                          aria-pressed={shuffle}
                          onClick={() => toggleShuffle()}
                        >
                          <Icon name="shuffle" size={17} />
                        </button>
                        <button type="button" className="skip" title="Previous" onClick={() => { void previous() }}>
                          <Icon name="prev" size={24} />
                        </button>
                        <button type="button" className="play" title={playing ? 'Pause' : 'Play'} onClick={() => { void togglePlay() }}>
                          <Icon name={playing ? 'pause' : 'play'} size={22} style={playing ? undefined : { marginLeft: 2 }} />
                        </button>
                        <button type="button" className="skip" title="Next" disabled={isTrackTransitioning} onClick={() => { void next() }}>
                          <Icon name="next" size={24} />
                        </button>
                        <button
                          type="button"
                          className={`sub${repeat !== 'off' ? ' active' : ''}`}
                          title={repeatTitle}
                          aria-pressed={repeat !== 'off'}
                          onClick={cycleRepeat}
                        >
                          <Icon name="repeat" size={17} />
                          {repeat === 'one' && <span className="pb-repeat-one" aria-hidden="true">1</span>}
                        </button>
                      </div>

                      <div className="pb-sheet-volume">
                        <span className="ic"><Icon name={volume === 0 ? 'volumeM' : 'volume'} size={15} /></span>
                        <div
                          className="pb-sheet-vol"
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
                          <div className="track">
                            <div className="fill" style={{ width: `${volume * 100}%` }} />
                          </div>
                        </div>
                        <div className="output-device-control" ref={deviceMenuRef}>
                          <button
                            type="button"
                            className={`pb-sheet-icon-btn ${deviceMenuOpen ? 'active' : ''} ${exclusiveState.enabled ? 'exclusive-on' : ''}`}
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
                      </div>
                    </div>
                  ) : (
                    <div className="pb-sheet-queue" role="tabpanel" aria-label="Up Next">
                      <div className="pb-sheet-queue-head">
                        <div className="pb-sheet-queue-from">Playing from · {displayAlbum?.title ?? track.albumTitle ?? '—'}</div>
                        <div className="pb-sheet-queue-remaining">{totalQueueRemainingText} remaining</div>
                      </div>
                      <div className="pb-sheet-queue-list">
                        {sheetQueue.length === 0 && <div className="pb-sheet-queue-note">Queue is empty</div>}
                        {sheetQueue.map((t, offset) => (
                          <SheetQueueRow
                            key={t.id}
                            track={t}
                            queueIndex={currentQueueIndex + 1 + offset}
                            onPlay={playQueueIndex}
                            onContextMenu={openQueueContextMenu}
                          />
                        ))}
                        {hiddenQueueCount > 0 && (
                          <div className="pb-sheet-queue-note">+{hiddenQueueCount} más en la cola</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="pb-island-times" aria-hidden="true">
          <span>{displayTimes.elapsedText}</span>
          <span>-{displayTimes.remainingText}</span>
        </div>
      </div>

      {/* The queue menu escapes the island: its backdrop-filter and transform
          would otherwise become the containing block of the fixed layer. */}
      {createPortal(
        <>
          {queueContextMenu && (
            <ContextMenu
              x={queueContextMenu.x}
              y={queueContextMenu.y}
              header={queueMenuTrack ? trackMenuHeader(queueMenuTrack) : undefined}
              items={[
                {
                  id: 'move-next',
                  label: 'Mover como siguiente',
                  icon: 'chevD',
                  onSelect: () => moveTrackToNext(queueContextMenu.index),
                },
                {
                  id: 'move-end',
                  label: 'Mover al final',
                  icon: 'chevR',
                  onSelect: () => moveTrackToEnd(queueContextMenu.index),
                },
              ]}
              onClose={() => setQueueContextMenu(null)}
            />
          )}
        </>,
        document.body,
      )}
    </>
  )
}

// Memoized with index-taking handlers that are stable across renders, so the
// list only re-renders when the queue itself changes, not on position ticks.
const SheetQueueRow = memo(function SheetQueueRow({
  track,
  queueIndex,
  onPlay,
  onContextMenu,
}: {
  track: Track
  queueIndex: number
  onPlay: (queueIndex: number) => void
  onContextMenu: (event: MouseEvent<HTMLDivElement>, queueIndex: number) => void
}) {
  const album = useAlbumByUiId(track.albumId)
  const { primary: artistPrimary } = splitArtist(track.artist)
  return (
    <div
      className="pb-sheet-queue-row"
      tabIndex={0}
      onDoubleClick={() => onPlay(queueIndex)}
      onContextMenu={event => onContextMenu(event, queueIndex)}
      onKeyDown={event => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        onPlay(queueIndex)
      }}
    >
      <div className="art"><Artwork album={album} radius={0} /></div>
      <div className="meta">
        <div className="t">{track.t}</div>
        <div className="a">{artistPrimary}</div>
      </div>
      <span className="dur">{fmtTime(track.d)}</span>
    </div>
  )
})

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
