import type { Track } from '@shared/types/library'
import { Artwork } from './Artwork'
import { Icon } from './Icon'
import { EQBars } from './EQBars'
import { fmtTime } from '@renderer/utils/format'
import { useAlbums } from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'

interface TrackTableProps {
  tracks: Track[]
  showArt?: boolean
  showAlbum?: boolean
  showFmt?: boolean
  showPlays?: boolean
}

export function TrackTable({
  tracks,
  showArt = false,
  showAlbum = true,
  showFmt = true,
  showPlays = true,
}: TrackTableProps) {
  const albums = useAlbums()
  const playNow = useQueueStore(s => s.playNow)
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const playingId = currentTrack?.id

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th className="num">#</th>
          {showArt && <th className="art" />}
          <th>Title</th>
          {showAlbum && <th>Album</th>}
          <th className="heart" />
          {showPlays && <th className="plays">Plays</th>}
          {showFmt && <th className="fmt">Format</th>}
          <th className="dur">Time</th>
        </tr>
      </thead>
      <tbody>
        {tracks.map((t, i) => {
          const isP = t.id === playingId
          const album = showArt ? albums.find(a => a.id === t.albumId) : undefined
          return (
            <tr
              key={t.id}
              className={isP ? 'playing' : ''}
              onDoubleClick={() => { void playNow(t, tracks) }}
            >
              <td className="num">
                {isP ? <EQBars /> : t.no || i + 1}
              </td>
              {showArt && (
                <td className="art">
                  <div className="mini-art">
                    <Artwork album={album} radius={3} />
                  </div>
                </td>
              )}
              <td className="title">
                {t.t}
                {!showArt && showAlbum && <span className="title-sub">{t.artist}</span>}
              </td>
              {showAlbum && <td className="sec">{t.albumTitle}</td>}
              <td className="heart">
                {t.loved && <Icon name="heartF" size={13} />}
              </td>
              {showPlays && <td className="plays">{t.plays}</td>}
              {showFmt && <td className="fmt">{t.q}</td>}
              <td className="dur">{fmtTime(t.d)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
