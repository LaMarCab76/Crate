import { useEffect, useRef } from 'react'
import { Icon } from './Icon'
import type { View } from '@renderer/App'

interface ToolbarProps {
  view: View
  history: View[]
  idx: number
  onBack: () => void
  onForward: () => void
  onNavigate: (v: View) => void
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
  playerPaneOpen: boolean
  canTogglePlayerPane: boolean
  onTogglePlayerPane: () => void
}

const titleMap: Record<View['kind'], string> = {
  library: 'Songs',
  albums: 'Albums',
  artists: 'Artists',
  genres: 'Genres',
  recent: 'Recently Added',
  album: 'Album',
  artist: 'Artist',
  playlist: 'Playlist',
  favoriteTracks: 'Favorite Tracks',
  search: 'Search',
  settings: 'Preferences',
  import: 'Library Sources',
}

function titleForView(view: View): string {
  if (view.kind === 'album') return view.album.title
  if (view.kind === 'artist') return view.artist.name
  if (view.kind === 'playlist') return view.playlist.name
  return titleMap[view.kind] ?? 'Crate'
}

export function Toolbar({
  view,
  history,
  idx,
  onBack,
  onForward,
  onNavigate,
  searchQuery,
  onSearchQueryChange,
  sidebarOpen,
  onToggleSidebar,
  playerPaneOpen,
  canTogglePlayerPane,
  onTogglePlayerPane,
}: ToolbarProps) {
  const isSearchView = view.kind === 'search'
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isSearchView) return
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isSearchView])

  const focusSearch = () => {
    if (!isSearchView) {
      onNavigate({ kind: 'search' })
      return
    }
    searchInputRef.current?.focus()
  }

  return (
    <div className="toolbar">
      <button
        className={`tb-icon-btn tb-layout-toggle ${sidebarOpen ? 'active' : ''}`}
        onClick={onToggleSidebar}
        title={sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
        aria-label={sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
        aria-pressed={sidebarOpen}
      >
        <Icon name="sidebarLeft" size={15} />
      </button>
      <button className="tb-nav-btn" disabled={idx <= 0} onClick={onBack} title="Back">
        <Icon name="back" size={15} />
      </button>
      <button className="tb-nav-btn" disabled={idx >= history.length - 1} onClick={onForward} title="Forward">
        <Icon name="fwd" size={15} />
      </button>
      <div className="tb-title">{titleForView(view)}</div>

      <div className={`tb-search${isSearchView ? ' is-active' : ''}`} onClick={focusSearch}>
        <Icon name="search" size={13} style={{ color: 'var(--text-tertiary)' }} />
        <input
          ref={searchInputRef}
          aria-label="Search library"
          placeholder="Search library…"
          readOnly={!isSearchView}
          value={isSearchView ? searchQuery : ''}
          onChange={e => onSearchQueryChange(e.target.value)}
        />
        {isSearchView && searchQuery ? (
          <button
            className="tb-search-clear"
            type="button"
            onClick={e => {
              e.stopPropagation()
              onSearchQueryChange('')
              searchInputRef.current?.focus()
            }}
            title="Clear search"
          >
            <Icon name="close" size={13} />
          </button>
        ) : (
          <span className="mono tiny" style={{ color: 'var(--text-quaternary)' }}>⌘F</span>
        )}
      </div>

      <button
        className={`tb-icon-btn tb-layout-toggle ${playerPaneOpen ? 'active' : ''}`}
        onClick={onTogglePlayerPane}
        disabled={!canTogglePlayerPane}
        title={playerPaneOpen ? 'Hide Player Panel' : 'Show Player Panel'}
        aria-label={playerPaneOpen ? 'Hide Player Panel' : 'Show Player Panel'}
        aria-pressed={playerPaneOpen}
      >
        <Icon name="sidebarRight" size={15} />
      </button>
      <button className="tb-icon-btn" onClick={() => onNavigate({ kind: 'import' })} title="Add to Library">
        <Icon name="plus" />
      </button>
      <button
        className={`tb-icon-btn ${view.kind === 'settings' ? 'active' : ''}`}
        onClick={() => onNavigate({ kind: 'settings' })}
        title="Preferences"
      >
        <Icon name="sliders" />
      </button>
    </div>
  )
}
