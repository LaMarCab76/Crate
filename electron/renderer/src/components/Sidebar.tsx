import type { CSSProperties } from 'react'
import type { Artist, Playlist } from '@shared/types/library'
import { Icon, type IconName } from './Icon'
import type { View } from '@renderer/App'
import { useArtists, usePlaylists, useTrackCount } from '@renderer/stores/libraryStore'

interface SidebarProps {
  setView: (v: View) => void
  selectedKey: string | null
  translucent: boolean
  onSelectPlaylist: (p: Playlist) => void
  onSelectArtist: (a: Artist) => void
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

export function Sidebar({ setView, selectedKey, translucent, onSelectPlaylist, onSelectArtist }: SidebarProps) {
  const artists = useArtists()
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
    <div className={`sidebar ${translucent ? '' : 'solid'}`}>
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
            HiFidelity
          </div>
        </div>

        <SectionLabel label="Library" />
        <Item id="songs"     icon="song"     label="Songs"           badge={trackCount > 0 ? trackCount : undefined} onClick={() => setView({ kind: 'library' })} />
        <Item id="albums"    icon="album"    label="Albums"          onClick={() => setView({ kind: 'albums' })} />
        <Item id="artists"   icon="artist"   label="Artists"         onClick={() => setView({ kind: 'artists' })} />
        <Item id="genres"    icon="genre"    label="Genres"          onClick={() => setView({ kind: 'genres' })} />
        <Item id="composers" icon="composer" label="Composers"       onClick={() => setView({ kind: 'composers' })} />
        <Item id="recent"    icon="recent"   label="Recently Added"  onClick={() => setView({ kind: 'recent' })} />

        {playlists.length > 0 && (
          <>
            <SectionLabel label="Playlists" onAdd={() => {}} title="New playlist" />
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
          </>
        )}

        {artists.length > 0 && (
          <>
            <SectionLabel label="Artists" onAdd={() => setView({ kind: 'artists' })} title="Pin an artist" />
            {artists.slice(0, 5).map(ar => (
              <div
                key={ar.id}
                className={`sb-item ${selectedKey === 'ar-' + ar.id ? 'active' : ''}`}
                onClick={() => onSelectArtist(ar)}
                role="button"
                tabIndex={0}
              >
                <div className="swatch" style={{ background: `linear-gradient(135deg, ${ar.palette[1]}, ${ar.palette[0]})` }} />
                <span>{ar.name}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
