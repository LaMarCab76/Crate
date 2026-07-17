import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { Album, Artist, Playlist } from '@shared/types/library'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { Icon, type IconName } from './components/Icon'
import { PlayerPane } from './components/PlayerPane'
import { PlayerBottomBar } from './components/PlayerBottomBar'
import { LyricsSidePane } from './components/LyricsSidePane'
import { UpNextToast } from './components/UpNextToast'
import { NowPlayingFull } from './components/NowPlayingFull'
import { LyricsCandidates } from './components/LyricsCandidates'
import { ActivityCenter } from './components/ActivityCenter'
import { DeviceConnectModal, type DeviceConnectTarget } from './components/DeviceConnectModal'
import { LibrarySetupWizard } from './components/LibrarySetupWizard'
import { LibraryView } from './views/LibraryView'
import { AlbumsView } from './views/AlbumsView'
import { AlbumView } from './views/AlbumView'
import { ArtistsView } from './views/ArtistsView'
import { ArtistView } from './views/ArtistView'
import { PlaylistView } from './views/PlaylistView'
import { SearchView } from './views/SearchView'
import { SettingsView, type PlaybackSubTab, type SettingsMainTab } from './views/SettingsView'
import { ImportView } from './views/ImportView'
import { GenresView } from './views/GenresView'
import { DownloadsView } from './views/DownloadsView'
import { DevicesView, type DeviceDashboardTab } from './views/DevicesView'
import { DeviceSyncView, type DeviceSyncTab } from './views/DeviceSyncView'
import { DeviceLibraryView, type DeviceLibrarySection } from './views/DeviceLibraryView'
import { MetadataFixView } from './views/MetadataFixView'
import { useTweaks, useListPrefsStore } from './stores/settingsStore'
import { useMetadataFixIntent, useNavIntentStore } from './stores/navIntentStore'
import { useAlbumByUiId, useFavoriteTracks, useLibraryStore } from './stores/libraryStore'
import { usePlaybackStore } from './stores/playbackStore'
import { useDeviceStore } from './stores/deviceStore'
import { useLibraryLocationsStore } from './stores/libraryLocationsStore'
import { useMigrationStore } from './stores/migrationStore'
import {
  isActiveActivityStatus,
  useActivityCenterStore,
  type ActivityActionId,
  type ActivityItem,
} from './stores/activityCenterStore'
import { installAutoHideScrollbars } from './utils/autoHideScrollbars'
import { extractDominantColor, extractPalette } from './utils/colorExtract'
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
  | { kind: 'downloads' }
  | { kind: 'devices' }
  | { kind: 'device'; deviceId: string; section: 'dashboard' | 'sync' | DeviceLibrarySection }
  | { kind: 'album'; album: Album }
  | { kind: 'artist'; artist: Artist }
  | { kind: 'playlist'; playlist: Playlist }
  | { kind: 'favoriteTracks' }
  | { kind: 'metadataFix'; trackIds: number[]; title?: string; missingCount?: number }

const SIDEBAR_WIDTH_STORAGE_KEY = 'crate.layout.sidebarWidth.v1'
const PLAYER_PANE_OPEN_STORAGE_KEY = 'crate.layout.playerPaneOpen.v1'
const PLAYER_PANE_EXIT_MS = 280
// Matches the .player-dock grid-template-rows collapse transition (globals.css)
// so the docked bar finishes animating its height before it unmounts. Kept in
// sync with PLAYER_PANE_EXIT_MS so the horizontal↔lateral swap feels coordinated.
const PB_PLAYER_EXIT_MS = 280
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

type DeviceSectionKey = 'dashboard' | 'sync' | DeviceLibrarySection
type DeviceNavbarSubTab<Key extends string> = { key: Key; label: string; icon: IconName }

function DeviceNavbarSubTabs<Key extends string>({
  tabs,
  active,
  ariaLabel,
  onChange,
  variant = 'secondary',
}: {
  tabs: Array<DeviceNavbarSubTab<Key>>
  active: Key
  ariaLabel: string
  onChange: (tab: Key) => void
  variant?: 'primary' | 'secondary'
}) {
  return (
    <nav
      className={variant === 'secondary' ? 'device-section-tabs device-section-subtabs' : 'device-section-tabs'}
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map(tab => (
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

const DEVICE_DASHBOARD_SUBTABS: Array<DeviceNavbarSubTab<DeviceDashboardTab>> = [
  { key: 'overview', label: 'Resumen', icon: 'device' },
  { key: 'activity', label: 'Actividad', icon: 'recent' },
]

const DEVICE_SYNC_SUBTABS: Array<DeviceNavbarSubTab<DeviceSyncTab>> = [
  { key: 'sync', label: 'Sincronización', icon: 'sync' },
  { key: 'optimize', label: 'Optimizar', icon: 'sparkle' },
  { key: 'config', label: 'Configuración', icon: 'sliders' },
]

const SETTINGS_TABS: Array<DeviceNavbarSubTab<SettingsMainTab>> = [
  { key: 'apariencia', label: 'Apariencia', icon: 'moon' },
  { key: 'reproduccion', label: 'Reproducción', icon: 'play' },
  { key: 'bibliotecas', label: 'Bibliotecas', icon: 'folder' },
  { key: 'actualizaciones', label: 'Actualizaciones', icon: 'sync' },
]

const SETTINGS_PLAYBACK_SUBTABS: Array<DeviceNavbarSubTab<PlaybackSubTab>> = [
  { key: 'general', label: 'Reproducción', icon: 'play' },
  { key: 'eq', label: 'Eq', icon: 'sliders' },
  { key: 'letras', label: 'Letras', icon: 'lyrics' },
]

function SettingsSectionTabs({
  active,
  onChange,
}: {
  active: SettingsMainTab
  onChange: (tab: SettingsMainTab) => void
}) {
  return (
    <nav className="device-section-tabs settings-section-tabs" role="tablist" aria-label="Secciones de preferencias">
      {SETTINGS_TABS.map(tab => (
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

export default function App() {
  const [tweak, setTweak] = useTweaks()
  const [history, setHistory] = useState<View[]>([{ kind: 'library' }])
  const [idx, setIdx] = useState(0)
  const [expanded, setExpanded] = useState(false)
  // Active sub-tabs rendered as the device navbar's second row. Lifted here so
  // the top chrome owns them; reset per device below.
  const [dashboardTab, setDashboardTab] = useState<DeviceDashboardTab>('overview')
  const [syncTab, setSyncTab] = useState<DeviceSyncTab>('sync')
  const [settingsTab, setSettingsTab] = useState<SettingsMainTab>('apariencia')
  const [settingsPlaybackTab, setSettingsPlaybackTab] = useState<PlaybackSubTab>('general')
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
  // Default device sub-tabs back to their primary views whenever the open device
  // changes.
  const deviceViewId = view.kind === 'device' ? view.deviceId : null
  useEffect(() => {
    setDashboardTab('overview')
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
  const addFolder = useLibraryStore(s => s.addFolder)
  const libraryLocations = useLibraryLocationsStore(s => s.locations)
  const locationsInitialized = useLibraryLocationsStore(s => s.initialized)
  const locationsError = useLibraryLocationsStore(s => s.error)
  const loadLibraryLocations = useLibraryLocationsStore(s => s.load)
  const loadMigrations = useMigrationStore(s => s.load)
  const subscribeMigrations = useMigrationStore(s => s.subscribe)
  const loadPendingDeviceJournals = useDeviceStore(s => s.loadPendingJournals)
  const refreshDeviceVolumes = useDeviceStore(s => s.refreshVolumes)
  const ignoreVolume = useDeviceStore(s => s.ignoreVolume)
  const selectedDeviceId = useDeviceStore(s => s.selectedDeviceId)
  const activityItems = useActivityCenterStore(s => s.items)
  const activityOpen = useActivityCenterStore(s => s.open)
  const activityPinned = useActivityCenterStore(s => s.pinned)
  const activityFullscreen = useActivityCenterStore(s => s.fullscreen)
  const toggleActivityPanel = useActivityCenterStore(s => s.togglePanel)
  const closeActivityPanel = useActivityCenterStore(s => s.closePanel)
  const setActivityPinned = useActivityCenterStore(s => s.setPinned)
  const setActivityFullscreen = useActivityCenterStore(s => s.setFullscreen)
  const markActivityRead = useActivityCenterStore(s => s.markAllRead)
  const clearResolvedActivity = useActivityCenterStore(s => s.clearResolved)
  const completeActivity = useActivityCenterStore(s => s.completeActivity)
  const upsertActivity = useActivityCenterStore(s => s.upsert)
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
  const [bottomPlayerEntering, setBottomPlayerEntering] = useState(false) // crecimiento (lateral → horizontal) en curso
  const [bottomPlayerPriming, setBottomPlayerPriming] = useState(false)   // primer frame del crecimiento: arranca colapsado
  const isBottomPlayerClosing = bottomPlayerVisible && !showBottomPlayer
  const [playingTint, setPlayingTint] = useState<string | null>(null)
  const [playingPalette, setPlayingPalette] = useState<string[] | null>(null)
  const [albumTint, setAlbumTint] = useState<string | null>(null)
  const [albumPalette, setAlbumPalette] = useState<string[] | null>(null)
  const [connectTarget, setConnectTarget] = useState<DeviceConnectTarget | null>(null)
  const [setupWizardOpen, setSetupWizardOpen] = useState(false)
  const setupDecisionMadeRef = useRef(false)
  const playingArtworkPath = nowAlbum?.artworkPath ?? nowTrack?.artworkPath ?? null
  const isPlaying = playbackStatus === 'playing'
  // The color the player chrome (--np-tint) is currently showing: dominant
  // artwork color in 'artwork' mode, the assigned preset/custom color otherwise.
  // Surfaces that lack their own artwork can borrow this so the app accent stays
  // coherent with what's playing instead of jumping to a synthetic hue.
  const playerCurrentTint = useMemo(() => (
    tweak.playerTintSource === 'artwork' ? playingTint
    : (tweak.playerTintSource === 'preset' || tweak.playerTintSource === 'custom') ? tweak.playerTintColor
    : null
  ), [tweak.playerTintSource, tweak.playerTintColor, playingTint])
  const activityActiveCount = activityItems.filter(item => isActiveActivityStatus(item.status)).length
  const activityUnreadCount = activityItems.filter(item => !item.read).length

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
      if (!bottomPlayerVisible) {
        // Montaje fresco (lateral → horizontal): animar el crecimiento.
        setBottomPlayerVisible(true)
        setBottomPlayerEntering(true)
        setBottomPlayerPriming(true)
      }
      // Reabrir durante el cierre: revierte el colapso sin re-disparar el crecimiento.
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

  // Quita 'priming' tras pintar el frame colapsado (doble rAF) → dispara la
  // transición 0fr → 1fr y el fade/slide de entrada de la barra.
  useEffect(() => {
    if (!bottomPlayerPriming) return
    const inner = { id: 0 }
    const outer = requestAnimationFrame(() => {
      inner.id = requestAnimationFrame(() => setBottomPlayerPriming(false))
    })
    return () => {
      cancelAnimationFrame(outer)
      if (inner.id) cancelAnimationFrame(inner.id)
    }
  }, [bottomPlayerPriming])

  // Limpia 'entering' cuando el crecimiento terminó, devolviendo overflow visible
  // (para que los tiempos del hover de progreso no queden recortados en reposo).
  useEffect(() => {
    if (!bottomPlayerEntering) return
    const timeout = window.setTimeout(() => setBottomPlayerEntering(false), PB_PLAYER_EXIT_MS + 60)
    return () => window.clearTimeout(timeout)
  }, [bottomPlayerEntering])

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
    void loadLibraryLocations()
  }, [loadLibraryLocations])

  useEffect(() => {
    void loadMigrations()
    return subscribeMigrations()
  }, [loadMigrations, subscribeMigrations])

  // Decide once from the persisted location list. This avoids flashing the
  // wizard before IPC responds and never interrupts an already configured user.
  useEffect(() => {
    if (setupDecisionMadeRef.current || !locationsInitialized || locationsError) return
    setupDecisionMadeRef.current = true
    if (!libraryLocations.some(location => location.role === 'library')) {
      setSetupWizardOpen(true)
    }
  }, [libraryLocations, locationsError, locationsInitialized])

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

  // Deeply nested triggers (metadata banners, track/album context menus) route to
  // the metadata-fix view by writing an intent here; consume it once and navigate.
  const metadataFixIntent = useMetadataFixIntent()
  const clearMetadataFix = useNavIntentStore(s => s.clearMetadataFix)
  useEffect(() => {
    if (!metadataFixIntent) return
    navigate({
      kind: 'metadataFix',
      trackIds: metadataFixIntent.trackIds,
      title: metadataFixIntent.title,
      missingCount: metadataFixIntent.missingCount,
    })
    clearMetadataFix()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadataFixIntent])

  const goForward = () => {
    if (idx >= history.length - 1) return
    saveCurrentScroll()
    setIdx(idx + 1)
  }

  const finishActivityNavigation = () => {
    if (activityFullscreen) setActivityFullscreen(false)
    if (!activityPinned) closeActivityPanel()
  }

  const openSettingsFromActivity = (tab: SettingsMainTab, playbackTab?: PlaybackSubTab) => {
    setSettingsTab(tab)
    if (playbackTab) setSettingsPlaybackTab(playbackTab)
    navigate({ kind: 'settings' }, { replace: view.kind === 'settings' })
    finishActivityNavigation()
  }

  const activityError = (item: ActivityItem, err: unknown) => {
    upsertActivity({
      id: item.id,
      category: item.category,
      status: 'error',
      title: item.title,
      detail: err instanceof Error ? err.message : String(err),
      metadata: item.metadata,
      actionIds: item.actionIds,
    })
  }

  const handleActivityAction = async (actionId: ActivityActionId, item: ActivityItem) => {
    const deviceId = typeof item.metadata.deviceId === 'string' ? item.metadata.deviceId : null
    const rootPath = typeof item.metadata.rootPath === 'string' ? item.metadata.rootPath : null
    const pathToken = typeof item.metadata.pathToken === 'string' ? item.metadata.pathToken : null
    const volumeName = typeof item.metadata.volumeName === 'string' ? item.metadata.volumeName : undefined

    switch (actionId) {
      case 'open-device':
        if (deviceId) {
          navigate({ kind: 'device', deviceId, section: 'dashboard' })
          finishActivityNavigation()
        }
        break
      case 'open-device-sync':
        if (deviceId) {
          navigate({ kind: 'device', deviceId, section: 'sync' })
          finishActivityNavigation()
        }
        break
      case 'open-libraries':
        openSettingsFromActivity('bibliotecas')
        break
      case 'open-lyrics-settings':
        openSettingsFromActivity('reproduccion', 'letras')
        break
      case 'open-downloads':
        navigate({ kind: 'downloads' })
        finishActivityNavigation()
        break
      case 'open-import':
        navigate({ kind: 'import' })
        finishActivityNavigation()
        break
      case 'open-updates':
        openSettingsFromActivity('actualizaciones')
        break
      case 'connect-device':
        if (rootPath && pathToken) {
          setActivityFullscreen(false)
          setConnectTarget({ token: pathToken, displayPath: rootPath, name: volumeName })
        }
        break
      case 'add-library':
        if (!pathToken) break
        try {
          await addFolder(pathToken)
          await refreshDeviceVolumes()
          completeActivity(item.id, 'Volumen agregado como biblioteca.')
        } catch (err) {
          activityError(item, err)
        }
        break
      case 'ignore-volume':
        if (!pathToken) break
        try {
          await ignoreVolume(pathToken)
          completeActivity(item.id, 'Volumen ignorado.')
        } catch (err) {
          activityError(item, err)
        }
        break
    }
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
    if (!playingArtworkPath) { setPlayingTint(null); setPlayingPalette(null); return }
    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(playingArtworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled) setPlayingTint(vivify(hex))
    })
    void extractPalette(src, 3).then(palette => {
      if (!cancelled) setPlayingPalette(palette)
    })
    return () => { cancelled = true }
  }, [playingArtworkPath])

  // Global background tint: when an album is open it follows the album being
  // viewed; otherwise it falls back to the currently playing track. When
  // neither applies the chrome returns to its neutral base.
  useEffect(() => {
    const root = document.documentElement
    const viewedTint = viewAlbum ? (albumTint ?? vivify(viewAlbumFallbackTint)) : null
    // Outside album views (library, Preferences, etc.) the window tint follows
    // the player: whenever a track is loaded it borrows the player's current
    // color (artwork or the assigned preset/custom). Falls back to the playing
    // artwork color for the colorless 'default' mode, then to neutral.
    const next = viewedTint ?? (nowTrack ? playerCurrentTint : null) ?? (isPlaying ? playingTint : null)
    if (next) {
      root.style.setProperty('--bg-tint', next)
      root.style.setProperty('--bg-control-tint', next)
    } else {
      root.style.removeProperty('--bg-tint')
      root.style.removeProperty('--bg-control-tint')
    }
  }, [viewAlbum, albumTint, viewAlbumFallbackTint, playerCurrentTint, nowTrack, playingTint, isPlaying])

  // Propagate the content-area palette (--bg-pal-0/1/2) to :root so .content can
  // render a 3-color gradient instead of the flat single-color wash. Source
  // priority mirrors --bg-tint (viewed album → playing track), and each var
  // falls back to --bg-tint in CSS, so when this is cleared the content backdrop
  // gracefully degrades to the original single-color look.
  useEffect(() => {
    const root = document.documentElement
    const palette =
      viewAlbum
        ? (albumPalette ?? viewAlbum.palette.map(c => vivify(c) ?? c))
      : (nowTrack && tweak.playerTintSource === 'artwork' && playingPalette)
        ? playingPalette.map(c => vivify(c) ?? c)
      : playerCurrentTint
        ? [playerCurrentTint, playerCurrentTint, playerCurrentTint]
      : null
    if (palette) {
      root.style.setProperty('--bg-pal-0', palette[0])
      root.style.setProperty('--bg-pal-1', palette[1] ?? palette[0])
      root.style.setProperty('--bg-pal-2', palette[2] ?? palette[1] ?? palette[0])
    } else {
      root.style.removeProperty('--bg-pal-0')
      root.style.removeProperty('--bg-pal-1')
      root.style.removeProperty('--bg-pal-2')
    }
  }, [viewAlbum, albumPalette, nowTrack, tweak.playerTintSource, playingPalette, playerCurrentTint])

  // Propagate --np-tint to :root so both the player pane and the lyrics side
  // pane share the same artwork-based tint. PlayerPane's own inline style
  // continues to override on that element (same value), while LyricsSidePane
  // picks up this global value since it's a DOM sibling, not a descendant.
  useEffect(() => {
    const root = document.documentElement
    if (playerCurrentTint) {
      root.style.setProperty('--np-tint', playerCurrentTint)
    } else {
      root.style.removeProperty('--np-tint')
    }
  }, [playerCurrentTint])

  // Propagate the artwork palette (--np-pal-0/1/2) to :root so the immersive
  // player pane and lyrics side pane render the same animated color blobs as
  // the fullscreen player. Mirrors --np-tint's source logic: artwork → the
  // extracted 3-color palette; preset/custom → the single chosen color across
  // all blobs; default/none → cleared (blobs fall back to the transparent
  // :root defaults).
  useEffect(() => {
    const root = document.documentElement
    const palette =
      tweak.playerTintSource === 'artwork' && playingPalette
        ? playingPalette.map(c => vivify(c) ?? c)
      : playerCurrentTint ? [playerCurrentTint, playerCurrentTint, playerCurrentTint]
      : null
    if (palette) {
      root.style.setProperty('--np-pal-0', palette[0])
      root.style.setProperty('--np-pal-1', palette[1] ?? palette[0])
      root.style.setProperty('--np-pal-2', palette[2] ?? palette[1] ?? palette[0])
    } else {
      root.style.removeProperty('--np-pal-0')
      root.style.removeProperty('--np-pal-1')
      root.style.removeProperty('--np-pal-2')
    }
  }, [tweak.playerTintSource, playingPalette, playerCurrentTint])

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
      setAlbumPalette(null)
      return
    }

    // No artwork to sample: borrow the color the player is currently showing
    // (so an album without a cover inherits the now-playing tint) instead of the
    // synthetic per-album hue. Only when a track is loaded; otherwise fall back
    // to the synthetic palette as before. With artwork, keep the synthetic value
    // as a brief placeholder until extraction resolves.
    const fallback = viewAlbumArtworkPath
      ? vivify(viewAlbumFallbackTint)
      : ((nowTrack ? playerCurrentTint : null) ?? vivify(viewAlbumFallbackTint))
    setAlbumTint(fallback)
    // Synthetic palette placeholder (final value when there's no artwork); the
    // extracted palette overwrites it below once it resolves.
    setAlbumPalette(viewAlbum.palette.map(c => vivify(c) ?? c))

    if (!viewAlbumArtworkPath) return

    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(viewAlbumArtworkPath)}`
    void extractDominantColor(src).then(hex => {
      const tint = vivify(hex)
      if (!cancelled && tint) setAlbumTint(tint)
    })
    void extractPalette(src, 3).then(pal => {
      if (!cancelled && pal) setAlbumPalette(pal.map(c => vivify(c) ?? c))
    })

    return () => {
      cancelled = true
    }
  }, [viewAlbum, viewAlbumArtworkPath, viewAlbumFallbackTint, playerCurrentTint, nowTrack])

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
        return (
          <SettingsView
            tweak={tweak}
            setTweak={setTweak}
            activeTab={settingsTab}
            playbackSubTab={settingsPlaybackTab}
            onConnectDevice={setConnectTarget}
          />
        )
      case 'import':
        return <ImportView />
      case 'downloads':
        return <DownloadsView />
      case 'devices':
        return (
          <DevicesView
            dashboardTab={dashboardTab}
          />
        )
      case 'device':
        if (view.section === 'dashboard') {
          return (
            <DevicesView
              deviceId={view.deviceId}
              dashboardTab={dashboardTab}
            />
          )
        }
        if (view.section === 'sync') return <DeviceSyncView deviceId={view.deviceId} syncTab={syncTab} onSyncTabChange={setSyncTab} />
        return <DeviceLibraryView deviceId={view.deviceId} section={view.section} />
      case 'genres':
        return <GenresView onSelectAlbum={al => navigate({ kind: 'album', album: al })} />
      case 'metadataFix':
        return <MetadataFixView trackIds={view.trackIds} missingCount={view.missingCount} onDone={goBack} />
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
            onConnectDevice={setConnectTarget}
          />

          {sidebarOpen && (
            <div
              className={`layout-resize-handle sidebar-resize-handle ${isResizingSidebar ? 'active' : ''}`}
              style={{ left: `${sidebarWidth}px` }}
              onPointerDown={beginSidebarResize}
              aria-hidden
            />
          )}

          <div className={`main-area ${sidebarOpen ? 'with-sidebar' : 'without-sidebar'}`}>
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
              activityOpen={activityOpen}
              activityActiveCount={activityActiveCount}
              activityUnreadCount={activityUnreadCount}
              onToggleActivityCenter={toggleActivityPanel}
            />
            <ActivityCenter
              open={activityOpen}
              pinned={activityPinned}
              fullscreen={activityFullscreen}
              items={activityItems}
              onClose={closeActivityPanel}
              onTogglePinned={() => setActivityPinned(!activityPinned)}
              onToggleFullscreen={() => setActivityFullscreen(!activityFullscreen)}
              onMarkAllRead={markActivityRead}
              onClearResolved={clearResolvedActivity}
              onAction={(actionId, item) => { void handleActivityAction(actionId, item) }}
            />
            {view.kind === 'devices' && selectedDeviceId && (
              <DeviceSectionTabs
                deviceId={selectedDeviceId}
                section="dashboard"
                onNavigate={navigate}
              />
            )}
            {view.kind === 'device' && (
              <DeviceSectionTabs
                deviceId={view.deviceId}
                section={view.section}
                onNavigate={navigate}
              />
            )}
            {((view.kind === 'device' && view.section === 'dashboard') || view.kind === 'devices') && (
              <DeviceNavbarSubTabs
                tabs={DEVICE_DASHBOARD_SUBTABS}
                active={dashboardTab}
                ariaLabel="Vista del resumen del dispositivo"
                onChange={setDashboardTab}
              />
            )}
            {view.kind === 'device' && view.section === 'sync' && (
              <DeviceNavbarSubTabs
                tabs={DEVICE_SYNC_SUBTABS}
                active={syncTab}
                ariaLabel="Vista de sincronización"
                onChange={setSyncTab}
              />
            )}
            {view.kind === 'settings' && (
              <SettingsSectionTabs active={settingsTab} onChange={setSettingsTab} />
            )}
            {view.kind === 'settings' && settingsTab === 'reproduccion' && (
              <DeviceNavbarSubTabs
                tabs={SETTINGS_PLAYBACK_SUBTABS}
                active={settingsPlaybackTab}
                ariaLabel="Subsecciones de reproducción"
                onChange={setSettingsPlaybackTab}
              />
            )}
            <div
              ref={contentRef}
              className="content"
            >
              {renderContent()}
            </div>
          </div>

          {(playerPaneVisible || lyricsSidePaneVisible) && (
            <div className="np-dock-lateral">
              <div className="pane-bg-canvas" aria-hidden="true">
                <div className="np-bg-blob np-bg-blob-a" />
                <div className="np-bg-blob np-bg-blob-b" />
                <div className="np-bg-blob np-bg-blob-c" />
                <div className="np-bg-blob np-bg-blob-d" />
              </div>
              <div className="pane-bg-scrim" aria-hidden="true" />

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

              {lyricsSidePaneVisible && (
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
            </div>
          )}

        </div>

        {bottomPlayerVisible && (
          <div className={`player-dock ${
            (isBottomPlayerClosing || bottomPlayerClosing) ? 'collapsed' : bottomPlayerPriming ? 'priming' : 'open'
          } ${bottomPlayerEntering && !(isBottomPlayerClosing || bottomPlayerClosing) ? 'entering' : ''}`}>
            {!expanded && !isBottomPlayerClosing && !bottomPlayerClosing && <UpNextToast variant="bottom" />}
            <div className="player-dock-inner">
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
            </div>
          </div>
        )}

        {expanded && nowTrack && (
          <NowPlayingFull onCollapse={() => setExpanded(false)} />
        )}

        <LyricsCandidates />
        {setupWizardOpen && (
          <LibrarySetupWizard
            onComplete={async () => {
              await Promise.all([loadLibraryLocations(), refresh()])
              setSetupWizardOpen(false)
            }}
          />
        )}
        {connectTarget && (
          <DeviceConnectModal
            target={connectTarget}
            artworkMaxEdge={tweak.deviceArtworkMaxEdge}
            onConnected={device => {
              setConnectTarget(null)
              navigate({ kind: 'device', deviceId: device.id, section: 'dashboard' })
            }}
            onClose={() => setConnectTarget(null)}
          />
        )}
      </div>
    </div>
  )
}
