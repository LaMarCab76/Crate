import { type CSSProperties, useEffect, useState } from 'react'
import { Artwork } from './Artwork'
import { Icon } from './Icon'
import { LyricsPanel } from './LyricsPanel'
import { PlayerStage } from './PlayerStage'
import { SpectrumVisualizer } from './SpectrumVisualizer'
import { TrackMetaTable } from './TrackMetaTable'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueUpNext } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { extractDominantColor } from '@renderer/utils/colorExtract'

interface NowPlayingFullProps {
  onCollapse: () => void
}

type FullLyricsMode = 'off' | 'side' | 'screen'

// Show the "up next" toast once the current track is this close to finishing.
const NEXT_TOAST_SEC = 25

// Fullscreen player. A single fused stage with two looks toggled from the header:
// viz off = full-bleed artwork + transport overlay; viz on = a left column
// (artwork + title + file-data sheet) with the spectrum filling the right. The
// spectrum-on preference and the artwork tint are persisted settings.
export function NowPlayingFull({ onCollapse }: NowPlayingFullProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const album = useAlbumByUiId(track?.albumId)
  const upNext = useQueueUpNext()[0]
  const upNextAlbum = useAlbumByUiId(upNext?.albumId)
  const vizOn = useTweakStore(s => s.tweak.fullPlayerVisualizer)
  const fileDataVisible = useTweakStore(s => s.tweak.fullPlayerFileDataVisible)
  const setTweak = useTweakStore(s => s.setTweak)
  const playerTintSource = useTweakStore(s => s.tweak.playerTintSource)
  const playerTintColor = useTweakStore(s => s.tweak.playerTintColor)
  const artworkPath = track?.artworkPath ?? album?.artworkPath ?? null
  const [artworkTint, setArtworkTint] = useState<string | null>(null)
  const [drApprox, setDrApprox] = useState<number | null>(null)
  const [lyricsMode, setLyricsMode] = useState<FullLyricsMode>('off')
  const showVizLayout = vizOn && lyricsMode === 'off'

  useEffect(() => {
    if (playerTintSource !== 'artwork' || !artworkPath) {
      setArtworkTint(null)
      return
    }
    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(artworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled) setArtworkTint(hex)
    })
    return () => { cancelled = true }
  }, [playerTintSource, artworkPath])

  // The DR readout needs the (relatively heavy) waveform decode pass, so only
  // fetch it when the spec sheet is actually visible — the inline side column,
  // shown only in the visualizer layout — for the current track.
  const trackPath = track?.path ?? null
  const trackDbId = track?.dbId ?? null
  useEffect(() => {
    if (!showVizLayout || !fileDataVisible || !trackPath) {
      setDrApprox(null)
      return
    }
    let cancelled = false
    setDrApprox(null)
    void window.api.audio.getWaveform(trackPath, undefined, trackDbId)
      .then(res => { if (!cancelled) setDrApprox(res?.drApprox ?? null) })
      .catch(() => { if (!cancelled) setDrApprox(null) })
    return () => { cancelled = true }
  }, [showVizLayout, fileDataVisible, trackPath, trackDbId])

  const tint =
    playerTintSource === 'artwork' ? artworkTint
    : playerTintSource === 'preset' || playerTintSource === 'custom' ? playerTintColor
    : null

  if (!track) return null

  const playing = status === 'playing'
  const remainingSec = Math.max(0, durationSec - positionSec)
  const showUpNext = playing && upNext != null && durationSec > 0 && remainingSec <= NEXT_TOAST_SEC
  const stageSideMeta = (
    <div className="np-stage-side-meta">
      <h2>{track.t}</h2>
      <p>{track.artist}{track.albumTitle ? ` · ${track.albumTitle}` : ''}</p>
    </div>
  )
  const toggleLyricsMode = (mode: Exclude<FullLyricsMode, 'off'>) => {
    setLyricsMode(current => current === mode ? 'off' : mode)
    setTweak('fullPlayerVisualizer', false)
  }

  return (
    <div
      className={`np-full${showVizLayout ? ' viz-on' : ''}${lyricsMode === 'side' ? ' lyrics-side' : ''}${lyricsMode === 'screen' ? ' lyrics-screen' : ''}`}
      style={{ '--np-tint': tint ?? 'transparent' } as CSSProperties}
    >
      <div className="np-stage-art"><Artwork album={album} radius={0} objectFit="cover" /></div>
      <div className="np-stage-scrim" aria-hidden="true" />

      <div className="np-full-head">
        <div className="np-head-spacer" />
        <div className="np-full-head-actions">
          <button
            className={`np-head-btn${lyricsMode === 'side' ? ' active' : ''}`}
            onClick={() => toggleLyricsMode('side')}
            title="Lyrics side view"
            aria-pressed={lyricsMode === 'side'}
          >
            <Icon name="sidebarRight" size={15} />
          </button>
          <button
            className={`np-head-btn${lyricsMode === 'screen' ? ' active' : ''}`}
            onClick={() => toggleLyricsMode('screen')}
            title="Lyrics screen view"
            aria-pressed={lyricsMode === 'screen'}
          >
            <Icon name="lyrics" size={15} />
          </button>
          <button
            className={`np-head-btn${showVizLayout ? ' active' : ''}`}
            onClick={() => {
              setLyricsMode('off')
              setTweak('fullPlayerVisualizer', !vizOn)
            }}
            title={vizOn ? 'Hide visualizer' : 'Show visualizer'}
            aria-pressed={showVizLayout}
          >
            <Icon name="visualizer" size={15} />
          </button>
          <button
            className={`np-head-btn${fileDataVisible ? ' active' : ''}`}
            onClick={() => setTweak('fullPlayerFileDataVisible', !fileDataVisible)}
            title={fileDataVisible ? 'Hide file data' : 'Show file data'}
            aria-pressed={fileDataVisible}
          >
            <Icon name="info" size={15} />
          </button>
          <button className="np-head-btn" onClick={onCollapse} title="Close fullscreen">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      <div className="np-stage-center">
        {showVizLayout ? (
          <>
            <div className="np-stage-side">
              {/* Empty placeholder reserving the artwork's square; the morphing
                  .np-stage-art lands here (both share --np-art-size / pads). */}
              <div className="np-stage-cover-slot" aria-hidden="true" />
              {stageSideMeta}
              {fileDataVisible && <TrackMetaTable track={track} drApprox={drApprox} />}
            </div>
            <div className="np-spectrum-band" aria-hidden="true">
              <SpectrumVisualizer mode="full" />
            </div>
          </>
        ) : lyricsMode === 'side' ? (
          <>
            <div className="np-stage-side np-stage-side-lyrics">
              <div className="np-stage-cover-slot" aria-hidden="true" />
              {stageSideMeta}
            </div>
            <div className="np-art-lyrics-side">
              <LyricsPanel variant="side" showActions={false} />
            </div>
          </>
        ) : null}
      </div>

      {lyricsMode === 'screen' && (
        <div className="np-subtitle-lyrics">
          <LyricsPanel variant="subtitle" showActions={false} />
        </div>
      )}

      <PlayerStage track={track} showTitle={!showVizLayout && lyricsMode === 'off'} />

      {upNext && (
        <div className={`np-up-next-toast${showUpNext ? ' show' : ''}`} aria-hidden={!showUpNext}>
          <div className="art"><Artwork album={upNextAlbum} radius={6} /></div>
          <div className="info">
            <div className="label">A continuación</div>
            <div className="t">{upNext.t}</div>
            <div className="a">{upNext.artist}</div>
          </div>
        </div>
      )}
    </div>
  )
}
