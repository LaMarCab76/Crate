import { Artwork } from './Artwork'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueUpNext } from '@renderer/stores/queueStore'

interface UpNextToastProps {
  variant: 'bottom' | 'side'
}

const NEXT_TOAST_SEC = 30

export function UpNextToast({ variant }: UpNextToastProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const upNext = useQueueUpNext()[0]
  const upNextAlbum = useAlbumByUiId(upNext?.albumId)

  const remainingSec = durationSec > 0 ? durationSec - positionSec : 0
  const show = track != null && status === 'playing' && upNext != null && remainingSec <= NEXT_TOAST_SEC && remainingSec >= 1

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
