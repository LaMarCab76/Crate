import { useEffect, useRef } from 'react'
import { Icon } from './Icon'
import type { View } from '@renderer/App'
import { useDeviceStore } from '@renderer/stores/deviceStore'

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
  activityOpen: boolean
  activityActiveCount: number
  activityUnreadCount: number
  onToggleActivityCenter: () => void
  /** True once .content has scrolled past the in-content page title. */
  contentScrolled: boolean
}

// Keyboard hint in the search well (the shortcut itself accepts ⌘ or Ctrl).
const SEARCH_SHORTCUT_HINT = window.api.meta.platform === 'macos' ? '⌘F' : 'Ctrl+F'
// Overlays that cover the toolbar; the shortcut is ignored while one is open.
const SEARCH_SHORTCUT_BLOCKERS = [
  '.np-full',
  '.modal-backdrop',
  '[aria-modal="true"]',
  '.pb-island-scrim.show',
  '.activity-center.fullscreen',
  '.context-menu',
].join(', ')

// Views that render their own large title at the top of the content. The
// toolbar title stays hidden there until that heading scrolls under the pill.
const IN_CONTENT_TITLE_VIEWS: ReadonlySet<View['kind']> = new Set(['library', 'favoriteTracks', 'playlist'])

const titleMap: Record<View['kind'], string> = {
  library: 'Songs',
  albums: 'Albums',
  artists: 'Artists',
  genres: 'Genres',
  recent: 'Recently Added',
  album: 'Album',
  artist: 'Artist',
  playlist: 'Playlist',
  // Same label as the sidebar row and the in-content heading it replaces.
  favoriteTracks: 'Temas favoritos',
  search: 'Search',
  settings: 'Preferences',
  import: 'Library Sources',
  devices: 'Devices',
  device: 'Device',
  metadataFix: 'Completar metadatos',
  duplicates: 'Temas duplicados',
}

function titleForView(view: View): string {
  if (view.kind === 'album') return view.album.title
  if (view.kind === 'artist') return view.artist.name
  if (view.kind === 'playlist') return view.playlist.name
  if (view.kind === 'metadataFix') return view.title ?? titleMap.metadataFix
  if (view.kind === 'device') {
    if (view.section === 'dashboard') return 'Device'
    if (view.section === 'sync') return 'Device Sync'
    if (view.section === 'library') return 'Device Library'
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
  activityOpen,
  activityActiveCount,
  activityUnreadCount,
  onToggleActivityCenter,
  contentScrolled,
}: ToolbarProps) {
  const isSearchView = view.kind === 'search'
  const isViewMode = searchScope === 'view' && viewQueryable
  const isActive = isSearchView || isViewMode
  const activeQuery = isViewMode ? viewQuery : searchQuery
  const searchInputRef = useRef<HTMLInputElement>(null)
  const scopeRef = useRef<HTMLDivElement>(null)

  // For device views, show the device name as the title (e.g. "H2-SD") instead
  // of the generic section label ("Device Sync", …). The second-row tabs already
  // convey which sub-section is active.
  const devices = useDeviceStore(s => s.devices)
  const deviceName =
    view.kind === 'device' ? devices.find(d => d.id === view.deviceId)?.name ?? null : null
  const title = deviceName ?? titleForView(view)
  const titleVisible = contentScrolled || !IN_CONTENT_TITLE_VIEWS.has(view.kind)
  const hasActiveActivity = activityActiveCount > 0

  // Auto-focus when entering the global SearchView.
  useEffect(() => {
    if (!isSearchView) return
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isSearchView])

  const focusSearch = () => {
    // On narrow pills the well folds into its icon (globals.css, @container
    // tb), which hides the Todos/Aquí switch. A click then unfolds it first
    // (focus), so the scope can still be changed with the mouse even while
    // 'Todos' is selected; the next click on the field opens SearchView.
    const scopeHidden = scopeRef.current != null && scopeRef.current.offsetWidth === 0
    if (isViewMode || isSearchView || scopeHidden) {
      searchInputRef.current?.focus()
      return
    }
    onNavigate({ kind: 'search' })
  }

  // ⌘F / Ctrl+F: same as clicking the field (filter this view in place, or
  // open the global SearchView). Ignored while something covers the toolbar:
  // a modal or dialog, the fullscreen player or activity center, the island's
  // Now Playing sheet, or an open context menu.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
      if (document.querySelector(SEARCH_SHORTCUT_BLOCKERS)) return
      event.preventDefault()
      if (isViewMode || isSearchView) {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }
      onNavigate({ kind: 'search' })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isViewMode, isSearchView, onNavigate])

  return (
    <div className="toolbar">
      <button
        className="tb-icon-btn tb-layout-toggle"
        onClick={onToggleSidebar}
        title={sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
        aria-label={sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
        aria-pressed={sidebarOpen}
      >
        <Icon name="sidebarLeft" size={16} />
      </button>
      <button className="tb-nav-btn" disabled={idx <= 0} onClick={onBack} title="Back" aria-label="Back">
        <Icon name="back" size={15} stroke={1.7} />
      </button>
      <button className="tb-nav-btn" disabled={idx >= history.length - 1} onClick={onForward} title="Forward" aria-label="Forward">
        <Icon name="fwd" size={15} stroke={1.7} />
      </button>
      <div className="tb-title-slot">
        <div
          className={`tb-title${titleVisible ? '' : ' is-hidden'}`}
          title={title}
          aria-hidden={titleVisible ? undefined : true}
        >{title}</div>
      </div>

      <div
        className={`tb-search${isActive ? ' is-active' : ''}${viewQueryable ? ' has-scope' : ''}${isActive && activeQuery ? ' has-query' : ''}`}
        onClick={focusSearch}
        onKeyDown={e => {
          // Escape leaves the field from the input or the scope / clear
          // buttons alike (on narrow pills this folds the search back).
          if (e.key !== 'Escape') return
          const focused = document.activeElement
          if (focused instanceof HTMLElement && e.currentTarget.contains(focused)) focused.blur()
        }}
      >
        <Icon name="search" size={14} stroke={1.6} className="tb-search-icon" />
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
            aria-label="Clear search"
          >
            <Icon name="close" size={12} />
          </button>
        ) : (
          <span className="tb-search-hint" aria-hidden="true">{SEARCH_SHORTCUT_HINT}</span>
        )}
        {viewQueryable && (
          <div
            ref={scopeRef}
            className={`tb-search-scope${searchScope === 'view' ? ' is-view' : ''}`}
            role="group"
            aria-label="Alcance de búsqueda"
          >
            <span className="tb-search-scope-thumb" aria-hidden="true" />
            <button
              type="button"
              className={`tb-search-scope-btn${searchScope === 'global' ? ' active' : ''}`}
              aria-pressed={searchScope === 'global'}
              onClick={e => { e.stopPropagation(); onSearchScopeChange('global') }}
            >Todos</button>
            <button
              type="button"
              className={`tb-search-scope-btn${searchScope === 'view' ? ' active' : ''}`}
              aria-pressed={searchScope === 'view'}
              onClick={e => {
                e.stopPropagation()
                onSearchScopeChange('view')
                searchInputRef.current?.focus()
              }}
            >Aquí</button>
          </div>
        )}
      </div>

      <div className="tb-divider" aria-hidden="true" />

      <button
        className={`tb-icon-btn tb-activity-btn ${activityOpen ? 'active' : ''} ${hasActiveActivity ? 'in-progress' : ''}`}
        onClick={onToggleActivityCenter}
        title="Actividad"
        aria-label="Actividad"
        aria-pressed={activityOpen}
      >
        <Icon
          name={hasActiveActivity ? 'loader' : 'activity'}
          size={16}
          className={hasActiveActivity ? 'tb-activity-loader' : undefined}
        />
        {(activityActiveCount > 0 || activityUnreadCount > 0) && (
          <span className={`tb-activity-badge ${activityActiveCount > 0 ? 'active' : ''}`}>
            {activityActiveCount > 0 ? activityActiveCount : activityUnreadCount}
          </span>
        )}
      </button>

      <button
        className={`tb-icon-btn tb-layout-toggle ${playerPaneOpen ? 'active' : ''}`}
        onClick={onTogglePlayerPane}
        disabled={!canTogglePlayerPane}
        title={playerPaneOpen ? 'Hide Player Panel' : 'Show Player Panel'}
        aria-label={playerPaneOpen ? 'Hide Player Panel' : 'Show Player Panel'}
        aria-pressed={playerPaneOpen}
      >
        <Icon name="sidebarRight" size={16} />
      </button>
      <button
        className="tb-icon-btn"
        onClick={() => onNavigate({ kind: 'import' })}
        title="Add to Library"
        aria-label="Add to Library"
      >
        <Icon name="plus" size={16} stroke={1.6} />
      </button>
      <button
        className={`tb-icon-btn ${view.kind === 'settings' ? 'active' : ''}`}
        onClick={() => onNavigate({ kind: 'settings' })}
        title="Preferences"
        aria-label="Preferences"
      >
        <Icon name="sliders" size={16} />
      </button>
    </div>
  )
}
