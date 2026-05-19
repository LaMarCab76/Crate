import type { Album } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { fmtTime } from '@renderer/utils/format'
import { refreshTrackMetadata, useAlbumByUiId } from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'

interface Props {
  album: Album
}

export function AlbumView({ album }: Props) {
  // Re-read the album from the store so its tracks list stays fresh after
  // imports and updates (album passed via navigation is a snapshot).
  const fresh = useAlbumByUiId(album?.id)
  const a = fresh ?? album
  const playNow = useQueueStore(s => s.playNow)

  const handlePlayAlbum = async () => {
    if (!a || a.tracks.length === 0) return
    await playNow(a.tracks[0], a.tracks)
  }

  const handleShuffleAlbum = async () => {
    if (!a || a.tracks.length === 0) return
    const tracks = [...a.tracks]
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[tracks[i], tracks[j]] = [tracks[j], tracks[i]]
    }

    await playNow(tracks[0], tracks)
  }
  const isUnresolvedAlbum = a?.id.startsWith('a-unresolved-') ?? false

  const handleTrackRefreshMetadata = async (trackDbId?: number) => {
    if (trackDbId == null) return
    try {
      await refreshTrackMetadata(trackDbId)
    } catch {}
  }

  const handleRefreshMetadata = async () => {
    if (!a) return
    await Promise.all(a.tracks.map(track => handleTrackRefreshMetadata(track.dbId)))
  }

  if (!a) return null
  const totalDur = a.tracks.reduce((s, t) => s + t.d, 0)
  return (
    <>
      <div className="album-hero">
        <div className="art"><Artwork album={a} radius={8} /></div>
        <div className="meta">
          <div className="kicker">{a.genre}</div>
          <h1>{a.title}</h1>
          <div className="credits">
            <a>{a.artist}</a> · {a.year} · {a.tracks.length} tracks · {fmtTime(totalDur)}
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
            <button className="btn ghost icon"><Icon name="heart" /></button>
            <button className="btn ghost icon"><Icon name="plus" /></button>
            <button className="btn ghost icon"><Icon name="ellipsis" /></button>
            {isUnresolvedAlbum && (
              <button
                className="btn ghost icon"
                type="button"
                onClick={() => { void handleRefreshMetadata() }}
                title="Actualizar metadatos"
              >
                <Icon name="rotate" size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
      <TrackTable
        tracks={a.tracks}
        showArt={false}
        showAlbum={false}
        showPlays={false}
        showPath={isUnresolvedAlbum}
        onRefreshMetadata={track => {
          void handleTrackRefreshMetadata(track.dbId)
        }}
      />
    </>
  )
}
