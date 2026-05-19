import type { Album, Track } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { fmtTotal } from '@renderer/utils/format'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'

interface Props {
  album: Album
  playingId?: string
  onPlay?: (t: Track) => void
}

export function AlbumView({ album, playingId, onPlay }: Props) {
  // Re-read the album from the store so its tracks list stays fresh after
  // imports and updates (album passed via navigation is a snapshot).
  const fresh = useAlbumByUiId(album?.id)
  const a = fresh ?? album
  if (!a) return null
  const totalDur = a.tracks.reduce((s, t) => s + t.d, 0)
  return (
    <>
      <div className="album-hero">
        <div className="art"><Artwork album={a} radius={8} /></div>
        <div className="meta">
          <div className="kicker">{a.genre} · {a.year}</div>
          <h1>{a.title}</h1>
          <div className="credits">
            <a>{a.artist}</a> · {a.tracks.length} tracks · {fmtTotal(totalDur)}
          </div>
          <div className="ctas">
            <button className="btn primary"><Icon name="play" size={12} /> Play</button>
            <button className="btn"><Icon name="shuffle" size={14} /> Shuffle</button>
            <button className="btn ghost icon"><Icon name="heart" /></button>
            <button className="btn ghost icon"><Icon name="plus" /></button>
            <button className="btn ghost icon"><Icon name="ellipsis" /></button>
          </div>
        </div>
      </div>
      <TrackTable
        tracks={a.tracks}
        showArt={false}
        showAlbum={false}
        showPlays={false}
        playingId={playingId}
        onPlay={onPlay}
      />
    </>
  )
}
