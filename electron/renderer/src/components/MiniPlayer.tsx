import type { Track } from '@shared/types/library'
import { Artwork } from './Artwork'
import { Icon } from './Icon'
import { mockLibrary } from '@renderer/data/mockLibrary'

interface MiniPlayerProps {
  track: Track
  playing: boolean
  onPlayPause: () => void
  onClose: () => void
}

export function MiniPlayer({ track, playing, onPlayPause, onClose }: MiniPlayerProps) {
  if (!track) return null
  const album = mockLibrary.albums.find(a => a.id === track.albumId)
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
          <button title="Previous"><Icon name="prev" size={14} /></button>
          <button onClick={onPlayPause} title={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={16} />
          </button>
          <button title="Next"><Icon name="next" size={14} /></button>
        </div>
      </div>
    </div>
  )
}
