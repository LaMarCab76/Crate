import type { Artist } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { useArtists } from '@renderer/stores/libraryStore'

export function ArtistsView({ onSelect }: { onSelect?: (ar: Artist) => void }) {
  const artists = useArtists()

  if (artists.length === 0) {
    return (
      <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
        No artists yet. Add a folder from Library Sources to import your music.
      </div>
    )
  }

  return (
    <>
      <div className="lib-head">
        <div>
          <h1>Artists</h1>
          <div className="sub">{artists.length} artists in your library</div>
        </div>
      </div>
      <div style={{ padding: '4px 12px 24px' }}>
        {artists.map(ar => (
          <div
            key={ar.id}
            className="sb-item"
            style={{ height: 56, margin: '2px 0', padding: '0 12px', gap: 14 }}
            onClick={() => onSelect?.(ar)}
            role="button"
            tabIndex={0}
          >
            <div style={{ width: 40, height: 40, borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
              <Artwork album={{ seed: ar.seed, palette: ar.palette, pattern: ar.pattern }} radius={20} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{ar.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {ar.albums.length} album{ar.albums.length > 1 ? 's' : ''}
              </div>
            </div>
            <Icon name="chevR" size={14} style={{ marginLeft: 'auto', color: 'var(--text-tertiary)' }} />
          </div>
        ))}
      </div>
    </>
  )
}
