import { type CSSProperties, useEffect, useState } from 'react'
import { AmbientView } from './AmbientView'
import { Artwork } from './Artwork'
import { Icon } from './Icon'
import { StudioView } from './StudioView'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueUpNext } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { extractDominantColor } from '@renderer/utils/colorExtract'

interface NowPlayingFullProps {
  onCollapse: () => void
}

// Show the "up next" toast once the current track is this close to finishing.
const NEXT_TOAST_SEC = 25

// Fullscreen player shell. Owns the shared chrome (drag region, close button,
// artwork tint, up-next toast) and switches between the Studio and Ambient
// layouts. The active mode is a persisted player preference, not app nav state.
export function NowPlayingFull({ onCollapse }: NowPlayingFullProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const album = useAlbumByUiId(track?.albumId)
  const upNext = useQueueUpNext()[0]
  const upNextAlbum = useAlbumByUiId(upNext?.albumId)
  const mode = useTweakStore(s => s.tweak.fullPlayerMode)
  const setTweak = useTweakStore(s => s.setTweak)
  const playerTintSource = useTweakStore(s => s.tweak.playerTintSource)
  const playerTintColor = useTweakStore(s => s.tweak.playerTintColor)
  const artworkPath = track?.artworkPath ?? album?.artworkPath ?? null
  const [artworkTint, setArtworkTint] = useState<string | null>(null)

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

  const tint =
    playerTintSource === 'artwork' ? artworkTint
    : playerTintSource === 'preset' || playerTintSource === 'custom' ? playerTintColor
    : null

  if (!track) return null

  const playing = status === 'playing'
  const remainingSec = Math.max(0, durationSec - positionSec)
  const showUpNext = playing && upNext != null && durationSec > 0 && remainingSec <= NEXT_TOAST_SEC
  const toggleMode = () => setTweak('fullPlayerMode', mode === 'studio' ? 'ambient' : 'studio')

  return (
    <div className={`np-full mode-${mode}`} style={{ '--np-tint': tint ?? 'transparent' } as CSSProperties}>
      <div className="np-full-head">
        {mode === 'studio' && (
          <div className="np-live">
            <span className="np-live-dot" aria-hidden="true" />
            <span className="np-live-label">LIVE</span>
            <span className="np-live-track">{track.t} — {track.artist}</span>
          </div>
        )}
        <div className="np-head-spacer" />
        <button className="np-full-close" onClick={onCollapse} title="Close fullscreen">
          <Icon name="close" size={14} />
        </button>
      </div>

      {mode === 'studio'
        ? <StudioView track={track} album={album} onToggleMode={toggleMode} />
        : <AmbientView track={track} album={album} onToggleMode={toggleMode} />}

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
