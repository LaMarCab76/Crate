import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import type { Album, Artist, Playlist } from '@shared/types/library'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { Icon, type IconName } from './components/Icon'
import { PlayerPane } from './components/PlayerPane'
import { PlayerBottomBar } from './components/PlayerBottomBar'
import { DeviceConnectModal, type DeviceConnectTarget } from './components/DeviceConnectModal'
import { LyricsSidePane } from './components/LyricsSidePane'
import { UpNextToast } from './components/UpNextToast'
import { NowPlayingFull } from './components/NowPlayingFull'
import { LyricsCandidates } from './components/LyricsCandidates'
import { LibraryView } from './views/LibraryView'
import { AlbumsView } from './views/AlbumsView'
import { AlbumView } from './views/AlbumView'
import { ArtistsView } from './views/ArtistsView'
import { ArtistView } from './views/ArtistView'
import { PlaylistView } from './views/PlaylistView'
import { SearchView } from './views/SearchView'
import { SettingsView } from './views/SettingsView'
import { ImportView } from './views/ImportView'
import { GenresView } from './views/GenresView'
import { DevicesView } from './views/DevicesView'
import { DeviceSyncView, type DeviceSyncTab } from './views/DeviceSyncView'
import { DeviceLibraryView, type DeviceLibrarySection } from './views/DeviceLibraryView'
import { useTweaks, useListPrefsStore } from './stores/settingsStore'
import { useAlbumByUiId, useFavoriteTracks, useLibraryStore } from './stores/libraryStore'
import { usePlaybackStore } from './stores/playbackStore'
import { useDeviceStore } from './stores/deviceStore'
import { installAutoHideScrollbars } from './utils/autoHideScrollbars'
import { extractDominantColor } from './utils/colorExtract'
import { vivify } from './utils/colorAdjust'

export type View =
  | { kind: 'library' }
  | { kind: 'recent' }
  | { kind: 'albums' }
  | { kind: 'artists' }
  | { kind: 'genres' }
  | { kind: 'search' }
  | { kind: 'settings' }
  | { kind: 'import' }
  | { kind: 'devices' }
  | { kind: 'device'; deviceId: string; section: 'dashboard' | 'sync' | DeviceLibrarySection }
  | { kind: 'album'; album: Album }
  | { kind: 'artist'; artist: Artist }
  | { kind: 'playlist'; playlist: Playlist }
  | { kind: 'favoriteTracks' }

const SIDEBAR_WIDTH_STORAGE_KEY = 'crate.layout.sidebarWidth.v1'
const PLAYER_PANE_OPEN_STORAGE_KEY = 'crate.layout.playerPaneOpen.v1'
const PLAYER_PANE_EXIT_MS = 280
const PB_PLAYER_EXIT_MS = 190
const LYRICS_SIDE_PANE_EXIT_MS = 340

const SIDEBAR_WIDTH_DEFAULT = 240
const SIDEBAR_WIDTH_MIN = 180
const SIDEBAR_WIDTH_MAX = 420

const LYRICS_SIDE_WIDTH_STORAGE_KEY = 'crate.layout.lyricsSideWidth.v1'
const LYRICS_SIDE_WIDTH_DEFAULT = 380
const LYRICS_SIDE_WIDTH_MIN = 300
const LYRICS_SIDE_WIDTH_MAX = 620

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function loadPersistedWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    if (typeof window === 'undefined') return fallback
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return fallback
    return clamp(parsed, min, max)
  } catch {
    return fallback
  }
}

function loadPersistedBool(key: string, fallback: boolean): boolean {
  try {
    if (typeof window === 'undefined') return fallback
    const raw = window.localStorage.getItem(key)
    if (raw === 'true') return true
    if (raw === 'false') return false
    return fallback
  } catch {
    return fallback
  }
}

const DEVICE_SYNC_PHASE_LABELS: Record<string, string> = {
  discovering: 'Buscando',
  reading: 'Leyendo',
  fetching_lyrics: 'Buscando letras',
  copying: 'Copiando',
  deleting: 'Eliminando',
  refreshing: 'Actualizando',
  optimizing_artwork: 'Optimizando artwork',
  writing_state: 'Guardando estado',
  complete: 'Completado',
}

type DeviceSectionKey = 'dashboard' | 'sync' | DeviceLibrarySection

// Section tabs rendered as a second line directly under the toolbar whenever a
// device view is open. Mirrors the device's sidebar sub-items so the active
// section is switchable from the top chrome.
function DeviceSectionTabs({
  deviceId,
  section,
  onNavigate,
}: {
  deviceId: string
  section: DeviceSectionKey
  onNavigate: (v: View) => void
}) {
  const devices = useDeviceStore(s => s.devices)
  const device = devices.find(item => item.id === deviceId) ?? null
  const tabs: Array<{ key: DeviceSectionKey; label: string; icon: IconName; badge?: number }> = [
    { key: 'dashboard', label: 'Resumen', icon: 'device' },
    { key: 'sync', label: 'Sync', icon: 'sync' },
    { key: 'library', label: 'Biblioteca', icon: 'album', badge: device?.trackCount || undefined },
    { key: 'playlists', label: 'Playlists', icon: 'queue' },
  ]
  if (device?.hasRockbox) {
    tabs.push({ key: 'rockboxThemes', label: 'Rockbox Themes', icon: 'sparkle' })
  }
  return (
    <nav className="device-section-tabs" aria-label="Secciones del dispositivo">
      {tabs.map(tab => (
        <button
          key={tab.key}
          type="button"
          className={`device-section-tab ${section === tab.key ? 'active' : ''}`}
          aria-current={section === tab.key ? 'page' : undefined}
          onClick={() => onNavigate({ kind: 'device', deviceId, section: tab.key })}
        >
          <Icon name={tab.icon} size={14} />
          {tab.label}
          {tab.badge != null && <span className="device-tab-badge">{tab.badge.toLocaleString()}</span>}
        </button>
      ))}
    </nav>
  )
}

const DEVICE_SYNC_SUBTABS: Array<{ key: DeviceSyncTab; label: string; icon: IconName }> = [
  { key: 'sync', label: 'Sincronización', icon: 'sync' },
  { key: 'optimize', label: 'Optimizar', icon: 'sparkle' },
  { key: 'config', label: 'Configuración', icon: 'sliders' },
]

// Second navbar row shown under DeviceSectionTabs while the Sync section is open.
// Drives the sub-view rendered inside DeviceSyncView.
function DeviceSyncSubTabs({
  active,
  onChange,
}: {
  active: DeviceSyncTab
  onChange: (tab: DeviceSyncTab) => void
}) {
  return (
    <nav className="device-section-tabs device-section-subtabs" role="tablist" aria-label="Vista de sincronización">
      {DEVICE_SYNC_SUBTABS.map(tab => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={`device-section-tab ${active === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          <Icon name={tab.icon} size={14} />
          {tab.label}
        </button>
      ))}
    </nav>
  )
}

function DeviceSyncStatusBar({ withFloatingPlayer }: { withFloatingPlayer: boolean }) {
  const devices = useDeviceStore(s => s.devices)
  const scanProgress = useDeviceStore(s => s.scanProgress)
  const syncProgress = useDeviceStore(s => s.syncProgress)
  const progress = syncProgress ?? scanProgress
  if (!progress) return null

  const device = devices.find(item => item.id === progress.deviceId)
  const total = Math.max(progress.total, 0)
  const completed = syncProgress ? syncProgress.completed : scanProgress?.scanned ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
  const phase = DEVICE_SYNC_PHASE_LABELS[progress.phase] ?? progress.phase
  const currentPath = syncProgress?.currentPath

  return (
    <div className={`device-sync-status-bar ${withFloatingPlayer ? 'with-player' : ''}`}>
      <Icon name="sync" size={15} />
      <div className="device-sync-status-main">
        <strong>{device?.name ?? 'Dispositivo'}</strong>
        <span>{phase}{currentPath ? ` · ${currentPath}` : ''}</span>
      </div>
      <div className="device-sync-status-track" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>
      <span className="mono">{total > 0 ? `${completed}/${total}` : '...'}</span>
    </div>
  )
}

function DeviceVolumePrompt({
  defaultArtworkMaxEdge,
  onOpenDevice,
}: {
  defaultArtworkMaxEdge: number
  onOpenDevice: (deviceId: string) => void
}) {
  const unknownVolumes = useDeviceStore(s => s.unknownVolumes)
  const ignoreVolume = useDeviceStore(s => s.ignoreVolume)
  const addFolder = useLibraryStore(s => s.addFolder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectTarget, setConnectTarget] = useState<DeviceConnectTarget | null>(null)
  const volume = unknownVolumes[0]
  if (!volume) return null

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="device-volume-prompt">
      <Icon name="folder" size={18} />
      <div className="device-volume-prompt-main">
        <strong>Nuevo volumen detectado</strong>
        <span title={volume.rootPath}>{volume.name} · {volume.rootPath}</span>
        {error && <em>{error}</em>}
      </div>
      <div className="device-volume-prompt-actions">
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={() => setConnectTarget({ rootPath: volume.rootPath, name: volume.name })}
        >
          DAP
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => {
            void run(async () => {
              await addFolder(volume.rootPath)
              await ignoreVolume(volume.rootPath)
            })
          }}
        >
          Biblioteca
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => { void run(() => ignoreVolume(volume.rootPath)) }}
        >
          Ignorar
        </button>
      </div>
      {connectTarget && (
        <DeviceConnectModal
          target={connectTarget}
          artworkMaxEdge={defaultArtworkMaxEdge}
          onConnected={device => onOpenDevice(device.id)}
          onClose={() => setConnectTarget(null)}
        />
      )}
    </div>
  )
}

export default function App() {
  const [tweak, setTweak] = useTweaks()
  const [history, setHistory] = useState<View[]>([{ kind: 'library' }])
  const [idx, setIdx] = useState(0)
  const [expanded, setExpanded] = useState(false)
  // Active sub-tab of the device Sync section, rendered as the navbar's second
  // row. Lifted here so the top chrome owns it; reset per device below.
  const [syncTab, setSyncTab] = useState<DeviceSyncTab>('sync')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchScope, setSearchScope] = useState<'global' | 'view'>('view')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [playerPaneOpen, setPlayerPaneOpen] = useState(() =>
    loadPersistedBool(PLAYER_PANE_OPEN_STORAGE_KEY, true)
  )
  const [lyricsSidePaneOpen, setLyricsSidePaneOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    loadPersistedWidth(SIDEBAR_WIDTH_STORAGE_KEY, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
  )
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const sidebarWidthRef = useRef(sidebarWidth)
  const [lyricsSideWidth, setLyricsSideWidth] = useState(() =>
    loadPersistedWidth(LYRICS_SIDE_WIDTH_STORAGE_KEY, LYRICS_SIDE_WIDTH_DEFAULT, LYRICS_SIDE_WIDTH_MIN, LYRICS_SIDE_WIDTH_MAX)
  )
  const [isResizingLyricsSide, setIsResizingLyricsSide] = useState(false)
  const lyricsSideWidthRef = useRef(lyricsSideWidth)
  const contentRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const scrollPositionsRef = useRef(new Map<number, number>())
  const view = history[idx]
  // Default the Sync sub-tab back to Sincronización whenever the open device
  // changes, so each device starts on its primary view.
  const deviceViewId = view.kind === 'device' ? view.deviceId : null
  useEffect(() => {
    setSyncTab('sync')
  }, [deviceViewId])
  const viewAlbum = view.kind === 'album' ? view.album : null
  const viewAlbumId = viewAlbum?.id
  const viewAlbumTrackCount = viewAlbum?.tracks.length ?? 0
  const viewAlbumFallbackTint = viewAlbum?.palette[1] ?? null
  const viewAlbumArtworkPath = viewAlbum?.artworkPath ?? null

  const listPrefs = useListPrefsStore(s => s.listPrefs)
  const rawSetListPrefs = useListPrefsStore(s => s.setListPrefs)

  const refresh = useLibraryStore(s => s.refresh)
  const loaded = useLibraryStore(s => s.loaded)
  const loadPendingDeviceJournals = useDeviceStore(s => s.loadPendingJournals)
  const refreshDeviceVolumes = useDeviceStore(s => s.refreshVolumes)
  const scanProgress = useDeviceStore(s => s.scanProgress)
  const syncProgress = useDeviceStore(s => s.syncProgress)
  const nowTrack = usePlaybackStore(s => s.currentTrack)
  const playbackStatus = usePlaybackStore(s => s.status)
  const nowAlbum = useAlbumByUiId(nowTrack?.albumId)
  const viewedAlbum = useAlbumByUiId(viewAlbumId)
  const favoriteTracks = useFavoriteTracks()
  const canShowPlayerPane = nowTrack != null && !expanded
  const isPlayerPaneOpen = playerPaneOpen && canShowPlayerPane
  const showLyricsSidePane = lyricsSidePaneOpen && canShowPlayerPane
  const showBottomPlayer = !isPlayerPaneOpen && canShowPlayerPane
  const [playerPaneVisible, setPlayerPaneVisible] = useState(() => isPlayerPaneOpen)
  const [lyricsSidePaneVisible, setLyricsSidePaneVisible] = useState(false)
  const [lyricsSidePaneClosing, setLyricsSidePaneClosing] = useState(false)
  const [bottomPlayerVisible, setBottomPlayerVisible] = useState(false)
  const [bottomPlayerClosing, setBottomPlayerClosing] = useState(false)
  const isBottomPlayerClosing = bottomPlayerVisible && !showBottomPlayer
  const [playingTint, setPlayingTint] = useState<string | null>(null)
  const [albumTint, setAlbumTint] = useState<string | null>(null)
  const playingArtworkPath = nowAlbum?.artworkPath ?? nowTrack?.artworkPath ?? null
  const isPlaying = playbackStatus === 'playing'
  const deviceProgressVisible = scanProgress != null || syncProgress != null

  // Which listPrefs key corresponds to the current view for contextual search.
  // Views that don't support text filtering (album detail, artist detail, recent,
  // settings, etc.) return null and the scope toggle is hidden.
  const currentViewQueryKind = (() => {
    switch (view.kind) {
      case 'library': return 'library' as const
      case 'albums': return 'albums' as const
      case 'artists': return 'artists' as const
      case 'genres': return 'genres' as const
      case 'playlist': return 'playlist' as const
      case 'favoriteTracks': return 'favoriteTracks' as const
      default: return null
    }
  })()
  const viewQueryable = currentViewQueryKind !== null
  const viewQuery = currentViewQueryKind ? (listPrefs[currentViewQueryKind].query ?? '') : ''
  const setViewQuery = (q: string) => {
    if (currentViewQueryKind) rawSetListPrefs(currentViewQueryKind, { query: q })
  }

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
  }, [sidebarWidth])

  useEffect(() => {
    lyricsSideWidthRef.current = lyricsSideWidth
  }, [lyricsSideWidth])

  useEffect(() => {
    try {
      window.localStorage.setItem(PLAYER_PANE_OPEN_STORAGE_KEY, String(playerPaneOpen))
    } catch { /* ignore */ }
  }, [playerPaneOpen])

  useEffect(() => {
    if (showBottomPlayer) {
      setBottomPlayerVisible(true)
      setBottomPlayerClosing(false)
      return
    }

    if (!bottomPlayerVisible) return

    setBottomPlayerClosing(true)
    const timeout = window.setTimeout(() => {
      setBottomPlayerVisible(false)
      setBottomPlayerClosing(false)
    }, PB_PLAYER_EXIT_MS)

    return () => window.clearTimeout(timeout)
  }, [showBottomPlayer, bottomPlayerVisible])

  useEffect(() => {
    if (isPlayerPaneOpen) {
      setPlayerPaneVisible(true)
      return
    }

    if (!playerPaneVisible) return

    const timeout = window.setTimeout(() => {
      setPlayerPaneVisible(false)
    }, PLAYER_PANE_EXIT_MS)

    return () => window.clearTimeout(timeout)
  }, [isPlayerPaneOpen, playerPaneVisible])

  useEffect(() => {
    if (showLyricsSidePane) {
      setLyricsSidePaneVisible(true)
      setLyricsSidePaneClosing(false)
      return
    }

    if (!lyricsSidePaneVisible) return

    setLyricsSidePaneClosing(true)
    const timeout = window.setTimeout(() => {
      setLyricsSidePaneVisible(false)
      setLyricsSidePaneClosing(false)
    }, LYRICS_SIDE_PANE_EXIT_MS)

    return () => window.clearTimeout(timeout)
  }, [showLyricsSidePane, lyricsSidePaneVisible])

  useEffect(() => {
    if (nowTrack == null && lyricsSidePaneOpen) setLyricsSidePaneOpen(false)
  }, [nowTrack, lyricsSidePaneOpen])

  // Kick off the first library load when the renderer is ready.
  useEffect(() => {
    if (!loaded) refresh()
  }, [loaded, refresh])

  useEffect(() => {
    void loadPendingDeviceJournals()
    void refreshDeviceVolumes()
  }, [loadPendingDeviceJournals, refreshDeviceVolumes])

  useEffect(() => installAutoHideScrollbars(), [])

  const saveCurrentScroll = () => {
    const el = contentRef.current
    if (!el) return
    scrollPositionsRef.current.set(idx, el.scrollTop)
  }

  const navigate = (v: View, { replace = false }: { replace?: boolean } = {}) => {
    saveCurrentScroll()

    if (replace) {
      const h = [...history]
      h[idx] = v
      scrollPositionsRef.current.set(idx, 0)
      setHistory(h)
      return
    }
    const trimmed = history.slice(0, idx + 1)
    const nextIdx = trimmed.length
    for (const key of scrollPositionsRef.current.keys()) {
      if (key >= nextIdx) scrollPositionsRef.current.delete(key)
    }
    scrollPositionsRef.current.set(nextIdx, 0)
    setHistory([...trimmed, v])
    setIdx(nextIdx)
  }

  const goBack = () => {
    if (idx <= 0) return
    saveCurrentScroll()
    setIdx(idx - 1)
  }

  const goForward = () => {
    if (idx >= history.length - 1) return
    saveCurrentScroll()
    setIdx(idx + 1)
  }

  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    const top = scrollPositionsRef.current.get(idx) ?? 0
    const frame = window.requestAnimationFrame(() => {
      el.scrollTo({ top, behavior: 'auto' })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [idx, view])

  // Body class management (theme + density + layout).
  useEffect(() => {
    const cls = [
      tweak.dark ? '' : 'theme-light',
      `density-${tweak.density}`,
      `layout-${tweak.layout}`,
      tweak.layout === 'editorial' ? 'editorial' : '',
      tweak.layout === 'dense' ? 'dense' : '',
    ]
      .filter(Boolean)
      .join(' ')
    document.body.className = cls
  }, [tweak])

  // Extract dominant color from the currently playing album's artwork (with
  // track artwork as fallback). Vivified so quiet covers still produce a
  // visibly saturated tint.
  useEffect(() => {
    if (!playingArtworkPath) { setPlayingTint(null); return }
    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(playingArtworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled) setPlayingTint(vivify(hex))
    })
    return () => { cancelled = true }
  }, [playingArtworkPath])

  // Global background tint: when an album is open it follows the album being
  // viewed; otherwise it falls back to the currently playing track. When
  // neither applies the chrome returns to its neutral base.
  useEffect(() => {
    const root = document.documentElement
    const viewedTint = viewAlbum ? (albumTint ?? vivify(viewAlbumFallbackTint)) : null
    const next = viewedTint ?? (isPlaying ? playingTint : null)
    if (next) {
      root.style.setProperty('--bg-tint', next)
    } else {
      root.style.removeProperty('--bg-tint')
    }
  }, [viewAlbum, albumTint, viewAlbumFallbackTint, playingTint, isPlaying])

  // Propagate --np-tint to :root so both the player pane and the lyrics side
  // pane share the same artwork-based tint. PlayerPane's own inline style
  // continues to override on that element (same value), while LyricsSidePane
  // picks up this global value since it's a DOM sibling, not a descendant.
  useEffect(() => {
    const root = document.documentElement
    const tint =
      tweak.playerTintSource === 'artwork' ? playingTint
      : (tweak.playerTintSource === 'preset' || tweak.playerTintSource === 'custom') ? tweak.playerTintColor
      : null
    if (tint) {
      root.style.setProperty('--np-tint', tint)
    } else {
      root.style.removeProperty('--np-tint')
    }
  }, [tweak.playerTintSource, tweak.playerTintColor, playingTint])

  // If the open album becomes empty after deletion, return to previous view.
  useEffect(() => {
    if (!viewAlbum || idx <= 0) return

    const currentCount = viewedAlbum?.tracks.length ?? 0
    if (currentCount === 0) {
      goBack()
      return
    }

    if (viewedAlbum == null && viewAlbumTrackCount === 0) {
      goBack()
    }
  }, [viewAlbum, idx, viewedAlbum?.tracks.length, viewedAlbum, viewAlbumTrackCount])

  // Album view tint follows the album being shown (independent of playback).
  // Vivified so it lands in the same saturated/mid-lightness range as the
  // playing-track tint.
  useEffect(() => {
    if (!viewAlbum) {
      setAlbumTint(null)
      return
    }

    setAlbumTint(vivify(viewAlbumFallbackTint))

    if (!viewAlbumArtworkPath) return

    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(viewAlbumArtworkPath)}`
    void extractDominantColor(src).then(hex => {
      const tint = vivify(hex)
      if (!cancelled && tint) setAlbumTint(tint)
    })

    return () => {
      cancelled = true
    }
  }, [viewAlbum, viewAlbumArtworkPath, viewAlbumFallbackTint])

  const sidebarKey = (() => {
    switch (view.kind) {
      case 'library':   return 'songs'
      case 'albums':    return 'albums'
      case 'artists':   return 'artists'
      case 'genres':    return 'genres'
      case 'recent':    return 'recent'
      case 'playlist':  return 'pl-' + view.playlist.id
      case 'artist':    return 'ar-' + view.artist.id
      case 'favoriteTracks': return 'pfavorites'
      case 'devices': return 'devices'
      case 'device': return `dev-${view.deviceId}-${view.section}`
      default:          return null
    }
  })()

  const beginSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarOpen) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)

    const onMove = (e: globalThis.PointerEvent) => {
      const frame = frameRef.current
      if (!frame) return
      const rect = frame.getBoundingClientRect()
      const nextWidth = clamp(Math.round(e.clientX - rect.left), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
      sidebarWidthRef.current = nextWidth
      setSidebarWidth(nextWidth)
    }

    const stop = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', stop)
      document.body.style.userSelect = ''
      setIsResizingSidebar(false)

      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidthRef.current))
      } catch { /* ignore */ }
    }

    setIsResizingSidebar(true)
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', stop)
  }

  const beginLyricsSideResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!showLyricsSidePane) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)

    const onMove = (e: globalThis.PointerEvent) => {
      const frame = frameRef.current
      if (!frame) return
      const rect = frame.getBoundingClientRect()
      const nextWidth = clamp(Math.round(rect.right - e.clientX), LYRICS_SIDE_WIDTH_MIN, LYRICS_SIDE_WIDTH_MAX)
      lyricsSideWidthRef.current = nextWidth
      setLyricsSideWidth(nextWidth)
    }

    const stop = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', stop)
      document.body.style.userSelect = ''
      setIsResizingLyricsSide(false)

      try {
        window.localStorage.setItem(LYRICS_SIDE_WIDTH_STORAGE_KEY, String(lyricsSideWidthRef.current))
      } catch { /* ignore */ }
    }

    setIsResizingLyricsSide(true)
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', stop)
  }

  function renderContent() {
    switch (view.kind) {
      case 'library':
        return <LibraryView />
      case 'recent':
        return <AlbumsView mode="recent" onSelect={al => navigate({ kind: 'album', album: al })} />
      case 'albums':
        return <AlbumsView onSelect={al => navigate({ kind: 'album', album: al })} />
      case 'album':
        return <AlbumView album={view.album} />
      case 'artists':
        return <ArtistsView onSelect={ar => navigate({ kind: 'artist', artist: ar })} />
      case 'artist':
        return (
          <ArtistView
            artist={view.artist}
            onSelectAlbum={al => navigate({ kind: 'album', album: al })}
          />
        )
      case 'favoriteTracks':
        return (
          <PlaylistView
            kind="favoriteTracks"
            playlist={{
              id: 'pfavorites',
              name: 'Temas favoritos',
              count: favoriteTracks.length,
              kind: 'smart',
              icon: 'heartF',
              tracks: favoriteTracks,
            }}
          />
        )
      case 'playlist':
        return <PlaylistView kind="playlist" playlist={view.playlist} />
      case 'search':
        return (
          <SearchView
            query={searchQuery}
            onSelectAlbum={al => navigate({ kind: 'album', album: al })}
            onSelectArtist={ar => navigate({ kind: 'artist', artist: ar })}
          />
        )
      case 'settings':
        return <SettingsView tweak={tweak} setTweak={setTweak} />
      case 'import':
        return <ImportView />
      case 'devices':
        return <DevicesView />
      case 'device':
        if (view.section === 'dashboard') return <DevicesView deviceId={view.deviceId} />
        if (view.section === 'sync') return <DeviceSyncView deviceId={view.deviceId} syncTab={syncTab} onSyncTabChange={setSyncTab} />
        return <DeviceLibraryView deviceId={view.deviceId} section={view.section} />
      case 'genres':
        return <GenresView onSelectAlbum={al => navigate({ kind: 'album', album: al })} />
      default:
        return <LibraryView />
    }
  }

  return (
    <div className="desktop">
      <div className="window">
        <div
          ref={frameRef}
          className={`frame ${isResizingSidebar ? 'layout-resizing-sidebar' : ''} ${isResizingLyricsSide ? 'layout-resizing-lyrics-side' : ''}`}
          style={{
            '--sb-w': `${sidebarWidth}px`,
          } as CSSProperties}
        >
          <Sidebar
            setView={navigate}
            selectedKey={sidebarKey}
            isOpen={sidebarOpen}
            translucent={tweak.translucent}
            onSelectPlaylist={pl => navigate({ kind: 'playlist', playlist: pl })}
            onSelectArtist={ar => navigate({ kind: 'artist', artist: ar })}
            onSelectFavoriteTracks={() => navigate({ kind: 'favoriteTracks' })}
            favoriteTracksCount={favoriteTracks.length}
          />

          {sidebarOpen && (
            <div
              className={`layout-resize-handle sidebar-resize-handle ${isResizingSidebar ? 'active' : ''}`}
              style={{ left: `${sidebarWidth}px` }}
              onPointerDown={beginSidebarResize}
              aria-hidden
            />
          )}

          <div className={`main-area ${sidebarOpen ? 'with-sidebar' : 'without-sidebar'} ${bottomPlayerVisible ? 'with-floating-player' : ''} ${deviceProgressVisible ? 'with-device-sync' : ''}`}>
            <Toolbar
              view={view}
              history={history}
              idx={idx}
              onBack={goBack}
              onForward={goForward}
              onNavigate={navigate}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              searchScope={searchScope}
              onSearchScopeChange={setSearchScope}
              viewQuery={viewQuery}
              onViewQueryChange={setViewQuery}
              viewQueryable={viewQueryable}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen(open => !open)}
              playerPaneOpen={isPlayerPaneOpen}
              canTogglePlayerPane={canShowPlayerPane}
              onTogglePlayerPane={() => setPlayerPaneOpen(open => !open)}
            />
            {view.kind === 'device' && (
              <DeviceSectionTabs
                deviceId={view.deviceId}
                section={view.section}
                onNavigate={navigate}
              />
            )}
            {view.kind === 'device' && view.section === 'sync' && (
              <DeviceSyncSubTabs active={syncTab} onChange={setSyncTab} />
            )}
            <div
              ref={contentRef}
              className="content"
            >
              {renderContent()}
            </div>
            <DeviceSyncStatusBar withFloatingPlayer={bottomPlayerVisible} />
            <DeviceVolumePrompt
              defaultArtworkMaxEdge={tweak.deviceArtworkMaxEdge}
              onOpenDevice={deviceId => navigate({ kind: 'device', deviceId, section: 'dashboard' })}
            />
          </div>

          {playerPaneVisible && (
            <PlayerPane
              isOpen={isPlayerPaneOpen}
              onExpand={() => {
                setLyricsSidePaneOpen(false)
                setExpanded(true)
              }}
              onCollapse={() => {
                setPlayerPaneOpen(false)
              }}
              lyricsSidePaneOpen={lyricsSidePaneOpen && canShowPlayerPane}
              onToggleLyricsSidePane={() => setLyricsSidePaneOpen(open => !open)}
              onOpenAlbum={album => navigate({ kind: 'album', album })}
              onOpenArtist={artist => navigate({ kind: 'artist', artist })}
            />
          )}

          {showLyricsSidePane && playerPaneVisible && (
            <div
              className={`layout-resize-handle lyrics-side-resize-handle ${isResizingLyricsSide ? 'active' : ''}`}
              style={{ right: `${lyricsSideWidth}px` }}
              onPointerDown={beginLyricsSideResize}
              aria-hidden
            />
          )}

          {lyricsSidePaneVisible && (
            <LyricsSidePane
              closing={lyricsSidePaneClosing || !showLyricsSidePane}
              width={lyricsSideWidth}
              onClose={() => setLyricsSidePaneOpen(false)}
            />
          )}

          {!expanded && bottomPlayerVisible && !isBottomPlayerClosing && <UpNextToast variant="bottom" />}

          {bottomPlayerVisible && (
            <PlayerBottomBar
              closing={isBottomPlayerClosing || bottomPlayerClosing}
              onExpand={() => {
                setLyricsSidePaneOpen(false)
                setExpanded(true)
              }}
              onShowPanel={() => setPlayerPaneOpen(true)}
              lyricsSidePaneOpen={lyricsSidePaneOpen && canShowPlayerPane}
              onToggleLyricsSidePane={() => setLyricsSidePaneOpen(open => !open)}
              onOpenAlbum={album => navigate({ kind: 'album', album })}
              onOpenArtist={artist => navigate({ kind: 'artist', artist })}
            />
          )}
        </div>

        {expanded && nowTrack && (
          <NowPlayingFull onCollapse={() => setExpanded(false)} />
        )}

        <LyricsCandidates />
      </div>
    </div>
  )
}
