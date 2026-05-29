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
  searchScope: 'global' | 'view'
  onSearchScopeChange: (s: 'global' | 'view') => void
  viewQuery: string
  onViewQueryChange: (q: string) => void
  viewQueryable: boolean
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
  devices: 'Devices',
  device: 'Device',
}

function titleForView(view: View): string {
  if (view.kind === 'album') return view.album.title
  if (view.kind === 'artist') return view.artist.name
  if (view.kind === 'playlist') return view.playlist.name
  if (view.kind === 'device') {
    if (view.section === 'dashboard') return 'Device Sync'
    if (view.section === 'tracks') return 'Device Songs'
    if (view.section === 'albums') return 'Device Albums'
    if (view.section === 'artists') return 'Device Artists'
    if (view.section === 'playlists') return 'Device Playlists'
    return 'Rockbox Themes'
  }
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
  searchScope,
  onSearchScopeChange,
  viewQuery,
  onViewQueryChange,
  viewQueryable,
  sidebarOpen,
  onToggleSidebar,
  playerPaneOpen,
  canTogglePlayerPane,
  onTogglePlayerPane,
}: ToolbarProps) {
  const isSearchView = view.kind === 'search'
  const isViewMode = searchScope === 'view' && viewQueryable
  const isActive = isSearchView || isViewMode
  const activeQuery = isViewMode ? viewQuery : searchQuery
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Auto-focus when entering the global SearchView.
  useEffect(() => {
    if (!isSearchView) return
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isSearchView])

  const focusSearch = () => {
    if (isViewMode || isSearchView) {
      searchInputRef.current?.focus()
      return
    }
    onNavigate({ kind: 'search' })
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

      <div className={`tb-search${isActive ? ' is-active' : ''}${viewQueryable ? ' has-scope' : ''}`} onClick={focusSearch}>
        <Icon name="search" size={13} style={{ color: 'var(--text-tertiary)' }} />
        {viewQueryable && (
          <div className="tb-search-scope">
            <button
              type="button"
              className={`tb-search-scope-btn${searchScope === 'global' ? ' active' : ''}`}
              onClick={e => { e.stopPropagation(); onSearchScopeChange('global') }}
            >Todos</button>
            <button
              type="button"
              className={`tb-search-scope-btn${searchScope === 'view' ? ' active' : ''}`}
              onClick={e => {
                e.stopPropagation()
                onSearchScopeChange('view')
                searchInputRef.current?.focus()
              }}
            >Aquí</button>
          </div>
        )}
        <input
          ref={searchInputRef}
          aria-label={isViewMode ? 'Buscar en esta vista' : 'Search library'}
          placeholder={isViewMode ? 'Buscar en esta vista…' : 'Buscar biblioteca…'}
          readOnly={!isViewMode && !isSearchView}
          value={isViewMode ? viewQuery : (isSearchView ? searchQuery : '')}
          onChange={e => isViewMode ? onViewQueryChange(e.target.value) : onSearchQueryChange(e.target.value)}
        />
        {isActive && activeQuery ? (
          <button
            className="tb-search-clear"
            type="button"
            onClick={e => {
              e.stopPropagation()
              if (isViewMode) {
                onViewQueryChange('')
              } else {
                onSearchQueryChange('')
              }
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
