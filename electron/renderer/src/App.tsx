import { useEffect, useState } from 'react'
import type { Album, Artist, Playlist, Track } from '@shared/types/library'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { PlayerPane } from './components/PlayerPane'
import { NowPlayingFull } from './components/NowPlayingFull'
import { MiniPlayer } from './components/MiniPlayer'
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
import { ComingSoonView } from './views/ComingSoonView'
import { useTweaks } from './stores/settingsStore'
import { mockLibrary } from './data/mockLibrary'

export type View =
  | { kind: 'library' }
  | { kind: 'recent' }
  | { kind: 'albums' }
  | { kind: 'artists' }
  | { kind: 'genres' }
  | { kind: 'composers' }
  | { kind: 'search' }
  | { kind: 'settings' }
  | { kind: 'import' }
  | { kind: 'album'; album: Album }
  | { kind: 'artist'; artist: Artist }
  | { kind: 'playlist'; playlist: Playlist }

export default function App() {
  const [tweak, setTweak] = useTweaks()
  const [history, setHistory] = useState<View[]>([{ kind: 'library' }])
  const [idx, setIdx] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [showLyrics, setShowLyrics] = useState(true)
  const [playing, setPlaying] = useState(true)
  const [progress, setProgress] = useState(mockLibrary.nowPlaying.progress)
  const [nowTrack, setNowTrack] = useState<Track>(mockLibrary.nowPlaying.track)

  const view = history[idx]

  // Animate progress for life-like preview
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      setProgress(p => (p + 1 / (nowTrack.d * 3)) % 1)
    }, 1000)
    return () => window.clearInterval(id)
  }, [playing, nowTrack])

  const navigate = (v: View, { replace = false }: { replace?: boolean } = {}) => {
    if (replace) {
      const h = [...history]
      h[idx] = v
      setHistory(h)
      return
    }
    const trimmed = history.slice(0, idx + 1)
    setHistory([...trimmed, v])
    setIdx(trimmed.length)
  }

  // Body class management (theme + density + layout)
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

  const sidebarKey = (() => {
    switch (view.kind) {
      case 'library':   return 'songs'
      case 'albums':    return 'albums'
      case 'artists':   return 'artists'
      case 'genres':    return 'genres'
      case 'composers': return 'composers'
      case 'recent':    return 'recent'
      case 'playlist':  return 'pl-' + view.playlist.id
      case 'artist':    return 'ar-' + view.artist.id
      default:          return null
    }
  })()

  const onPlay = (t: Track) => {
    setNowTrack(t)
    setPlaying(true)
    setProgress(0)
  }

  function renderContent() {
    switch (view.kind) {
      case 'library':
      case 'recent':
        return <LibraryView playingId={nowTrack.id} onPlay={onPlay} />
      case 'albums':
        return <AlbumsView onSelect={al => navigate({ kind: 'album', album: al })} />
      case 'album':
        return <AlbumView album={view.album} playingId={nowTrack.id} onPlay={onPlay} />
      case 'artists':
        return <ArtistsView onSelect={ar => navigate({ kind: 'artist', artist: ar })} />
      case 'artist':
        return (
          <ArtistView
            artist={view.artist}
            onSelectAlbum={al => navigate({ kind: 'album', album: al })}
            playingId={nowTrack.id}
            onPlay={onPlay}
          />
        )
      case 'playlist':
        return <PlaylistView playlist={view.playlist} playingId={nowTrack.id} onPlay={onPlay} />
      case 'search':
        return (
          <SearchView
            onSelectAlbum={al => navigate({ kind: 'album', album: al })}
            onSelectArtist={ar => navigate({ kind: 'artist', artist: ar })}
            playingId={nowTrack.id}
            onPlay={onPlay}
          />
        )
      case 'settings':
        return <SettingsView tweak={tweak} setTweak={setTweak} />
      case 'import':
        return <ImportView />
      case 'genres':
        return <GenresView onSelectAlbum={al => navigate({ kind: 'album', album: al })} />
      case 'composers':
        return (
          <ComingSoonView
            title="Composers"
            hint="Group tracks by composer metadata. Add composer tags via Track Info or scan from your watched folders."
          />
        )
      default:
        return <LibraryView playingId={nowTrack.id} onPlay={onPlay} />
    }
  }

  return (
    <div className="desktop">
      <div className="window">
        <div className="frame">
          <Sidebar
            setView={navigate}
            selectedKey={sidebarKey}
            translucent={tweak.translucent}
            onSelectPlaylist={pl => navigate({ kind: 'playlist', playlist: pl })}
            onSelectArtist={ar => navigate({ kind: 'artist', artist: ar })}
          />

          <div className="main-area">
            <Toolbar
              view={view}
              history={history}
              idx={idx}
              onBack={() => idx > 0 && setIdx(idx - 1)}
              onForward={() => idx < history.length - 1 && setIdx(idx + 1)}
              onNavigate={navigate}
            />
            <div className="content">{renderContent()}</div>
          </div>

          <PlayerPane
            track={nowTrack}
            progress={progress}
            volume={0.65}
            playing={playing}
            expanded={expanded}
            onPlayPause={() => setPlaying(p => !p)}
            onExpand={() => setExpanded(true)}
            onMini={() => setTweak('showMini', true)}
          />
        </div>

        {expanded && (
          <NowPlayingFull
            track={nowTrack}
            progress={progress}
            playing={playing}
            showLyrics={showLyrics}
            setShowLyrics={setShowLyrics}
            onPlayPause={() => setPlaying(p => !p)}
            onCollapse={() => setExpanded(false)}
          />
        )}

        {tweak.showMini && (
          <MiniPlayer
            track={nowTrack}
            playing={playing}
            onPlayPause={() => setPlaying(p => !p)}
            onClose={() => setTweak('showMini', false)}
          />
        )}
      </div>
    </div>
  )
}
