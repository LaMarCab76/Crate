import type { CSSProperties } from 'react'
import type { Artist, Playlist } from '@shared/types/library'
import { Artwork } from './Artwork'
import { Icon, type IconName } from './Icon'
import type { View } from '@renderer/App'
import { useFavoriteArtists, usePlaylists, useTrackCount } from '@renderer/stores/libraryStore'

interface SidebarProps {
  setView: (v: View) => void
  selectedKey: string | null
  translucent: boolean
  isOpen: boolean
  onSelectPlaylist: (p: Playlist) => void
  onSelectArtist: (a: Artist) => void
  onSelectFavoriteTracks: () => void
  favoriteTracksCount: number
}

function SectionLabel({ label, onAdd, title }: { label: string; onAdd?: () => void; title?: string }) {
  return (
    <div className="sb-section-label">
      <span>{label}</span>
      {onAdd && (
        <span className="add" onClick={onAdd} title={title} role="button" tabIndex={0}>
          <Icon name="plus" size={12} stroke={1.8} />
        </span>
      )}
    </div>
  )
}

export function Sidebar({
  setView,
  selectedKey,
  translucent,
  isOpen,
  onSelectPlaylist,
  onSelectArtist,
  onSelectFavoriteTracks,
  favoriteTracksCount,
}: SidebarProps) {
  const artists = useFavoriteArtists()
  const playlists = usePlaylists()
  const trackCount = useTrackCount()

  const Item = ({ id, icon, label, badge, onClick }: { id: string; icon: IconName; label: string; badge?: string | number; onClick: () => void }) => (
    <div className={`sb-item ${selectedKey === id ? 'active' : ''}`} onClick={onClick} role="button" tabIndex={0}>
      <span className="ic"><Icon name={icon} size={14} /></span>
      <span>{label}</span>
      {badge != null && <span className="badge">{badge}</span>}
    </div>
  )

  return (
    <div
      className={`sidebar ${translucent ? '' : 'solid'} ${isOpen ? 'sidebar-open' : 'sidebar-collapsed'}`}
      aria-hidden={!isOpen}
    >
      {/* Spacer so the macOS traffic lights have room above the sidebar content. */}
      <div className="sb-header" style={{ WebkitAppRegion: 'drag' } as CSSProperties} />

      <div className="sb-scroll">
        <div style={{ padding: '0 8px 4px' }}>
          <div className="sb-item" style={{ height: 32, fontSize: 14, fontWeight: 700, padding: '0 10px', gap: 8 }}>
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 5,
                background: 'linear-gradient(135deg, #fff, #888)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: '#111', fontWeight: 800, fontSize: 13, fontFamily: 'var(--font-mono)' }}>♪</span>
            </div>
            Crate
          </div>
        </div>

        <SectionLabel label="Library" />
        <Item id="songs"     icon="song"     label="Songs"           badge={trackCount > 0 ? trackCount : undefined} onClick={() => setView({ kind: 'library' })} />
        <Item id="albums"    icon="album"    label="Albums"          onClick={() => setView({ kind: 'albums' })} />
        <Item id="artists"   icon="artist"   label="Artists"         onClick={() => setView({ kind: 'artists' })} />
        <Item id="genres"    icon="genre"    label="Genres"          onClick={() => setView({ kind: 'genres' })} />
        <Item id="recent"    icon="recent"   label="Recently Added"  onClick={() => setView({ kind: 'recent' })} />

        <SectionLabel label="Playlists" onAdd={() => {}} title="New playlist" />

        <div
          className={`sb-item ${selectedKey === 'pfavorites' ? 'active' : ''}`}
          onClick={() => onSelectFavoriteTracks()}
          role="button"
          tabIndex={0}
        >
          <span className="ic">
            <Icon name="heartF" size={14} />
          </span>
          <span>Temas favoritos</span>
          <span className="badge">{favoriteTracksCount}</span>
        </div>

        {playlists.map(p => (
          <div
            key={p.id}
            className={`sb-item ${selectedKey === 'pl-' + p.id ? 'active' : ''}`}
            onClick={() => onSelectPlaylist(p)}
            role="button"
            tabIndex={0}
          >
            <span className="ic">
              <Icon name={p.kind === 'smart' ? 'sparkle' : p.icon || 'note'} size={14} />
            </span>
            <span>{p.name}</span>
            <span className="badge">{p.count}</span>
          </div>
        ))}

        <SectionLabel label="Favorite Artists" onAdd={() => setView({ kind: 'artists' })} title="Manage favorites" />
        {artists.length === 0 ? (
          <div className="sb-item">
            <span style={{ color: 'var(--text-tertiary)' }}>No tienes artistas favoritos</span>
          </div>
        ) : (
          artists.slice(0, 5).map(ar => (
            <div
              key={ar.id}
              className={`sb-item ${selectedKey === 'ar-' + ar.id ? 'active' : ''}`}
              onClick={() => onSelectArtist(ar)}
              role="button"
              tabIndex={0}
            >
              {ar.artworkPath ? (
                <div className="sb-artist-art">
                  <Artwork album={ar} radius={3} />
                </div>
              ) : (
                <div className="sb-artist-art swatch" style={{ background: `linear-gradient(135deg, ${ar.palette[1]}, ${ar.palette[0]})` }} />
              )}
              <span>{ar.name}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
