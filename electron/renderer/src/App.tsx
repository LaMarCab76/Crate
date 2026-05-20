import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { Album, Artist, Playlist } from '@shared/types/library'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { PlayerPane } from './components/PlayerPane'
import { NowPlayingFull } from './components/NowPlayingFull'
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
import { useTweaks } from './stores/settingsStore'
import { useAlbumByUiId, useFavoriteTracks, useLibraryStore } from './stores/libraryStore'
import { usePlaybackStore } from './stores/playbackStore'
import { extractDominantColor } from './utils/colorExtract'

export type View =
  | { kind: 'library' }
  | { kind: 'recent' }
  | { kind: 'albums' }
  | { kind: 'artists' }
  | { kind: 'genres' }
  | { kind: 'search' }
  | { kind: 'settings' }
  | { kind: 'import' }
  | { kind: 'album'; album: Album }
  | { kind: 'artist'; artist: Artist }
  | { kind: 'playlist'; playlist: Playlist }
  | { kind: 'favoriteTracks' }

export default function App() {
  const [tweak, setTweak] = useTweaks()
  const [history, setHistory] = useState<View[]>([{ kind: 'library' }])
  const [idx, setIdx] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [playerPaneOpen, setPlayerPaneOpen] = useState(true)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollPositionsRef = useRef(new Map<number, number>())
  const view = history[idx]
  const viewAlbum = view.kind === 'album' ? view.album : null
  const viewAlbumId = viewAlbum?.id
  const viewAlbumTrackCount = viewAlbum?.tracks.length ?? 0
  const viewAlbumFallbackTint = viewAlbum?.palette[1] ?? null
  const viewAlbumArtworkPath = viewAlbum?.artworkPath ?? null

  const refresh = useLibraryStore(s => s.refresh)
  const loaded = useLibraryStore(s => s.loaded)
  const nowTrack = usePlaybackStore(s => s.currentTrack)
  const playbackStatus = usePlaybackStore(s => s.status)
  const nowAlbum = useAlbumByUiId(nowTrack?.albumId)
  const viewedAlbum = useAlbumByUiId(viewAlbumId)
  const favoriteTracks = useFavoriteTracks()
  const canShowPlayerPane = nowTrack != null && !expanded
  const [playingTint, setPlayingTint] = useState<string | null>(null)
  const [albumTint, setAlbumTint] = useState<string | null>(null)
  const playingArtworkPath = nowAlbum?.artworkPath ?? nowTrack?.artworkPath ?? null
  const isPlaying = playbackStatus === 'playing'
  const contentTint = viewAlbum ? (albumTint ?? viewAlbumFallbackTint) : null

  // Kick off the first library load when the renderer is ready.
  useEffect(() => {
    if (!loaded) refresh()
  }, [loaded, refresh])

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
  // track artwork as fallback). It becomes the global --bg-tint so the whole
  // chrome follows the music.
  useEffect(() => {
    if (!playingArtworkPath) { setPlayingTint(null); return }
    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(playingArtworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled) setPlayingTint(hex)
    })
    return () => { cancelled = true }
  }, [playingArtworkPath])

  // Global background tint follows the currently playing album. Clears when
  // playback isn't actively running so the base dark background shows.
  useEffect(() => {
    const root = document.documentElement
    if (isPlaying && playingTint) {
      root.style.setProperty('--bg-tint', playingTint)
    } else {
      root.style.removeProperty('--bg-tint')
    }
  }, [playingTint, isPlaying])

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

  // Album view tint should always follow the album being shown, independent of
  // now-playing/mini-player tinting.
  useEffect(() => {
    if (!viewAlbum) {
      setAlbumTint(null)
      return
    }

    setAlbumTint(viewAlbumFallbackTint)

    if (!viewAlbumArtworkPath) return

    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(viewAlbumArtworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled && hex) setAlbumTint(hex)
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
      default:          return null
    }
  })()

  function renderContent() {
    switch (view.kind) {
      case 'library':
      case 'recent':
        return <LibraryView />
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
        return <PlaylistView playlist={view.playlist} />
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
      case 'genres':
        return <GenresView onSelectAlbum={al => navigate({ kind: 'album', album: al })} />
      default:
        return <LibraryView />
    }
  }

  return (
    <div className="desktop">
      <div className="window">
        <div className="frame">
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
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen(open => !open)}
              playerPaneOpen={playerPaneOpen && canShowPlayerPane}
              canTogglePlayerPane={canShowPlayerPane}
              onTogglePlayerPane={() => setPlayerPaneOpen(open => !open)}
            />
            <div
              ref={contentRef}
              className="content"
              style={contentTint ? ({ '--bg-tint': contentTint } as CSSProperties) : undefined}
            >
              {renderContent()}
            </div>
          </div>

        <PlayerPane
          expanded={expanded}
          isOpen={playerPaneOpen}
          onExpand={() => setExpanded(true)}
          onCollapse={() => setPlayerPaneOpen(false)}
          onOpenAlbum={album => navigate({ kind: 'album', album })}
          onOpenArtist={artist => navigate({ kind: 'artist', artist })}
        />
        </div>

        {expanded && nowTrack && (
          <NowPlayingFull onCollapse={() => setExpanded(false)} />
        )}
      </div>
    </div>
  )
}
