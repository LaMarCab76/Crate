import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { Track } from '@shared/types/library'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { EQBars } from './EQBars'
import { fmtFileSize, fmtTime } from '@renderer/utils/format'
import { extractDominantColor } from '@renderer/utils/colorExtract'
import { useAlbums } from '@renderer/stores/libraryStore'
import { toggleTrackFavorite } from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { useTrackActions } from './MediaActions'

interface TrackTableProps {
  tracks: Track[]
  showArt?: boolean
  showAlbum?: boolean
  showFmt?: boolean
  showSize?: boolean
  showPlays?: boolean
  showPath?: boolean
  showTrackNo?: boolean
  // Tighter, fixed row height — used by art-less listings (album/artist tracks)
  // so they don't read like the full-height library/playlist rows.
  compact?: boolean
  onRefreshMetadata?: (track: Track) => void
}

export function TrackTable({
  tracks,
  showArt = false,
  showAlbum = true,
  showFmt = true,
  showSize = false,
  showPlays = true,
  showPath = false,
  showTrackNo = false,
  compact = false,
  onRefreshMetadata,
}: TrackTableProps) {
  const albums = useAlbums()
  const playNow = useQueueStore(s => s.playNow)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const showPlayerVisualizer = useTweakStore(s => s.tweak.showPlayerVisualizer)
  const playingId = currentTrack?.id
  const playing = status === 'playing'
  const showRefreshAction = onRefreshMetadata != null
  const trackActions = useTrackActions()
  const playingAlbum = useMemo(
    () => albums.find(a => a.id === currentTrack?.albumId),
    [albums, currentTrack?.albumId],
  )
  const playingArtworkPath = currentTrack?.artworkPath ?? playingAlbum?.artworkPath ?? null
  const playingFallbackTint = playingAlbum?.palette[1] ?? 'var(--color-playing)'
  const [playingTint, setPlayingTint] = useState<string | null>(null)
  const playingRowStyle = {
    '--track-playing-tint': playingTint ?? playingFallbackTint,
  } as CSSProperties

  useEffect(() => {
    setPlayingTint(null)
    if (!playingArtworkPath) return

    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(playingArtworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled && hex) setPlayingTint(hex)
    })

    return () => { cancelled = true }
  }, [playingArtworkPath])

  return (
    <>
      <table className={`tbl${compact ? ' compact' : ''}`}>
        <thead>
          <tr>
            <th className="num">{showTrackNo ? '#' : null}</th>
            {showArt && <th className="art" />}
            <th className="title">Title</th>
            {showAlbum && <th>Album</th>}
            {showPath && <th className="path">Ruta</th>}
            {showPlays && <th className="plays">Plays</th>}
            {showFmt && <th className="fmt">Format</th>}
            {showSize && <th className="size">Size</th>}
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
                style={isP ? playingRowStyle : undefined}
                onContextMenu={e => trackActions.openTrackMenu(e, t)}
                onDoubleClick={() => { void playNow(t, tracks) }}
              >
                <td className={`num ${t.dbId != null ? 'has-like' : ''}`}>
                  <span className="track-index">
                    {isP ? (
                      showPlayerVisualizer ? (
                        <button
                          type="button"
                          className="tb-icon-btn"
                          style={{
                            width: '100%',
                            height: 22,
                            color: 'inherit',
                            padding: 0,
                            justifyContent: 'center',
                          }}
                          title={playing ? 'Pause' : 'Play'}
                          aria-label={playing ? 'Pause' : 'Play'}
                          onClick={e => {
                            e.stopPropagation()
                            void togglePlay()
                          }}
                          onDoubleClick={e => e.stopPropagation()}
                        >
                          <Icon name={playing ? 'pause' : 'play'} size={13} />
                        </button>
                      ) : (
                        <EQBars />
                      )
                    ) : showTrackNo ? (t.no || i + 1) : null}
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
                {showSize && <td className="size">{fmtFileSize(t.fileSize)}</td>}
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
      {trackActions.elements}
    </>
  )
}
