import { Icon } from './Icon'
import type { View } from '@renderer/App'

interface ToolbarProps {
  view: View
  history: View[]
  idx: number
  onBack: () => void
  onForward: () => void
  onNavigate: (v: View) => void
}

const titleMap: Record<View['kind'], string> = {
  library: 'Songs',
  albums: 'Albums',
  artists: 'Artists',
  genres: 'Genres',
  composers: 'Composers',
  recent: 'Recently Added',
  album: 'Album',
  artist: 'Artist',
  playlist: 'Playlist',
  search: 'Search',
  settings: 'Preferences',
  import: 'Library Sources',
}

function titleForView(view: View): string {
  if (view.kind === 'album') return view.album.title
  if (view.kind === 'artist') return view.artist.name
  if (view.kind === 'playlist') return view.playlist.name
  return titleMap[view.kind] ?? 'HiFidelity'
}

export function Toolbar({ view, history, idx, onBack, onForward, onNavigate }: ToolbarProps) {
  return (
    <div className="toolbar">
      <button className="tb-nav-btn" disabled={idx <= 0} onClick={onBack} title="Back">
        <Icon name="back" size={15} />
      </button>
      <button className="tb-nav-btn" disabled={idx >= history.length - 1} onClick={onForward} title="Forward">
        <Icon name="fwd" size={15} />
      </button>
      <div className="tb-title">{titleForView(view)}</div>

      <div className="tb-search" onClick={() => onNavigate({ kind: 'search' })}>
        <Icon name="search" size={13} style={{ color: 'var(--text-tertiary)' }} />
        <input placeholder="Search library…" readOnly />
        <span className="mono tiny" style={{ color: 'var(--text-quaternary)' }}>⌘F</span>
      </div>

      <button className="tb-icon-btn" onClick={() => onNavigate({ kind: 'import' })} title="Add to Library">
        <Icon name="plus" />
      </button>
      <button className="tb-icon-btn" onClick={() => onNavigate({ kind: 'settings' })} title="Preferences">
        <Icon name="sliders" />
      </button>
    </div>
  )
}
