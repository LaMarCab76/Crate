import { Artwork } from './Artwork'
import { Icon } from './Icon'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'

interface MiniPlayerProps {
  onClose: () => void
}

export function MiniPlayer({ onClose }: MiniPlayerProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const album = useAlbumByUiId(track?.albumId)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)

  if (!track) return null
  const playing = status === 'playing'

  return (
    <div className="mini-player">
      <div className="art"><Artwork album={album} radius={6} /></div>
      <div className="info">
        <div>
          <div className="t">{track.t}</div>
          <div className="a">{track.artist}</div>
        </div>
        <div className="ctl">
          <button onClick={onClose} title="Close mini-player" style={{ marginRight: 'auto', color: 'var(--text-tertiary)' }}>
            <Icon name="contract" size={13} />
          </button>
          <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={14} /></button>
          <button onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={16} />
          </button>
          <button title="Next" onClick={() => { void next() }}><Icon name="next" size={14} /></button>
        </div>
      </div>
    </div>
  )
}
