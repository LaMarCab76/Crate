import type { Album } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { useAlbums } from '@renderer/stores/libraryStore'

export function AlbumsView({ onSelect }: { onSelect?: (al: Album) => void }) {
  const albums = useAlbums()

  if (albums.length === 0) {
    return (
      <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
        No albums yet. Add a folder from Library Sources to import your music.
      </div>
    )
  }

  return (
    <>
      <div className="lib-head">
        <div>
          <h1>Albums</h1>
          <div className="sub">{albums.length} albums in your library</div>
        </div>
        <div className="actions">
          <button className="btn ghost icon" title="Grid"><Icon name="grid" /></button>
          <button className="btn ghost icon" title="List"><Icon name="list" /></button>
          <button className="btn ghost icon"><Icon name="sortAZ" /></button>
        </div>
      </div>
      <div className="grid">
        {albums.map(al => (
          <div key={al.id} className="card" onClick={() => onSelect?.(al)} role="button" tabIndex={0}>
            <div className="art">
              <Artwork album={al} radius={6} />
              <div className="play-overlay">
                <div className="pb"><Icon name="play" size={14} /></div>
              </div>
            </div>
            <div className="ti">{al.title}</div>
            <div className="su">{al.artist}</div>
          </div>
        ))}
      </div>
    </>
  )
}
