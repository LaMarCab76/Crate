import { useEffect, useRef } from 'react'
import type { Album } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { useAlbumActions } from '@renderer/components/MediaActions'
import { DiscGroupedTrackTable } from '@renderer/components/TrackTable'
import { fmtFileSize, fmtTime } from '@renderer/utils/format'
import {
  refreshTrackMetadata,
  toggleAlbumFavorite,
  useAlbumByUiId,
} from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { SourceBadge } from '@renderer/components/SourceBadge'

interface Props {
  album: Album
}

export function AlbumView({ album }: Props) {
  // Re-read the album from the store so its tracks list stays fresh after
  // imports and updates (album passed via navigation is a snapshot).
  const fresh = useAlbumByUiId(album?.id)
  const a = fresh ?? album
  const playNow = useQueueStore(s => s.playNow)
  const playShuffled = useQueueStore(s => s.playShuffled)
  const refreshedAlbumIds = useRef(new Set<string>())
  const albumActions = useAlbumActions()

  const handlePlayAlbum = async () => {
    if (!a || a.tracks.length === 0) return
    await playNow(a.tracks[0], a.tracks)
  }

  const handleShuffleAlbum = async () => {
    if (!a || a.tracks.length === 0) return
    await playShuffled(a.tracks)
  }

  const isUnresolvedAlbum = a?.id.startsWith('a-unresolved-') ?? false
  const isFavorite = a?.favorite === true

  useEffect(() => {
    if (!a) return
    if (refreshedAlbumIds.current.has(a.id)) return

    const ids = a.tracks
      .filter(track =>
        track.dbId != null &&
        (isUnresolvedAlbum || track.fileSize == null),
      )
      .map(track => track.dbId!)

    if (ids.length === 0) return

    refreshedAlbumIds.current.add(a.id)
    void (async () => {
      await Promise.all(ids.map(refreshTrackMetadata))
    })()
  }, [isUnresolvedAlbum, a?.id, a?.tracks.length])

  if (!a) return null
  const totalDur = a.tracks.reduce((s, t) => s + t.d, 0)
  const totalSize = a.tracks.reduce((s, t) => s + (t.fileSize ?? 0), 0)
  const sourceIds = [...new Set(a.tracks.map(track => track.folderId).filter((id): id is number => id != null))]
  return (
    <>
      <div className="album-hero" onContextMenu={e => albumActions.openAlbumMenu(e, a)}>
        <div className="art"><Artwork album={a} radius={8} /></div>
        <div className="meta">
          <div className="kicker">{a.genre}</div>
          <h1>{a.title}</h1>
          <div className="credits">
            <a>{a.artist}</a> · {a.year} · {a.tracks.length} tracks · {fmtTime(totalDur)} · {fmtFileSize(totalSize)}
          </div>
          <div className="album-source-summary">
            <SourceBadge folderIds={sourceIds} provider={a.tracks[0]?.provider} />
          </div>
          {isUnresolvedAlbum && (
            <div className="meta-note">
              <Icon name="tag" size={12} />
              Sin álbum detectado
            </div>
          )}
          <div className="ctas">
            <button className="btn primary" type="button" onClick={() => { void handlePlayAlbum() }}>
              <Icon name="play" size={12} /> Play
            </button>
            <button className="btn" type="button" onClick={() => { void handleShuffleAlbum() }}>
              <Icon name="shuffle" size={14} /> Shuffle
            </button>
            <button
              className="btn ghost icon"
              type="button"
              disabled={isUnresolvedAlbum}
              title={isUnresolvedAlbum
                ? 'No se puede marcar favorito mientras el álbum no está persistido'
                : isFavorite
                  ? 'Quitar de favoritos'
                  : 'Agregar a favoritos'}
              onClick={() => {
                if (!a || isUnresolvedAlbum) return
                void toggleAlbumFavorite(a.id, !isFavorite)
              }}
            >
              <Icon name={isFavorite ? 'heartF' : 'heart'} size={14} />
            </button>
            <button
              className="btn ghost icon"
              type="button"
              onClick={e => albumActions.openAlbumMenu(e, a)}
              title="Más"
            >
              <Icon name="ellipsis" />
            </button>
          </div>
        </div>
      </div>
      <DiscGroupedTrackTable
        tracks={a.tracks}
        showArt={false}
        showAlbum={false}
        showPlays={false}
        showPath={isUnresolvedAlbum}
        showSize
        showTrackNo
        compact
        showSource={sourceIds.length > 1}
      />
      {albumActions.elements}
    </>
  )
}
