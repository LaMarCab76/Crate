import type { Track } from '@shared/types/library'
import { Artwork } from './Artwork'
import { Icon } from './Icon'
import { EQBars } from './EQBars'
import { fmtTime } from '@renderer/utils/format'
import { mockLibrary } from '@renderer/data/mockLibrary'

interface TrackTableProps {
  tracks: Track[]
  showArt?: boolean
  showAlbum?: boolean
  showFmt?: boolean
  showPlays?: boolean
  playingId?: string
  onPlay?: (t: Track) => void
}

export function TrackTable({
  tracks,
  showArt = false,
  showAlbum = true,
  showFmt = true,
  showPlays = true,
  playingId,
  onPlay,
}: TrackTableProps) {
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
          return (
            <tr key={t.id} className={isP ? 'playing' : ''} onDoubleClick={() => onPlay?.(t)}>
              <td className="num">
                {isP ? <EQBars /> : t.no || i + 1}
              </td>
              {showArt && (
                <td className="art">
                  <div className="mini-art">
                    <Artwork album={mockLibrary.albums.find(a => a.id === t.albumId)} radius={3} />
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
