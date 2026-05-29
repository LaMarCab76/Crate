import { Artwork } from './Artwork'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueUpNext } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { shouldShowUpNextToast } from '@renderer/utils/upNextToast'

interface UpNextToastProps {
  variant: 'bottom' | 'side'
  enabled?: boolean
}

export function UpNextToast({ variant, enabled = true }: UpNextToastProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const startSec = useTweakStore(s => s.tweak.upNextToastStartSec)
  const endSec = useTweakStore(s => s.tweak.upNextToastEndSec)
  const upNext = useQueueUpNext()[0]
  const upNextAlbum = useAlbumByUiId(upNext?.albumId)

  const remainingSec = durationSec > 0 ? durationSec - positionSec : 0
  const show = shouldShowUpNextToast({
    enabled,
    hasTrack: track != null,
    hasUpNext: upNext != null,
    status,
    durationSec,
    remainingSec,
    startSec,
    endSec,
  })

  if (variant === 'side') {
    if (!upNext) return null
    return (
      <div className={`up-next-inline${show ? ' show' : ''}`} aria-hidden={!show}>
        <div className="up-next-inline-row">
          <div className="art"><Artwork album={upNextAlbum} radius={6} /></div>
          <div className="info">
            <div className="label">A continuación</div>
            <div className="t">{upNext.t}</div>
            <div className="a">{upNext.artist}</div>
          </div>
        </div>
      </div>
    )
  }

  if (!show || !upNext) return null

  return (
    <div className={`up-next-toast up-next-toast-${variant}`} aria-hidden={!show}>
      <div className="art"><Artwork album={upNextAlbum} radius={6} /></div>
      <div className="info">
        <div className="label">A continuación</div>
        <div className="t">{upNext.t}</div>
        <div className="a">{upNext.artist}</div>
      </div>
    </div>
  )
}
