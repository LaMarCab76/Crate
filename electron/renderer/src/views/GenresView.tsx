import type { Album } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { useAlbums } from '@renderer/stores/libraryStore'

export function GenresView({ onSelectAlbum }: { onSelectAlbum?: (al: Album) => void }) {
  const albums = useAlbums()

  if (albums.length === 0) {
    return (
      <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
        No music yet. Add a folder from Library Sources to import your music.
      </div>
    )
  }

  const byGenre: Record<string, Album[]> = {}
  albums.forEach(a => {
    const g = a.genre || 'Unknown'
    ;(byGenre[g] = byGenre[g] || []).push(a)
  })

  return (
    <>
      <div className="lib-head">
        <div>
          <h1>Genres</h1>
          <div className="sub">{Object.keys(byGenre).length} genres</div>
        </div>
      </div>
      <div style={{ padding: '0 20px 28px' }}>
        {Object.entries(byGenre).map(([g, list]) => (
          <div key={g} style={{ marginBottom: 24 }}>
            <div className="sec-head" style={{ padding: '8px 0 8px' }}>
              <h2>{g}</h2>
              <div className="muted tiny">{list.length} album{list.length > 1 ? 's' : ''}</div>
            </div>
            <div className="grid" style={{ padding: 0 }}>
              {list.map(al => (
                <div key={al.id} className="card" onClick={() => onSelectAlbum?.(al)} role="button" tabIndex={0}>
                  <div className="art"><Artwork album={al} /></div>
                  <div className="ti">{al.title}</div>
                  <div className="su">{al.artist}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
