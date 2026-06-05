import { type CSSProperties, useEffect, useState } from 'react'
import { Artwork } from './Artwork'
import { CrossfadeArtwork } from './CrossfadeArtwork'
import { CodecStrip } from './CodecStrip'
import { FullScreenQueue } from './FullScreenQueue'
import { Icon } from './Icon'
import { LyricsPanel } from './LyricsPanel'
import { useTrackActions } from './MediaActions'
import { PlayerStage } from './PlayerStage'
import { SpectrumVisualizer } from './SpectrumVisualizer'
import { TrackLoadingOverlay } from './TrackLoadingOverlay'
import { toggleTrackFavorite, useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore, useQueueUpNext } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { extractDominantColor, extractPalette } from '@renderer/utils/colorExtract'
import { formatFeatured, splitArtist } from '@renderer/utils/format'
import { shouldShowUpNextToast } from '@renderer/utils/upNextToast'

interface NowPlayingFullProps {
  onCollapse: () => void
}

// Fullscreen player: one listening-room stage with artwork and controls on the
// left, animated lyrics on the right, and an optional compact FFT strip.
export function NowPlayingFull({ onCollapse }: NowPlayingFullProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const album = useAlbumByUiId(track?.albumId)
  const upNext = useQueueUpNext()[0]
  const upNextAlbum = useAlbumByUiId(upNext?.albumId)
  const upNextToastStartSec = useTweakStore(s => s.tweak.upNextToastStartSec)
  const upNextToastEndSec = useTweakStore(s => s.tweak.upNextToastEndSec)
  const fullPlayerVisualizer = useTweakStore(s => s.tweak.fullPlayerVisualizer)
  const setTweak = useTweakStore(s => s.setTweak)
  const trackActions = useTrackActions()
  const artworkPath = track?.artworkPath ?? album?.artworkPath ?? null
  const [artworkTint, setArtworkTint] = useState<string | null>(null)
  const [artworkPalette, setArtworkPalette] = useState<string[] | null>(null)
  const [rightPanelMode, setRightPanelMode] = useState<'lyrics' | 'queue'>('lyrics')

  useEffect(() => {
    if (!artworkPath) {
      setArtworkTint(null)
      setArtworkPalette(null)
      return
    }
    let cancelled = false
    setArtworkTint(null)
    setArtworkPalette(null)
    const src = `crate://artwork/${encodeURIComponent(artworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled) setArtworkTint(hex)
    })
    void extractPalette(src, 3).then(palette => {
      if (!cancelled) setArtworkPalette(palette)
    })
    return () => { cancelled = true }
  }, [artworkPath])

  const tint = artworkTint ?? album?.palette[1] ?? null

  if (!track) return null

  const { primary: artistPrimary, featured: artistFeatured } = splitArtist(track.artist)
  const playing = status === 'playing'
  const remainingSec = Math.max(0, durationSec - positionSec)
  const queueVisible = rightPanelMode === 'queue'
  const showUpNext = !queueVisible && shouldShowUpNextToast({
    hasTrack: track != null,
    hasUpNext: upNext != null,
    status: playing ? 'playing' : status,
    durationSec,
    remainingSec,
    startSec: upNextToastStartSec,
    endSec: upNextToastEndSec,
  })
  const rootClasses = ['np-full', 'np-redesign'].join(' ')
  const artworkSource = album ?? {
    seed: track.dbId ?? 1,
    palette: ['#f1b3a6', '#b45b4f', '#2b1512'] as [string, string, string],
    pattern: 'half' as const,
    artworkPath: track.artworkPath,
  }

  const trackIdentity = (
    <div className="np-track-meta" key={track.id}>
      <h2>{track.t}</h2>
      <p>{artistPrimary}{track.albumTitle ? ` · ${track.albumTitle}` : ''}</p>
      {artistFeatured.length > 0 && <p className="np-feat">{formatFeatured(artistFeatured)}</p>}
      <div className="pp-quality-chip">
        <CodecStrip track={track} compact />
      </div>
    </div>
  )
  const canPersistTrack = track.dbId != null
  const toggleFavorite = () => {
    if (track.dbId == null) return
    void toggleTrackFavorite(track.dbId, !track.loved)
  }
  const artwork = (
    <div className="np-stage-art">
      <CrossfadeArtwork album={artworkSource} radius={0} objectFit="cover" />
      <div className="np-art-action-overlay">
        <button
          type="button"
          className={`np-action-btn${track.loved ? ' active' : ''}`}
          title={track.loved ? 'Remove from favorites' : 'Mark as favorite'}
          aria-pressed={track.loved}
          disabled={!canPersistTrack}
          onClick={toggleFavorite}
        >
          <Icon name={track.loved ? 'heartF' : 'heart'} size={15} />
        </button>
        <button
          type="button"
          className="np-action-btn"
          title="Agregar a playlist"
          disabled={!canPersistTrack}
          onClick={() => trackActions.openPlaylistPicker(track)}
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          type="button"
          className="np-action-btn"
          title="More actions"
          onClick={event => trackActions.openTrackMenu(event, track)}
        >
          <Icon name="ellipsis" size={15} />
        </button>
      </div>
      <TrackLoadingOverlay />
    </div>
  )

  const fallbackPalette = artworkSource.palette
  const pal0 = artworkPalette?.[0] ?? fallbackPalette[0]
  const pal1 = artworkPalette?.[1] ?? fallbackPalette[1]
  const pal2 = artworkPalette?.[2] ?? fallbackPalette[2]

  return (
    <div
      className={rootClasses}
      style={{
        '--np-tint': tint ?? 'transparent',
        '--np-pal-0': pal0,
        '--np-pal-1': pal1,
        '--np-pal-2': pal2,
      } as CSSProperties}
    >
      <div className="np-bg-canvas" aria-hidden="true">
        <div className="np-bg-blob np-bg-blob-a" />
        <div className="np-bg-blob np-bg-blob-b" />
        <div className="np-bg-blob np-bg-blob-c" />
        <div className="np-bg-blob np-bg-blob-d" />
      </div>
      <div className="np-stage-scrim" aria-hidden="true" />
      {fullPlayerVisualizer && (
        <div className="np-spectrum" aria-hidden="true">
          <SpectrumVisualizer mode="full" active={playing} />
        </div>
      )}

      <div className="np-full-head">
        <div className="np-head-spacer" />
        <div className="np-full-head-actions">
          <button
            className={`np-head-btn${fullPlayerVisualizer ? ' active' : ''}`}
            onClick={() => setTweak('fullPlayerVisualizer', !fullPlayerVisualizer)}
            title={fullPlayerVisualizer ? 'Ocultar visualizador' : 'Mostrar visualizador'}
            aria-pressed={fullPlayerVisualizer}
          >
            <Icon name="visualizer" size={15} />
          </button>
          <button
            className={`np-head-btn np-icon-swap-btn${queueVisible ? ' active showing-lyrics' : ''}`}
            onClick={() => setRightPanelMode(queueVisible ? 'lyrics' : 'queue')}
            title={queueVisible ? 'Mostrar letras' : 'Ver cola'}
            aria-pressed={queueVisible}
          >
            <span className="np-icon-swap" aria-hidden="true">
              <span className="np-icon-face face-queue"><Icon name="queue" size={15} /></span>
              <span className="np-icon-face face-lyrics"><Icon name="lyrics" size={15} /></span>
            </span>
          </button>
          <button className="np-head-btn" onClick={onCollapse} title="Close fullscreen">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      <div className="np-stage-center">
        <div className="np-layout np-layout-redesign">
          <section className="np-art-column" aria-label="Now playing">
            {artwork}
            {trackIdentity}
            <PlayerStage />
          </section>
          <section className="np-lyrics-stack" aria-label={queueVisible ? 'Cola' : 'Letras'}>
            {queueVisible ? (
              <FullScreenQueue />
            ) : (
              <div className="np-art-lyrics-side">
                <LyricsPanel variant="side" showActions={false} active focusedFlow focusLinesAfter={2} />
              </div>
            )}
          </section>
        </div>
      </div>

      {upNext && (
        <div className={`np-up-next-toast${showUpNext ? ' show' : ''}`} aria-hidden={!showUpNext}>
          <div className="art"><Artwork album={upNextAlbum} /></div>
          <div className="info">
            <div className="label">A continuación</div>
            <div className="t">{upNext.t}</div>
            <div className="a">{upNext.artist}</div>
          </div>
        </div>
      )}
      {trackActions.elements}
    </div>
  )
}
