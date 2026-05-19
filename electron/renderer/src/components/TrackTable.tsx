import type { Track } from '@shared/types/library'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { EQBars } from './EQBars'
import { fmtTime } from '@renderer/utils/format'
import { useAlbums } from '@renderer/stores/libraryStore'
import { toggleTrackFavorite } from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'

interface TrackTableProps {
  tracks: Track[]
  showArt?: boolean
  showAlbum?: boolean
  showFmt?: boolean
  showPlays?: boolean
  showPath?: boolean
  onRefreshMetadata?: (track: Track) => void
}

export function TrackTable({
  tracks,
  showArt = false,
  showAlbum = true,
  showFmt = true,
  showPlays = true,
  showPath = false,
  onRefreshMetadata,
}: TrackTableProps) {
  const albums = useAlbums()
  const playNow = useQueueStore(s => s.playNow)
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const playingId = currentTrack?.id
  const showRefreshAction = onRefreshMetadata != null

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th className="num">#</th>
          {showArt && <th className="art" />}
          <th className="title">Title</th>
          {showAlbum && <th>Album</th>}
          {showPath && <th className="path">Ruta</th>}
          {showPlays && <th className="plays">Plays</th>}
          {showFmt && <th className="fmt">Format</th>}
          <th className="dur">Time</th>
          {showRefreshAction && <th className="actions" />}
        </tr>
      </thead>
      <tbody>
        {tracks.map((t, i) => {
          const isP = t.id === playingId
          const album = showArt ? albums.find(a => a.id === t.albumId) : undefined
          const pathValue = t.path ?? ''
          const canRefresh = t.dbId != null
          return (
            <tr
              key={t.id}
              className={isP ? 'playing' : ''}
              onDoubleClick={() => { void playNow(t, tracks) }}
            >
              <td className={`num ${t.dbId != null ? 'has-like' : ''}`}>
                <span className="track-index">
                  {isP ? <EQBars /> : t.no || i + 1}
                </span>
                {t.dbId != null && (
                  <button
                    type="button"
                    className="tb-icon-btn track-like"
                    onClick={e => {
                      e.stopPropagation()
                      void toggleTrackFavorite(t.dbId!, !t.loved)
                    }}
                    onDoubleClick={e => e.stopPropagation()}
                    title={t.loved ? 'Remove from favorites' : 'Mark as favorite'}
                  >
                    <Icon name={t.loved ? 'heartF' : 'heart'} size={13} />
                  </button>
                )}
              </td>
              {showArt && (
                <td className="art">
                  <div className="mini-art">
                    <Artwork album={album} radius={3} />
                  </div>
                </td>
              )}
              <td className="title">
                <span className="title-main">{t.t}</span>
                {!showArt && showAlbum && <span className="title-sub">{t.artist}</span>}
              </td>
              {showAlbum && <td className="sec">{t.albumTitle}</td>}
              {showPath && <td className="path" title={t.path}>{pathValue}</td>}
              {showPlays && <td className="plays">{t.plays}</td>}
              {showFmt && <td className="fmt"><CodecStrip track={t} compact /></td>}
              <td className="dur">{fmtTime(t.d)}</td>
              {showRefreshAction && (
                <td className="actions">
                  <button
                    type="button"
                    className="tb-icon-btn"
                    onClick={e => {
                      e.stopPropagation()
                      if (canRefresh) onRefreshMetadata(t)
                    }}
                    onDoubleClick={e => e.stopPropagation()}
                    title="Actualizar metadatos"
                    disabled={!canRefresh}
                  >
                    <Icon name="rotate" size={13} />
                  </button>
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
