import { Artwork } from './Artwork'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueUpNext } from '@renderer/stores/queueStore'

interface UpNextToastProps {
  variant: 'bottom' | 'side'
  enabled?: boolean
}

const BOTTOM_TOAST_START_SEC = 30
const SIDE_TOAST_START_SEC = 15
const SIDE_HIDE_LEAD_SEC = 3

export function UpNextToast({ variant, enabled = true }: UpNextToastProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const upNext = useQueueUpNext()[0]
  const upNextAlbum = useAlbumByUiId(upNext?.albumId)

  const remainingSec = durationSec > 0 ? durationSec - positionSec : 0

  if (variant === 'side') {
    if (!upNext) return null
    const show =
      enabled &&
      track != null &&
      status === 'playing' &&
      remainingSec <= SIDE_TOAST_START_SEC &&
      remainingSec > SIDE_HIDE_LEAD_SEC
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

  const show = enabled && track != null && status === 'playing' && upNext != null && remainingSec <= BOTTOM_TOAST_START_SEC && remainingSec >= 1

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
