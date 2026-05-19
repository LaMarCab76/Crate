import { type MouseEvent } from 'react'
import type { Album } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { useAlbums } from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { useAlbumActions } from '@renderer/components/MediaActions'

export function AlbumsView({ onSelect }: { onSelect?: (al: Album) => void }) {
  const albums = useAlbums()
  const playNow = useQueueStore(s => s.playNow)
  const albumActions = useAlbumActions()

  const playAlbum = (album: Album, e?: MouseEvent<HTMLElement>) => {
    if (e) e.stopPropagation()
    if (!album.tracks || album.tracks.length === 0) return
    void playNow(album.tracks[0], album.tracks)
  }

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
          <div
            key={al.id}
            className="card"
            onClick={() => onSelect?.(al)}
            onContextMenu={e => albumActions.openAlbumMenu(e, al)}
            role="button"
            tabIndex={0}
          >
            <div className="art">
              <Artwork album={al} radius={6} />
              <div className="play-overlay">
                <button
                  type="button"
                  className="pb"
                  onClick={e => {
                    playAlbum(al, e)
                  }}
                  title="Play album"
                >
                  <Icon name="play" size={14} />
                </button>
              </div>
            </div>
            <div className="ti">{al.title}</div>
            <div className="su">{al.artist}</div>
          </div>
        ))}
      </div>
      {albumActions.elements}
    </>
  )
}
